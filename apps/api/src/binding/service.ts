import { FINANCIAL_EVENT_TYPES, renderPartnerLink, type AdminUser, type BindingState, type BotConfig, type ManagerPermission, type PartnerSource } from '@open-signal/shared';
import { AppError, type ErrorCode } from '../lib/errors.ts';
import { sha256Hex, type SecretBox } from '../lib/crypto.ts';
import { CLICK_ID_PATTERN, newClickId, normalizeClickId } from '../lib/ids.ts';
import type { Logger } from '../lib/logger.ts';
import { C } from '../storage/collections.ts';
import { increment, type DocumentStore, type StoredDoc, type Transaction } from '../storage/types.ts';
import { writeAudit, type AuditActor } from '../domain/audit.ts';
import type { BotRepository } from '../domain/bots.ts';
import type { ErrorLog, StatsBuffer } from '../domain/observability.ts';
import type { DepositSummary, ManualAccess, UserRecord } from '../domain/records.ts';
import { TenantScope } from '../domain/tenant.ts';
import { assertTransition } from './state-machine.ts';
import { randomBytes } from 'node:crypto';
import { SIMILAR_WINDOW_MS, authenticateSource, collectParams, normalizeEvent, postbackEventDocId, type PostbackRequest } from './postback.ts';

// ───────── stored records ─────────

export interface ClickTokenRecord {
  [k: string]: unknown;
  botId: string;
  userDocId: string;
  createdAt: string;
  expiresAt: string;
  /** Partner id configured for the bot when the link was opened (if any). */
  partnerId?: string | null;
  lastClickAt?: string | null;
  clicks?: number;
}

export type MatchStatus = 'unmatched' | 'matched' | 'awaiting_confirmation' | 'conflict' | 'review';

export interface PostbackEventRecord {
  [k: string]: unknown;
  botId: string;
  sourceId: string;
  eventType: string;
  rawEventType: string;
  partnerEventId: string | null;
  traderIdNorm: string;
  traderIdHash: string;
  clickId: string | null;
  occurredAt: string | null;
  amount?: number | null;
  currency?: string | null;
  partnerId?: string | null;
  /** Event received by the global (all-bots) source. */
  globalSource?: boolean;
  /** Owner of the click_id carried by the event (same bot only), if any. */
  clickUserDocId?: string | null;
  /**
   * Set for repeat deposits without a natural key (source + type + Trader ID + amount + currency).
   * Used only to find a similar earlier delivery and flag this one; it never drops an event.
   */
  windowKey?: string | null;
  /** An earlier event with the same windowKey arrived within SIMILAR_WINDOW_MS: it may be a re-delivery. */
  possibleDuplicateOf?: string | null;
  /** An admin excluded this event from the deposit totals (with reason, audited). */
  excluded?: { by: string; at: string; reason: string } | null;
  /** A re-delivery carried a different amount/currency; the first value was kept. */
  conflictingDelivery?: { amount: number | null; currency: string | null; at: string } | null;
  /**
   * How the event found its bot and user: by a valid click_id, by the unique binding of its
   * Trader ID (deposits only, when the click_id is missing / unknown / expired), or by a
   * per-bot source. Absent on events stored before this field existed.
   */
  routedBy?: 'click_id' | 'trader_id' | 'source' | null;
  /** Why the event was or was not credited — shown in the admin postback history. */
  diagnosis?: PostbackDiagnosis | null;
  receivedAt: string;
  lastDeliveryAt: string;
  deliveryCount: number;
  matchStatus: MatchStatus;
  matchedUserDocId: string | null;
}

/** Admin-facing outcome of one postback event (no secrets, no full Trader ID). */
export type PostbackDiagnosis =
  | 'matched_click' // credited / linked via a valid click_id
  | 'matched_trader_id' // deposit credited via the unique binding of its Trader ID
  | 'registration_awaiting' // registration stored, the user has not entered this Trader ID yet
  | 'deposit_unmatched' // deposit stored with a valid click_id, Trader ID not linked yet (credited after linking)
  | 'click_missing'
  | 'click_not_found'
  | 'click_expired'
  | 'click_other_user' // the click_id belongs to another user or bot: never credited
  | 'trader_not_bound' // no click to route by and the Trader ID is not linked to anyone
  | 'trader_ambiguous' // the Trader ID is linked in several bots: not credited automatically
  | 'registration_unclaimed' // registration without our click_id: waits for the first user who enters this Trader ID
  | 'matched_pending'; // deposit that waited (Pending) for the Trader ID binding and was credited after it

export type ClaimStatus = 'pending' | 'matched' | 'conflict' | 'review' | 'rejected';

export interface ClaimRecord {
  [k: string]: unknown;
  botId: string;
  userDocId: string;
  traderIdNorm: string;
  traderIdHash: string;
  status: ClaimStatus;
  createdAt: string;
  updatedAt: string;
}

export interface TraderBindingRecord {
  [k: string]: unknown;
  botId: string;
  traderIdNorm: string;
  userDocId: string;
  method: 'click_id' | 'trader_id' | 'admin';
  eventDocId: string | null;
  boundAt: string;
  boundBy: string;
}

export interface BindingView {
  enabled: boolean;
  state: BindingState;
  traderIdMasked: string | null;
  /** Reason of the last failed "Link account" attempt, if the account is still unlinked. */
  lastError: string | null;
  showSupport: boolean;
  supportContact: string;
}

export interface BindingResult {
  view: BindingView;
  /** Business outcome that is not a state change (state is still saved). */
  error?: ErrorCode;
  retryAfterSec?: number;
}

export interface AdminActor {
  uid: string;
  role: AdminUser['role'];
  botPermissions: AdminUser['botPermissions'];
}

/** partner_sources.botId of the single source shared by every bot. */
export const GLOBAL_SOURCE_BOT_ID = '*';
/** Error-log bucket for integration errors that belong to no bot. */
export const GLOBAL_LOG_BOT_ID = 'global';
const CLICK_TTL_MS = 90 * 24 * 3600 * 1000;
/** Shape check used to look a Trader ID up before its bot is known (each bot then applies its own pattern). */
const ROUTING_TRADER_ID = /^[A-Za-z0-9_.:-]{1,64}$/;
/** Diagnoses that mean "not credited": each one is also written to "Integration errors" (no secrets, masked Trader ID). */
const DIAGNOSIS_ERROR: Partial<Record<PostbackDiagnosis, string>> = {
  click_other_user: 'CLICK_OTHER_USER',
  trader_not_bound: 'TRADER_NOT_BOUND',
  trader_ambiguous: 'TRADER_AMBIGUOUS',
  deposit_unmatched: 'DEPOSIT_UNMATCHED',
  click_missing: 'CLICK_MISSING',
  click_not_found: 'CLICK_NOT_FOUND',
  click_expired: 'CLICK_EXPIRED',
};

export function normalizeTraderId(raw: string): string {
  return raw.trim().toLowerCase();
}

export function maskTraderId(id: string): string {
  return id.length <= 4 ? '••••' : `••••${id.slice(-4)}`;
}

const hashTid = (tid: string) => sha256Hex(tid);
const lockId = (scope: TenantScope, tid: string) => `${scope.botId}_${hashTid(tid).slice(0, 40)}`;
const claimId = (userDocId: string, tid: string) => `${userDocId}__${hashTid(tid).slice(0, 24)}`;

export interface BindingDeps {
  store: DocumentStore;
  bots: BotRepository;
  box: SecretBox;
  logger: Logger;
  stats: StatsBuffer;
  errors: ErrorLog;
  now: () => Date;
  /** Platform setting "accept registrations without our click_id" (Hidden Dinox Academy rule). Default: on. */
  clicklessRegistration?: () => Promise<boolean>;
}

/**
 * Account Binding: links a verified Telegram ID to an external Trader ID.
 *
 * Invariants (enforced with transactional uniqueness locks):
 *  - one Trader ID ↔ at most one Telegram ID per bot (trader_bindings doc id = hash of Trader ID);
 *  - one Telegram ID ↔ at most one Trader ID (users.traderId is write-once for the user);
 *  - an event that arrived via another user's click_id never binds this user;
 *  - two users claiming the same Trader ID without click_id → nobody gets it automatically (manual_review);
 *  - re-binding only through an administrator, always with an audit record.
 */
export class BindingService {
  private readonly d: BindingDeps;

  constructor(deps: BindingDeps) {
    this.d = deps;
  }

  /** Onboarding with Trader ID verification is mandatory for every bot. */
  isEnabled(_config?: unknown): boolean {
    return true;
  }

  view(user: UserRecord, config: BotConfig): BindingView {
    return {
      enabled: true,
      state: user.bindingState,
      traderIdMasked: user.traderId ? maskTraderId(user.traderId) : (user.submittedTraderIdMasked ?? null),
      lastError: user.traderId ? null : (user.lastBindingError?.code ?? null),
      showSupport: user.bindingState === 'binding_conflict' || user.bindingState === 'manual_review',
      supportContact: config.supportContact,
    };
  }

  /** telegram_created → waiting_for_trader_id on the first launch. */
  async ensureInitialState(scope: TenantScope, _config: BotConfig, user: UserRecord): Promise<UserRecord> {
    if (user.bindingState !== 'telegram_created') return user;
    const now = this.d.now().toISOString();
    assertTransition('telegram_created', 'waiting_for_trader_id');
    await this.d.store.update(C.users, scope.userDocId(user.telegramId), { bindingState: 'waiting_for_trader_id', bindingUpdatedAt: now });
    return { ...user, bindingState: 'waiting_for_trader_id', bindingUpdatedAt: now };
  }

  /**
   * Onboarding step 1: the user taps "Register". Issues (or reuses) the personal
   * click_id, renders THIS bot's current partner link with it, counts the click
   * and remembers that registration was started. The link is rendered on every
   * click from the current settings, so a changed link applies to new clicks
   * immediately while existing bindings stay untouched.
   */
  async startRegistration(scope: TenantScope, config: BotConfig, telegramId: number): Promise<{ clickId: string; partnerLink: string }> {
    if (!config.partner.linkTemplate) throw new AppError('PARTNER_LINK_MISSING');
    const r = await this.issueClickId(scope, config, telegramId);
    const now = this.d.now().toISOString();
    await this.d.store.update(C.clickTokens, r.clickId, { lastClickAt: now, clicks: increment(1), partnerId: config.partner.partnerId });
    const uid = scope.userDocId(telegramId);
    const user = await this.d.store.get<UserRecord>(C.users, uid);
    if (user && !user.registrationStartedAt) await this.d.store.update(C.users, uid, { registrationStartedAt: now });
    this.d.stats.incr(scope.botId, 'partner_clicks');
    return { clickId: r.clickId, partnerLink: r.partnerLink! };
  }

  /** Personal click_id (128 random bits) for the partner link; reused while valid. */
  async issueClickId(scope: TenantScope, config: BotConfig, telegramId: number): Promise<{ clickId: string; partnerLink: string | null }> {
    const userDocId = scope.userDocId(telegramId);
    const now = this.d.now();
    const existing = await this.d.store.query<ClickTokenRecord>(C.clickTokens, {
      where: scope.where({ field: 'userDocId', op: '==', value: userDocId }, { field: 'expiresAt', op: '>', value: now.toISOString() }),
      limit: 1,
    });
    let clickId = existing[0]?.id;
    if (!clickId) {
      clickId = newClickId();
      await this.d.store.create(
        C.clickTokens,
        clickId,
        scope.stamp({
          userDocId,
          createdAt: now.toISOString(),
          expiresAt: new Date(now.getTime() + CLICK_TTL_MS).toISOString(),
          partnerId: config.partner.partnerId,
          lastClickAt: null,
          clicks: 0,
        }),
      );
    }
    const tpl = config.partner.linkTemplate;
    return { clickId, partnerLink: tpl ? renderPartnerLink(tpl, { clickId, botId: scope.botId, partnerId: config.partner.partnerId }) : null };
  }

  // ───────── user actions ─────────

  /**
   * Step 2 — "Link account". The Trader ID is linked ONLY when all of this holds:
   *  1. the format matches the bot's Trader ID pattern;
   *  2. a registration postback for this Trader ID is stored for THIS bot;
   *  3. that registration arrived with a click_id issued to THIS Telegram user;
   *  4. the Trader ID is not linked to anybody else (transactional lock).
   * A format match alone never links anything, and nothing is invented: a failed
   * check returns a reason and leaves the account unlinked.
   */
  async submitTraderId(scope: TenantScope, config: BotConfig, telegramId: number, raw: string): Promise<BindingResult> {
    const tid = normalizeTraderId(raw);
    if (!traderPattern(config).test(tid)) throw new AppError('TRADER_ID_INVALID');
    const uid = scope.userDocId(telegramId);
    const tHash = hashTid(tid);
    const nowIso = this.d.now().toISOString();

    const clickless = await this.clicklessAllowed();
    const result = await this.d.store.runTransaction(async (tx): Promise<BindingResult> => {
      // ── reads ──
      const user = await tx.get<UserRecord>(C.users, uid);
      if (!user || !scope.owns(user)) throw new AppError('UNAUTHORIZED');
      const lock = await tx.get<TraderBindingRecord>(C.traderBindings, lockId(scope, tid));
      const events = await tx.query<PostbackEventRecord>(C.postbackEvents, {
        where: scope.where({ field: 'traderIdHash', op: '==', value: tHash }, { field: 'eventType', op: '==', value: 'registration' }),
        orderBy: { field: 'receivedAt', direction: 'asc' },
        limit: 20,
      });
      const clicks = await Promise.all(events.map((e) => (e.data.clickId ? tx.get<ClickTokenRecord>(C.clickTokens, e.data.clickId) : Promise.resolve(null))));
      const myClaim = await tx.get<ClaimRecord>(C.bindingClaims, claimId(uid, tid));
      // Academy rule: registrations of the global source that came without our click_id, and every
      // other bot's binding of this Trader ID (one account per Trader ID across the platform).
      const globalRegs = clickless
        ? (await tx.query<PostbackEventRecord>(C.postbackEvents, { where: [{ field: 'traderIdHash', op: '==', value: tHash }], limit: 50 }))
            .filter((e) => e.data.botId === GLOBAL_LOG_BOT_ID && e.data.eventType === 'registration' && e.data.diagnosis === 'registration_unclaimed')
        : [];
      const otherLocks = clickless
        ? (await tx.query<TraderBindingRecord>(C.traderBindings, { where: [{ field: 'traderIdNorm', op: '==', value: tid }], limit: 20 })).filter((l) => l.data.botId !== scope.botId)
        : [];
      const pending = await this.readPendingDeposits(tx, scope.botId, tHash);

      // ── decisions & writes ──
      const finish = (u: UserRecord, error?: ErrorCode): BindingResult => ({ view: this.view(u, config), ...(error ? { error } : {}) });
      const fail = (code: 'REGISTRATION_NOT_CONFIRMED' | 'CLICK_MISMATCH' | 'TRADER_ID_TAKEN'): BindingResult => {
        const patch = { lastBindingError: { code, at: nowIso }, bindingAttempts: (user.bindingAttempts ?? 0) + 1, submittedTraderIdMasked: maskTraderId(tid) };
        tx.update(C.users, uid, patch);
        return finish({ ...user, ...patch }, code);
      };

      if (user.traderId) {
        if (user.traderId === tid) return finish(user);
        throw new AppError('TRADER_ID_CHANGE_FORBIDDEN');
      }
      if (user.bindingState === 'manual_review' || user.bindingState === 'binding_conflict') return finish(user);

      if (lock) {
        if (lock.userDocId === uid) return finish(this.setUser(tx, user, uid, 'account_bound', nowIso, { traderId: tid, lastBindingError: null })); // self-heal
        return fail('TRADER_ID_TAKEN');
      }
      const claimDoc = myClaim ? { id: claimId(uid, tid), data: myClaim } : null;

      // Who registered: our click_id (valid or expired) names the owner; no click of ours = owner unknown.
      const ownerOf = (i: number): string | null => {
        const c = clicks[i];
        return events[i]!.data.clickId && c && scope.owns(c) ? c.userDocId : null;
      };
      // 1) A registration made through THIS user's personal link.
      const mine = events.findIndex((_, i) => ownerOf(i) === uid);
      if (mine >= 0) {
        const bound = this.bind(tx, scope, user, uid, tid, tHash, claimDoc, 'click_id', events[mine]!.id, nowIso, 'system');
        this.promotePending(tx, scope, uid, pending, nowIso, 'system');
        return finish(bound);
      }
      // 2) Registered through another user's link: never linked to this user.
      if (events.some((_, i) => ownerOf(i) !== null)) return fail('CLICK_MISMATCH');
      // 3) Registration without our click_id (Academy rule): the first user who enters it, if nobody else holds it.
      const unknown = clickless ? [...events.filter((_, i) => ownerOf(i) === null), ...globalRegs] : [];
      if (unknown.length > 0) {
        if (otherLocks.length > 0) return fail('TRADER_ID_TAKEN');
        const inBot = unknown.find((e) => e.data.botId === scope.botId) ?? null;
        const bound = this.bind(tx, scope, user, uid, tid, tHash, claimDoc, 'trader_id', inBot?.id ?? null, nowIso, 'system');
        if (!inBot) {
          const g = unknown[0]!;
          tx.update(C.postbackEvents, g.id, { botId: scope.botId, matchStatus: 'matched', matchedUserDocId: uid, routedBy: 'trader_id', diagnosis: 'matched_trader_id', promotedAt: nowIso, promotedFromBotId: g.data.botId });
        }
        this.promotePending(tx, scope, uid, pending, nowIso, 'system');
        return finish(bound);
      }
      if (events.length > 0) return fail('CLICK_MISMATCH'); // Academy rule off: a registration without our click_id is not enough
      if (otherLocks.length > 0) return fail('TRADER_ID_TAKEN'); // linked to an account in another bot

      // Not confirmed yet: remember the claim, so a registration postback that arrives later
      // (with this user's click_id, or without any click_id) links the account automatically.
      this.upsertClaim(tx, scope, claimDoc, uid, tid, tHash, 'pending', nowIso);
      return fail('REGISTRATION_NOT_CONFIRMED');
    });
    this.d.stats.incr(scope.botId, result.error ? 'binding_failed' : 'binding_checked');
    return result;
  }

  /** "Try again": back to step 1. Telegram ID, click_id, claims and the last error are kept. */
  async restartOnboarding(scope: TenantScope, telegramId: number): Promise<void> {
    const uid = scope.userDocId(telegramId);
    await this.d.store.runTransaction(async (tx) => {
      const user = await tx.get<UserRecord>(C.users, uid);
      if (!user || !scope.owns(user)) throw new AppError('UNAUTHORIZED');
      if (user.traderId) return; // already linked: nothing to restart
      tx.update(C.users, uid, { traderIdSubmitStartedAt: null });
    });
  }

  // ───────── postback ─────────

  /**
   * `/postback?key=…` without a source ID in the path (the URL form used in the Pocket Partners
   * cabinet). The key must match exactly one enabled global source; the event is then processed
   * exactly like `/postback/<sourceId>?key=…`. The key itself is never logged.
   */
  async processPostbackByKey(req: PostbackRequest): Promise<{ status: number; body: { ok: true; duplicate: boolean } }> {
    const sources = (await this.d.store.query<PartnerSource & Record<string, unknown>>(C.partnerSources, {
      where: [{ field: 'botId', op: '==', value: GLOBAL_SOURCE_BOT_ID }],
      limit: 20,
    })).filter((src) => src.data.enabled);
    const matching = sources.filter((src) => {
      try {
        authenticateSource(src.data, req, this.d.box);
        return true;
      } catch {
        return false;
      }
    });
    if (matching.length !== 1) {
      await this.d.errors.record(GLOBAL_LOG_BOT_ID, 'postback', 'UNAUTHORIZED', sources.length === 0
        ? 'postback without source ID: no enabled global source'
        : 'postback without source ID: the key matches no enabled global source');
      throw new AppError('UNAUTHORIZED', 'unknown postback key');
    }
    return this.processPostback(matching[0]!.id, req);
  }

  async processPostback(sourceId: string, req: PostbackRequest): Promise<{ status: number; body: { ok: true; duplicate: boolean } }> {
    if (!/^[a-z0-9-]{3,40}$/.test(sourceId)) throw new AppError('NOT_FOUND');
    const source = await this.d.store.get<PartnerSource & Record<string, unknown>>(C.partnerSources, sourceId);
    if (!source) throw new AppError('NOT_FOUND');
    if (!source.enabled) throw new AppError('FORBIDDEN', 'source disabled');
    const isGlobal = source.botId === GLOBAL_SOURCE_BOT_ID;
    const logBot = isGlobal ? GLOBAL_LOG_BOT_ID : source.botId;

    try {
      authenticateSource(source, req, this.d.box);
    } catch (e) {
      await this.d.errors.record(logBot, 'postback', 'UNAUTHORIZED', `postback auth failed for source ${sourceId}`);
      throw e;
    }

    const params = collectParams(req);
    const nowIso = this.d.now().toISOString();
    const route = await this.routePostback(source, sourceId, params, nowIso);
    const targetBotId = route.botId;
    // Unrouted deposits (no usable click, Trader ID not linked or linked in several bots) are
    // kept for the admin history under the "global" bucket and are never credited.
    const bundle = targetBotId === GLOBAL_LOG_BOT_ID ? null : await this.d.bots.find(targetBotId);
    if (targetBotId !== GLOBAL_LOG_BOT_ID && !bundle) throw new AppError('NOT_FOUND');

    let ev: ReturnType<typeof normalizeEvent>;
    try {
      ev = normalizeEvent(source, params, bundle ? traderPattern(bundle.config) : ROUTING_TRADER_ID);
    } catch (e) {
      await this.d.errors.record(isGlobal && !bundle ? logBot : targetBotId, 'postback', 'BAD_EVENT', `source ${sourceId}: ${e instanceof Error ? e.message : 'invalid event'}`);
      throw e;
    }
    const scope = new TenantScope(targetBotId);
    const tid = normalizeTraderId(ev.traderIdNorm);
    const tHash = hashTid(tid);
    const windowKey = ev.noNaturalKey ? `${sourceId}:${ev.similarKey}` : null;
    // Without a natural key every delivery gets its own document: a real repeat deposit is never lost.
    // Registration and FTD are one per Trader ID AND owner: a re-delivery merges, but the same Trader ID
    // reported for another person (another user's click_id) is a separate event that goes to review —
    // it can never take the place of the real owner's registration or first deposit.
    const keyOwner = ev.eventType === 'registration' ? route.ownerDocId ?? '-' : ev.eventType === 'ftd' ? (route.by === 'click_id' ? route.clickOwnerDocId : route.userDocId) ?? '-' : null;
    const docId = postbackEventDocId(sourceId, `${targetBotId}:${ev.eventKey}${keyOwner ? `:${keyOwner}` : ''}${ev.noNaturalKey ? `:${this.d.now().getTime()}:${randomBytes(6).toString('hex')}` : ''}`);
    const isFinancial = (FINANCIAL_EVENT_TYPES as readonly string[]).includes(ev.eventType);
    // Read before the transaction: no store calls outside the transaction while it runs.
    const clicklessSetting = ev.eventType === 'registration' ? await this.clicklessAllowed() : false;

    const outcome = await this.d.store.runTransaction(async (tx): Promise<{ duplicate: boolean; conflict: boolean; possibleDuplicateOf: string | null; matchedUser: string | null; diagnosis: PostbackDiagnosis | null }> => {
      // ── reads ──
      let existing: StoredDoc<PostbackEventRecord> | null = null;
      let similar: StoredDoc<PostbackEventRecord> | null = null;
      if (windowKey) {
        const recent = await tx.query<PostbackEventRecord>(C.postbackEvents, {
          where: scope.where({ field: 'windowKey', op: '==', value: windowKey }, { field: 'receivedAt', op: '>=', value: new Date(this.d.now().getTime() - SIMILAR_WINDOW_MS).toISOString() }),
          limit: 1,
        });
        similar = recent[0] ?? null;
      } else {
        const doc = await tx.get<PostbackEventRecord>(C.postbackEvents, docId);
        existing = doc ? { id: docId, data: doc } : null;
      }
      if (existing) {
        // Re-delivery: counted once. A different amount/currency never overwrites the stored one.
        const prev = existing.data;
        const conflict = isFinancial && ((ev.amount ?? null) !== (prev.amount ?? null) || (ev.currency ?? null) !== (prev.currency ?? null));
        const holder = conflict && prev.matchedUserDocId ? await tx.get<UserRecord>(C.users, prev.matchedUserDocId) : null;
        tx.update(C.postbackEvents, existing.id, {
          deliveryCount: increment(1),
          lastDeliveryAt: nowIso,
          ...(conflict ? { conflictingDelivery: { amount: ev.amount, currency: ev.currency, at: nowIso } } : {}),
        });
        if (conflict) {
          if (holder?.deposit) tx.update(C.users, prev.matchedUserDocId!, { deposit: { ...holder.deposit, conflict: true, updatedAt: nowIso } });
          writeAudit(tx, {
            botId: scope.botId, actor: { type: 'system', id: `postback:${sourceId}` }, action: 'finance.amount_conflict', target: existing.id,
            before: { amount: prev.amount ?? null, currency: prev.currency ?? null }, after: { amount: ev.amount, currency: ev.currency },
          }, this.d.now());
        }
        return { duplicate: true, conflict, possibleDuplicateOf: null, matchedUser: prev.matchedUserDocId, diagnosis: null };
      }
      const possibleDuplicateOf = similar?.id ?? null;
      const lock = await tx.get<TraderBindingRecord>(C.traderBindings, lockId(scope, tid));
      let clickTok: ClickTokenRecord | null = null;
      if (ev.clickId) {
        const t = await tx.get<ClickTokenRecord>(C.clickTokens, ev.clickId);
        clickTok = t && scope.owns(t) && t.expiresAt > nowIso ? t : null; // a click_id of another bot is ignored
      }
      const lockUser = lock && isFinancial ? await tx.get<UserRecord>(C.users, lock.userDocId) : null;
      // Registration: who registered (our click_id — valid or expired —, the single pending claim, or the binding).
      const regOwner = ev.eventType === 'registration' && !lock ? (route.ownerDocId ?? null) : null;
      const ownerUser = regOwner ? await tx.get<UserRecord>(C.users, regOwner) : null;
      const ownerClaim = regOwner ? await tx.get<ClaimRecord>(C.bindingClaims, claimId(regOwner, tid)) : null;
      const pending = regOwner && ownerClaim?.status === 'pending' ? await this.readPendingDeposits(tx, scope.botId, tHash) : [];
      const clickless = ev.eventType === 'registration' && !regOwner && !lock && !route.diagnosis && clicklessSetting;

      // ── writes ──
      const clickUserDocId = clickTok?.userDocId ?? null;
      const record: PostbackEventRecord = scope.stamp({
        sourceId,
        globalSource: isGlobal,
        eventType: ev.eventType,
        rawEventType: ev.rawEventType,
        partnerEventId: ev.partnerEventId,
        traderIdNorm: tid,
        traderIdHash: tHash,
        clickId: ev.clickId,
        clickUserDocId,
        windowKey,
        possibleDuplicateOf,
        // Possible re-delivery (same Trader ID, type and amount within 10 minutes, no event id from the
        // partner): kept but NOT counted until an admin confirms it is a separate deposit (Academy rule).
        excluded: possibleDuplicateOf ? { by: 'system', at: nowIso, reason: 'possible_repeat' } : null,
        occurredAt: ev.occurredAt,
        amount: ev.amount,
        currency: ev.currency,
        partnerId: ev.partnerId,
        receivedAt: nowIso,
        lastDeliveryAt: nowIso,
        deliveryCount: 1,
        matchStatus: 'unmatched' as MatchStatus,
        matchedUserDocId: null,
        routedBy: route.by,
        diagnosis: null,
      });
      const save = (matchStatus: MatchStatus, matchedUserDocId: string | null, diagnosis: PostbackDiagnosis) =>
        tx.create(C.postbackEvents, docId, { ...record, matchStatus, matchedUserDocId, diagnosis });

      if (ev.eventType !== 'registration') {
        // Deposits never change the binding. They belong to the user who holds the Trader ID:
        //  - routed by a valid click_id → only if that click belongs to the holder;
        //  - routed by the Trader ID (no usable click) → the holder found during routing, re-checked here;
        //  - a forced diagnosis from routing (other user's click, ambiguous / unlinked Trader ID) → never credited.
        let owner: string | null = null;
        let diagnosis: PostbackDiagnosis;
        if (route.diagnosis) diagnosis = route.diagnosis;
        else if (route.by === 'trader_id') {
          owner = lock && lock.userDocId === route.userDocId ? lock.userDocId : null;
          diagnosis = owner ? 'matched_trader_id' : 'trader_not_bound';
        } else {
          owner = lock && attributable(record, lock.userDocId) ? lock.userDocId : null;
          diagnosis = owner ? 'matched_click' : lock || route.boundElsewhere ? 'click_other_user' : 'deposit_unmatched';
        }
        save(owner ? 'matched' : diagnosis === 'click_other_user' ? 'conflict' : 'unmatched', owner, diagnosis);
        if (isFinancial && owner && lockUser) {
          tx.update(C.users, owner, { deposit: applyDeposit(lockUser.deposit ?? null, { ...record, matchStatus: 'matched', matchedUserDocId: owner }, nowIso) });
        }
        if (isFinancial) {
          writeAudit(tx, {
            botId: scope.botId, actor: { type: 'system', id: `postback:${sourceId}` }, action: `finance.${ev.eventType}`, target: docId,
            after: { traderId: maskTraderId(tid), amount: ev.amount, currency: ev.currency, matched: Boolean(owner), userDocId: owner, routedBy: route.by, diagnosis, possibleDuplicateOf },
          }, this.d.now());
        }
        return { duplicate: false, conflict: false, possibleDuplicateOf, matchedUser: owner, diagnosis };
      }

      // Registration (Academy rule: the Trader ID is the key, our click_id names the owner when there is one).
      const none = { duplicate: false, conflict: false, possibleDuplicateOf: null };
      if (route.diagnosis) {
        // Global source without our click_id: nobody / several bots hold this Trader ID → stored, not linked.
        save(route.diagnosis === 'registration_unclaimed' ? 'awaiting_confirmation' : 'review', null, route.diagnosis);
        return { ...none, matchedUser: null, diagnosis: route.diagnosis };
      }
      if (lock) {
        // Already linked: the binding is never overwritten; a registration naming another owner goes to review.
        const owner = route.ownerDocId ?? clickUserDocId;
        const other = Boolean(owner && owner !== lock.userDocId);
        save(other ? 'conflict' : 'matched', lock.userDocId, other ? 'click_other_user' : route.by === 'click_id' ? 'matched_click' : 'matched_trader_id');
        return { ...none, matchedUser: lock.userDocId, diagnosis: other ? 'click_other_user' as const : null };
      }
      if (regOwner && ownerUser && scope.owns(ownerUser) && !ownerUser.traderId) {
        if (ownerClaim && ownerClaim.status === 'pending' && ownerUser.bindingState !== 'manual_review' && ownerUser.bindingState !== 'binding_conflict') {
          // The user already entered this Trader ID and the partner now confirms the registration.
          const method = route.by === 'click_id' ? 'click_id' : 'trader_id';
          save('matched', regOwner, method === 'click_id' ? 'matched_click' : 'matched_trader_id');
          this.bind(tx, scope, ownerUser, regOwner, tid, tHash, { id: claimId(regOwner, tid), data: ownerClaim }, method, null, nowIso, 'system', docId);
          this.promotePending(tx, scope, regOwner, pending, nowIso, `postback:${sourceId}`);
          return { ...none, matchedUser: regOwner, diagnosis: null };
        }
        save('awaiting_confirmation', regOwner, 'registration_awaiting'); // waits for the user to enter this Trader ID
        return { ...none, matchedUser: null, diagnosis: null };
      }
      if (clickless) {
        // Per-bot source, no click_id of ours: the first user of this bot who enters the Trader ID links it.
        save('awaiting_confirmation', null, 'registration_unclaimed');
        return { ...none, matchedUser: null, diagnosis: null };
      }
      // Our click of a user who already holds another Trader ID, or no usable click with the Academy rule off.
      const regDiag: PostbackDiagnosis = regOwner || clickTok || route.clickState === 'valid' ? 'click_other_user' : (`click_${route.clickState}` as PostbackDiagnosis);
      save('unmatched', null, regDiag);
      return { ...none, matchedUser: null, diagnosis: regDiag };
    });

    if (outcome.diagnosis && DIAGNOSIS_ERROR[outcome.diagnosis]) {
      await this.d.errors.record(targetBotId, 'postback', DIAGNOSIS_ERROR[outcome.diagnosis]!,
        `source ${sourceId}: ${ev.eventType} for Trader ID ${maskTraderId(tid)} not credited (${outcome.diagnosis})`);
    }
    if (outcome.conflict) await this.d.errors.record(targetBotId, 'postback', 'AMOUNT_CONFLICT', `source ${sourceId}: re-delivered ${ev.eventType} with a different amount/currency; the first value is kept`);
    if (outcome.possibleDuplicateOf) {
      await this.d.errors.record(targetBotId, 'postback', 'POSSIBLE_DUPLICATE', `source ${sourceId}: ${ev.eventType} with the same Trader ID and amount within ${SIMILAR_WINDOW_MS / 60000} min; held, not counted — confirm it in the postback history if it is a separate deposit`);
    }
    if (bundle) this.d.stats.incr(targetBotId, outcome.duplicate ? 'postback_duplicate' : `postback_${ev.eventType}`);
    return { status: 200, body: { ok: true, duplicate: outcome.duplicate } };
  }

  /**
   * Finds the bot (and, for deposits routed by Trader ID, the user) of a postback.
   *
   *  - Registration (and any non-deposit event) of the global source: a valid click_id is
   *    REQUIRED — an unknown Trader ID must never be linked to anybody without it.
   *  - Deposits with a valid click_id: the click decides, exactly as before. A click of another
   *    user/bot is never bypassed through the Trader ID.
   *  - Deposits whose click_id is missing, unknown or expired: the Trader ID decides, but only
   *    if it is linked to exactly ONE user (in one bot). An expired click must still belong to
   *    that user. Not linked / linked in several bots → stored, never credited.
   */
  private async routePostback(
    source: PartnerSource,
    sourceId: string,
    params: Record<string, string>,
    nowIso: string,
  ): Promise<{
    botId: string;
    by: 'click_id' | 'trader_id' | 'source';
    userDocId: string | null;
    clickState: 'valid' | 'expired' | 'not_found' | 'missing';
    /** The Trader ID is linked in another bot than the click's one (click-routed deposits). */
    boundElsewhere: boolean;
    /** Set when the event can never be credited (decided before the transaction). */
    diagnosis: PostbackDiagnosis | null;
    /** Registration: who registered — click_id issued by us (valid or expired), existing binding, or the single pending claim. */
    ownerDocId?: string | null;
    /** Deposits routed by a valid click_id: the user who owns that click. */
    clickOwnerDocId?: string | null;
  }> {
    const isGlobal = source.botId === GLOBAL_SOURCE_BOT_ID;
    const rawType = (params[source.mapping.eventType] ?? '').trim();
    const financial = (FINANCIAL_EVENT_TYPES as readonly string[]).includes(source.eventTypeMap[rawType] ?? 'other');

    const clickRaw = source.mapping.clickId ? normalizeClickId(params[source.mapping.clickId] ?? '') : '';
    const click = clickRaw && CLICK_ID_PATTERN.test(clickRaw) ? await this.d.store.get<ClickTokenRecord>(C.clickTokens, clickRaw) : null;
    const clickState = !clickRaw ? 'missing' : !click ? 'not_found' : click.expiresAt <= nowIso ? 'expired' : 'valid';
    const base = { userDocId: null, clickState, boundElsewhere: false, diagnosis: null } as const;

    if (!financial) {
      if (!isGlobal) return { ...base, botId: source.botId, by: clickState === 'valid' ? 'click_id' : 'source', ownerDocId: clickState === 'valid' && click!.botId === source.botId ? click!.userDocId : null };
      // A click_id issued by us identifies who registered — also after it expired (Academy rule).
      if (clickState === 'valid' || clickState === 'expired') return { ...base, botId: click!.botId, by: 'click_id', ownerDocId: click!.userDocId };
      if (!(await this.clicklessAllowed())) {
        const code = clickState === 'missing' ? 'CLICK_MISSING' : 'CLICK_NOT_FOUND';
        await this.d.errors.record(GLOBAL_LOG_BOT_ID, 'postback', code, `source ${sourceId}: ${rawType.slice(0, 32) || 'event'} rejected, registration requires a valid click_id (${clickState})`);
        throw new AppError('BAD_REQUEST', 'valid click_id is required for a registration');
      }
      // Registration without our click_id (Academy rule): the Trader ID decides where it can go.
      const tid = normalizeTraderId(params[source.mapping.traderId] ?? '');
      if (!ROUTING_TRADER_ID.test(tid)) return { ...base, botId: GLOBAL_LOG_BOT_ID, by: 'trader_id' }; // normalizeEvent rejects it
      const locks = await this.d.store.query<TraderBindingRecord>(C.traderBindings, { where: [{ field: 'traderIdNorm', op: '==', value: tid }], limit: 20 });
      if (locks.length > 1) return { ...base, botId: GLOBAL_LOG_BOT_ID, by: 'trader_id', diagnosis: 'trader_ambiguous' };
      if (locks[0]) return { ...base, botId: locks[0].data.botId, by: 'trader_id', ownerDocId: locks[0].data.userDocId };
      // Somebody already entered this Trader ID and is waiting for the registration: exactly one such user → theirs.
      const claims = (await this.d.store.query<ClaimRecord>(C.bindingClaims, { where: [{ field: 'traderIdHash', op: '==', value: hashTid(tid) }], limit: 20 }))
        .filter((c) => c.data.status === 'pending');
      if (claims.length === 1) return { ...base, botId: claims[0]!.data.botId, by: 'trader_id', ownerDocId: claims[0]!.data.userDocId };
      return { ...base, botId: GLOBAL_LOG_BOT_ID, by: 'trader_id', diagnosis: 'registration_unclaimed' };
    }

    // Deposits. Every place the Trader ID is linked (one bot for a per-bot source).
    const tid = normalizeTraderId(params[source.mapping.traderId] ?? '');
    const locks = ROUTING_TRADER_ID.test(tid)
      ? (await this.d.store.query<TraderBindingRecord>(C.traderBindings, { where: [{ field: 'traderIdNorm', op: '==', value: tid }], limit: 20 }))
          .filter((l) => isGlobal || l.data.botId === source.botId)
      : [];

    if (clickState === 'valid') {
      if (!isGlobal && click!.botId !== source.botId) return { ...base, botId: source.botId, by: 'click_id', diagnosis: 'click_other_user' };
      const botId = isGlobal ? click!.botId : source.botId;
      return { ...base, botId, by: 'click_id', clickOwnerDocId: click!.userDocId, boundElsewhere: !locks.some((l) => l.data.botId === botId) && locks.length > 0 };
    }

    const unrouted = isGlobal ? GLOBAL_LOG_BOT_ID : source.botId;
    if (locks.length > 1) return { ...base, botId: unrouted, by: 'trader_id', diagnosis: 'trader_ambiguous' };
    const lock = locks[0];
    if (!lock) return { ...base, botId: unrouted, by: 'trader_id', diagnosis: 'trader_not_bound' };
    // An expired click is still evidence: it must belong to the user who holds the Trader ID.
    if (clickState === 'expired' && click!.userDocId !== lock.data.userDocId) {
      return { ...base, botId: isGlobal ? click!.botId : source.botId, by: 'click_id', diagnosis: 'click_other_user' };
    }
    return { ...base, botId: lock.data.botId, by: 'trader_id', userDocId: lock.data.userDocId };
  }

  // ───────── admin actions (always audited) ─────────

  async adminBind(
    actor: AdminActor,
    scope: TenantScope,
    input: { telegramId: number; traderId: string; reason: string; releaseFromOther?: boolean },
  ): Promise<UserRecord> {
    authorize(actor, scope.botId, 'binding.manage');
    const reason = requireReason(input.reason);
    const bundle = await this.d.bots.require(scope.botId);
    const tid = normalizeTraderId(input.traderId);
    if (!traderPattern(bundle.config).test(tid)) throw new AppError('TRADER_ID_INVALID');
    const uid = scope.userDocId(input.telegramId);
    const tHash = hashTid(tid);
    const now = this.d.now().toISOString();

    return this.d.store.runTransaction(async (tx) => {
      const user = await tx.get<UserRecord>(C.users, uid);
      if (!user || !scope.owns(user)) throw new AppError('NOT_FOUND', 'user not found');
      const newLock = await tx.get<TraderBindingRecord>(C.traderBindings, lockId(scope, tid));
      const oldLockId = user.traderId && user.traderId !== tid ? lockId(scope, user.traderId) : null;
      const otherUid = newLock && newLock.userDocId !== uid ? newLock.userDocId : null;
      const otherUser = otherUid ? await tx.get<UserRecord>(C.users, otherUid) : null;
      const myClaims = await tx.query<ClaimRecord>(C.bindingClaims, { where: scope.where({ field: 'userDocId', op: '==', value: uid }) });
      const pending = await this.readPendingDeposits(tx, scope.botId, tHash);

      if (otherUid && !input.releaseFromOther) {
        throw new AppError('ALREADY_EXISTS', 'Trader ID is linked to another Telegram account; confirm releaseFromOther');
      }
      const actorRef: AuditActor = { type: 'admin', id: actor.uid };
      if (oldLockId) tx.delete(C.traderBindings, oldLockId);
      if (otherUid && otherUser) {
        this.setUser(tx, otherUser, otherUid, 'waiting_for_trader_id', now, { traderId: null }, 'admin');
        writeAudit(tx, { botId: scope.botId, actor: actorRef, action: 'binding.release', target: otherUid, reason,
          before: { state: otherUser.bindingState, traderId: maskTraderId(tid) }, after: { state: 'waiting_for_trader_id' } }, new Date(now));
      }
      tx.set(C.traderBindings, lockId(scope, tid), scope.stamp({
        traderIdNorm: tid, userDocId: uid, method: 'admin', eventDocId: null, boundAt: now, boundBy: actor.uid,
      }));
      const updated = this.setUser(tx, user, uid, 'account_bound', now, { traderId: tid, mismatchAttempts: 0, verifiedTraderIdHash: tHash }, 'admin');
      for (const c of myClaims) tx.update(C.bindingClaims, c.id, { status: c.data.traderIdHash === tHash ? 'matched' : 'rejected', updatedAt: now });
      writeAudit(tx, {
        botId: scope.botId, actor: actorRef, action: user.traderId ? 'binding.rebind' : 'binding.admin_bind', target: uid, reason,
        before: { state: user.bindingState, traderId: user.traderId ? maskTraderId(user.traderId) : null },
        after: { state: 'account_bound', traderId: maskTraderId(tid) },
      }, new Date(now));
      // Deposits that waited for this Trader ID (Pending) belong to the user it is now linked to.
      this.promotePending(tx, scope, uid, pending, now, `admin:${actor.uid}`);
      return updated;
    });
  }

  /**
   * Excludes a deposit event from the totals (e.g. an admin confirmed that a flagged
   * repeat deposit was a re-delivery) or restores it. Nothing is deleted; reason + audit
   * are required. The holder's deposit summary is recomputed from the stored events.
   */
  async adminSetEventExcluded(actor: AdminActor, eventId: string, input: { excluded: boolean; reason: string }): Promise<{ id: string; excluded: PostbackEventRecord['excluded'] }> {
    const reason = requireReason(input.reason);
    const now = this.d.now().toISOString();
    const result = await this.d.store.runTransaction(async (tx) => {
      const e = await tx.get<PostbackEventRecord>(C.postbackEvents, eventId);
      if (!e) throw new AppError('NOT_FOUND');
      authorize(actor, e.botId, 'binding.manage');
      if (!(FINANCIAL_EVENT_TYPES as readonly string[]).includes(e.eventType)) throw new AppError('VALIDATION_FAILED', 'only deposit events can be excluded');
      const holderEvents = e.matchedUserDocId
        ? await tx.query<PostbackEventRecord>(C.postbackEvents, { where: [{ field: 'botId', op: '==', value: e.botId }, { field: 'traderIdHash', op: '==', value: e.traderIdHash }], limit: 500 })
        : [];
      const excluded = input.excluded ? { by: actor.uid, at: now, reason } : null;
      tx.update(C.postbackEvents, eventId, { excluded });
      if (e.matchedUserDocId) {
        const uid = e.matchedUserDocId;
        const evs = holderEvents.map((h) => (h.id === eventId ? { ...h.data, excluded } : h.data)).filter((h) => h.botId === e.botId && attributable(h, uid));
        tx.update(C.users, uid, { deposit: summarizeDeposits(evs, now) });
      }
      writeAudit(tx, {
        botId: e.botId, actor: { type: 'admin', id: actor.uid }, action: input.excluded ? 'finance.event_excluded' : 'finance.event_restored', target: eventId, reason,
        before: { excluded: Boolean(e.excluded) }, after: { excluded: input.excluded, eventType: e.eventType, amount: e.amount ?? null, traderId: maskTraderId(e.traderIdNorm) },
      }, new Date(now));
      return { id: eventId, excluded };
    });
    return result;
  }

  async adminReturnToInput(actor: AdminActor, scope: TenantScope, input: { telegramId: number; reason: string }): Promise<UserRecord> {
    authorize(actor, scope.botId, 'binding.manage');
    const reason = requireReason(input.reason);
    const uid = scope.userDocId(input.telegramId);
    const now = this.d.now().toISOString();
    return this.d.store.runTransaction(async (tx) => {
      const user = await tx.get<UserRecord>(C.users, uid);
      if (!user || !scope.owns(user)) throw new AppError('NOT_FOUND', 'user not found');
      const myClaims = await tx.query<ClaimRecord>(C.bindingClaims, { where: scope.where({ field: 'userDocId', op: '==', value: uid }) });
      if (user.traderId) tx.delete(C.traderBindings, lockId(scope, user.traderId));
      for (const c of myClaims) if (c.data.status !== 'matched') tx.update(C.bindingClaims, c.id, { status: 'rejected', updatedAt: now });
      const updated = this.setUser(tx, user, uid, 'waiting_for_trader_id', now, { traderId: null, verifiedTraderIdHash: null, mismatchAttempts: 0 }, 'admin');
      writeAudit(tx, {
        botId: scope.botId, actor: { type: 'admin', id: actor.uid }, action: 'binding.unbind', target: uid, reason,
        before: { state: user.bindingState, traderId: user.traderId ? maskTraderId(user.traderId) : null },
        after: { state: 'waiting_for_trader_id' },
      }, new Date(now));
      return updated;
    });
  }

  /**
   * "Skip to signals": a separate, audited permission for a user hit by a technical problem.
   * It changes ONLY manualAccess — never the binding state, the Trader ID, the deposit,
   * onboardingCompletedAt or any postback event.
   */
  async adminSetManualAccess(actor: AdminActor, scope: TenantScope, input: { telegramId: number; grant: boolean; reason: string }): Promise<UserRecord> {
    authorize(actor, scope.botId, 'binding.manage');
    const reason = requireReason(input.reason);
    const uid = scope.userDocId(input.telegramId);
    const now = this.d.now().toISOString();
    return this.d.store.runTransaction(async (tx) => {
      const user = await tx.get<UserRecord>(C.users, uid);
      if (!user || !scope.owns(user)) throw new AppError('NOT_FOUND', 'user not found');
      const prev = user.manualAccess ?? null;
      if (input.grant && prev?.active) throw new AppError('ALREADY_EXISTS', 'manual access is already granted');
      if (!input.grant && !prev?.active) throw new AppError('VALIDATION_FAILED', 'manual access is not granted');
      const manualAccess: ManualAccess = input.grant
        ? { active: true, grantedAt: now, grantedBy: actor.uid, grantReason: reason, revokedAt: null, revokedBy: null, revokeReason: null }
        : { ...prev!, active: false, revokedAt: now, revokedBy: actor.uid, revokeReason: reason };
      tx.update(C.users, uid, { manualAccess, manualAccessActive: manualAccess.active });
      writeAudit(tx, {
        botId: scope.botId, actor: { type: 'admin', id: actor.uid }, action: input.grant ? 'access.manual_grant' : 'access.manual_revoke', target: uid, reason,
        before: { manualAccess: Boolean(prev?.active), onboardingCompleted: Boolean(user.onboardingCompletedAt) },
        after: { manualAccess: manualAccess.active, onboardingCompleted: Boolean(user.onboardingCompletedAt) },
      }, new Date(now));
      return { ...user, manualAccess, manualAccessActive: manualAccess.active };
    });
  }

  /**
   * Fixes a stuck onboarding step of a user whose Trader ID is NOT linked:
   *  - 'trader_id': the user registered but the app did not notice the return → open step 2;
   *  - 'registration': start again from step 1.
   * Only the step markers and the last error are touched. Linked users are fixed with
   * "Unlink Trader ID" (adminReturnToInput) or "Link manually" (adminBind) instead.
   */
  async adminSetOnboardingStep(actor: AdminActor, scope: TenantScope, input: { telegramId: number; step: 'registration' | 'trader_id'; reason: string }): Promise<UserRecord> {
    authorize(actor, scope.botId, 'binding.manage');
    const reason = requireReason(input.reason);
    if (input.step !== 'registration' && input.step !== 'trader_id') throw new AppError('VALIDATION_FAILED', 'unknown step');
    const uid = scope.userDocId(input.telegramId);
    const now = this.d.now().toISOString();
    return this.d.store.runTransaction(async (tx) => {
      const user = await tx.get<UserRecord>(C.users, uid);
      if (!user || !scope.owns(user)) throw new AppError('NOT_FOUND', 'user not found');
      if (user.traderId) throw new AppError('VALIDATION_FAILED', 'Trader ID is linked: unlink it first');
      const patch: Partial<UserRecord> =
        input.step === 'trader_id'
          ? { registrationStartedAt: user.registrationStartedAt ?? now, traderIdSubmitStartedAt: now, lastBindingError: null }
          : { registrationStartedAt: null, traderIdSubmitStartedAt: null, lastBindingError: null };
      // A user parked in review / conflict goes back to the normal Trader ID input.
      const updated = user.bindingState === 'manual_review' || user.bindingState === 'binding_conflict'
        ? this.setUser(tx, user, uid, 'waiting_for_trader_id', now, patch, 'admin')
        : (tx.update(C.users, uid, patch), { ...user, ...patch });
      writeAudit(tx, {
        botId: scope.botId, actor: { type: 'admin', id: actor.uid }, action: 'onboarding.set_step', target: uid, reason,
        before: { state: user.bindingState, registrationStarted: Boolean(user.registrationStartedAt), traderIdStep: Boolean(user.traderIdSubmitStartedAt) },
        after: { state: updated.bindingState, step: input.step },
      }, new Date(now));
      return updated;
    });
  }

  /**
   * "Re-check deposit": recomputes the deposit summary of a linked user from the partner
   * events already stored. Creates and changes no events; a deposit becomes confirmed only
   * if the partner actually reported it.
   */
  async adminRecheckDeposit(actor: AdminActor, scope: TenantScope, input: { telegramId: number; reason: string }): Promise<DepositSummary> {
    authorize(actor, scope.botId, 'binding.manage');
    const reason = requireReason(input.reason);
    const uid = scope.userDocId(input.telegramId);
    const now = this.d.now().toISOString();
    return this.d.store.runTransaction(async (tx) => {
      const user = await tx.get<UserRecord>(C.users, uid);
      if (!user || !scope.owns(user)) throw new AppError('NOT_FOUND', 'user not found');
      if (!user.traderId) throw new AppError('VALIDATION_FAILED', 'Trader ID is not linked');
      const evs = await tx.query<PostbackEventRecord>(C.postbackEvents, { where: scope.where({ field: 'traderIdHash', op: '==', value: hashTid(user.traderId) }), limit: 500 });
      const summary = summarizeDeposits(evs.map((e) => e.data).filter((e) => attributable(e, uid)), now);
      tx.update(C.users, uid, { deposit: summary });
      writeAudit(tx, {
        botId: scope.botId, actor: { type: 'admin', id: actor.uid }, action: 'finance.deposit_recheck', target: uid, reason,
        before: { depositsCount: user.deposit?.depositsCount ?? 0, ftdAmount: user.deposit?.ftdAmount ?? null },
        after: { depositsCount: summary.depositsCount, ftdAmount: summary.ftdAmount, events: evs.length },
      }, new Date(now));
      return summary;
    });
  }

  private async clicklessAllowed(): Promise<boolean> {
    return this.d.clicklessRegistration ? this.d.clicklessRegistration() : true;
  }

  /**
   * Deposits that arrived before the Trader ID was linked and had no usable click_id
   * ("Pending", Academy rule). Kept under the "global" bucket (global source) or the bot
   * (per-bot source). Read inside the transaction that links the Trader ID.
   */
  private async readPendingDeposits(tx: Transaction, botId: string, tHash: string): Promise<StoredDoc<PostbackEventRecord>[]> {
    const evs = await tx.query<PostbackEventRecord>(C.postbackEvents, { where: [{ field: 'traderIdHash', op: '==', value: tHash }], limit: 200 });
    return evs.filter((e) =>
      (e.data.botId === GLOBAL_LOG_BOT_ID || e.data.botId === botId) &&
      e.data.diagnosis === 'trader_not_bound' &&
      !e.data.matchedUserDocId &&
      !e.data.excluded &&
      (FINANCIAL_EVENT_TYPES as readonly string[]).includes(e.data.eventType));
  }

  /**
   * Credits pending deposits to the user who has just linked their Trader ID. Each event is
   * moved to that bot once (it is no longer "trader_not_bound" afterwards), never duplicated,
   * and audited. FTD stays one per Trader ID: the deposit summary ignores a second FTD.
   */
  private promotePending(tx: Transaction, scope: TenantScope, uid: string, pending: StoredDoc<PostbackEventRecord>[], nowIso: string, actorId: string): void {
    for (const e of pending) {
      tx.update(C.postbackEvents, e.id, {
        botId: scope.botId, matchStatus: 'matched', matchedUserDocId: uid, routedBy: 'trader_id', diagnosis: 'matched_pending',
        promotedAt: nowIso, promotedFromBotId: e.data.botId,
      });
      writeAudit(tx, {
        botId: scope.botId, actor: { type: 'system', id: actorId }, action: 'finance.pending_promoted', target: e.id,
        after: { eventType: e.data.eventType, amount: e.data.amount ?? null, currency: e.data.currency ?? null, userDocId: uid, traderId: maskTraderId(e.data.traderIdNorm) },
      }, new Date(nowIso));
    }
  }

  // ───────── helpers (writes only, no reads) ─────────

  private setUser(
    tx: Transaction,
    user: UserRecord,
    uid: string,
    to: BindingState,
    nowIso: string,
    extra: Partial<UserRecord> = {},
    actor: 'system' | 'admin' = 'system',
  ): UserRecord {
    assertTransition(user.bindingState, to, actor);
    const patch = { ...extra, bindingState: to, bindingUpdatedAt: user.bindingState === to ? user.bindingUpdatedAt : nowIso };
    tx.update(C.users, uid, patch);
    return { ...user, ...patch };
  }

  private upsertClaim(tx: Transaction, scope: TenantScope, existing: StoredDoc<ClaimRecord> | null, uid: string, tid: string, tHash: string, status: ClaimStatus, nowIso: string): void {
    if (existing) {
      tx.update(C.bindingClaims, existing.id, { status, updatedAt: nowIso });
    } else {
      tx.create(C.bindingClaims, claimId(uid, tid), scope.stamp({ userDocId: uid, traderIdNorm: tid, traderIdHash: tHash, status, createdAt: nowIso, updatedAt: nowIso }));
    }
  }

  private bind(
    tx: Transaction,
    scope: TenantScope,
    user: UserRecord,
    uid: string,
    tid: string,
    tHash: string,
    claim: StoredDoc<ClaimRecord> | null,
    method: TraderBindingRecord['method'],
    eventDocIdToMark: string | null,
    nowIso: string,
    boundBy: string,
    createdEventDocId?: string,
  ): UserRecord {
    // `create` fails if another transaction bound this Trader ID first → whole transaction fails, nothing half-written.
    tx.create(C.traderBindings, lockId(scope, tid), scope.stamp({
      traderIdNorm: tid, userDocId: uid, method, eventDocId: eventDocIdToMark ?? createdEventDocId ?? null, boundAt: nowIso, boundBy,
    }));
    this.upsertClaim(tx, scope, claim, uid, tid, tHash, 'matched', nowIso);
    if (eventDocIdToMark) tx.update(C.postbackEvents, eventDocIdToMark, { matchStatus: 'matched', matchedUserDocId: uid, diagnosis: method === 'click_id' ? 'matched_click' : 'matched_trader_id' });
    return this.setUser(tx, user, uid, 'account_bound', nowIso, { traderId: tid, mismatchAttempts: 0, lastBindingError: null, verifiedTraderIdHash: tHash });
  }
}

/** Trader IDs are normalized to lower case, so the configured pattern is applied case-insensitively. */
function traderPattern(config: BotConfig): RegExp {
  return new RegExp(config.accountBinding.traderIdPattern, 'i');
}

function requireReason(reason: string): string {
  const r = (reason ?? '').trim();
  if (r.length < 5) throw new AppError('BAD_REQUEST', 'a reason (min 5 characters) is required for audit');
  return r.slice(0, 500);
}

export function authorize(actor: AdminActor, botId: string, permission: ManagerPermission): void {
  if (actor.role === 'owner') return;
  if (!actor.botPermissions[botId]?.includes(permission)) throw new AppError('FORBIDDEN', 'missing permission');
}

// ───────── deposit summary (onboarding step 3) ─────────

const eventTime = (e: PostbackEventRecord) => {
  const t = e.occurredAt ? Date.parse(e.occurredAt) : NaN;
  return Number.isFinite(t) ? new Date(t).toISOString() : e.receivedAt;
};

/**
 * Adds one financial event to a deposit summary.
 *  - The first deposit (FTD) comes ONLY from an `ftd` event; there is one per Trader ID, so a
 *    second `ftd` event (e.g. the same deposit reported by an old per-bot source) is ignored.
 *  - Every `redeposit` event is counted: repeat deposits are never merged by amount.
 *  - Events excluded by an admin are skipped.
 */
export function applyDeposit(prev: DepositSummary | null, e: PostbackEventRecord, nowIso: string): DepositSummary {
  const base: DepositSummary = prev ?? { status: 'none', ftdAmount: null, ftdCurrency: null, ftdAt: null, depositsCount: 0, lastDepositAt: null, updatedAt: nowIso };
  if (e.excluded) return base;
  const at = eventTime(e);
  if (e.eventType === 'ftd' && base.ftdAt) return base; // only one first deposit
  const isFtd = e.eventType === 'ftd';
  const count = base.depositsCount + 1;
  return {
    status: count > 1 || !(isFtd || base.ftdAt) ? 'redeposit' : 'ftd',
    ftdAmount: isFtd ? (e.amount ?? null) : base.ftdAmount,
    ftdCurrency: isFtd ? (e.currency ?? null) : base.ftdCurrency,
    ftdAt: isFtd ? at : base.ftdAt,
    depositsCount: count,
    // Sum in USD; an amount in another currency is not converted (it stays visible in the event history).
    totalAmount: Math.round(((base.totalAmount ?? 0) + (typeof e.amount === 'number' && (!e.currency || e.currency === 'USD') ? e.amount : 0)) * 100) / 100,
    lastDepositAt: !base.lastDepositAt || at > base.lastDepositAt ? at : base.lastDepositAt,
    updatedAt: nowIso,
  };
}

/**
 * May this event be counted for `userDocId` (the holder of its Trader ID)?
 * An event carrying a click_id counts only for that click's owner; an event of the
 * global source must carry one. Old events of per-bot sources without click_id count.
 */
export function attributable(e: Pick<PostbackEventRecord, 'clickUserDocId' | 'globalSource' | 'clickId' | 'routedBy' | 'matchedUserDocId'>, userDocId: string): boolean {
  if (e.clickUserDocId) return e.clickUserDocId === userDocId;
  // Deposit routed by the unique binding of its Trader ID: it belongs to the user it was matched to.
  if (e.routedBy === 'trader_id') return e.matchedUserDocId === userDocId;
  if (e.clickId) return false; // click of another bot / unknown click
  return e.globalSource !== true;
}

/** Full recomputation from the stored events of one Trader ID (already filtered for the user). */
export function summarizeDeposits(events: PostbackEventRecord[], nowIso: string): DepositSummary {
  const fin = events
    .filter((e) => (FINANCIAL_EVENT_TYPES as readonly string[]).includes(e.eventType) && !e.excluded)
    // FTD first (it is the first deposit by definition), then by time.
    .sort((a, b) => (a.eventType === 'ftd') !== (b.eventType === 'ftd') ? (a.eventType === 'ftd' ? -1 : 1) : eventTime(a) < eventTime(b) ? -1 : 1);
  let s: DepositSummary | null = null;
  for (const e of fin) s = applyDeposit(s, e, nowIso);
  if (s && fin.some((e) => e.conflictingDelivery && e.eventType === 'ftd')) s = { ...s, conflict: true };
  return s ?? { status: 'none', ftdAmount: null, ftdCurrency: null, ftdAt: null, depositsCount: 0, lastDepositAt: null, updatedAt: nowIso };
}
