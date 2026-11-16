import { FINANCIAL_EVENT_TYPES, renderPartnerLink, type AdminUser, type BindingState, type BotConfig, type ManagerPermission, type PartnerSource } from '@open-signal/shared';
import { AppError, type ErrorCode } from '../lib/errors.ts';
import { sha256Hex, type SecretBox } from '../lib/crypto.ts';
import { newClickId, normalizeClickId } from '../lib/ids.ts';
import type { Logger } from '../lib/logger.ts';
import { C } from '../storage/collections.ts';
import { increment, type DocumentStore, type StoredDoc, type Transaction } from '../storage/types.ts';
import { writeAudit, type AuditActor } from '../domain/audit.ts';
import type { BotRepository } from '../domain/bots.ts';
import type { ErrorLog, StatsBuffer } from '../domain/observability.ts';
import type { DepositSummary, UserRecord } from '../domain/records.ts';
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
  receivedAt: string;
  lastDeliveryAt: string;
  deliveryCount: number;
  matchStatus: MatchStatus;
  matchedUserDocId: string | null;
}

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

      // A registration of this Trader ID made through THIS user's personal link.
      const idx = events.findIndex((e, i) => {
        const c = clicks[i];
        return Boolean(e.data.clickId && c && scope.owns(c) && c.userDocId === uid);
      });
      if (idx >= 0) {
        const event = events[idx]!;
        return finish(this.bind(tx, scope, user, uid, tid, tHash, myClaim ? { id: claimId(uid, tid), data: myClaim } : null, 'click_id', event.id, nowIso, 'system'));
      }
      if (events.length > 0) return fail('CLICK_MISMATCH');

      // Not confirmed yet: remember the claim, so a registration postback that arrives
      // later with this user's click_id links the account automatically.
      this.upsertClaim(tx, scope, myClaim ? { id: claimId(uid, tid), data: myClaim } : null, uid, tid, tHash, 'pending', nowIso);
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
    // A global source serves every bot: the tenant is the bot that issued the click_id.
    const clickRaw = source.mapping.clickId ? normalizeClickId(params[source.mapping.clickId] ?? '') : '';
    const routedClick = clickRaw ? await this.d.store.get<ClickTokenRecord>(C.clickTokens, clickRaw) : null;
    if (isGlobal && (!routedClick || routedClick.expiresAt <= nowIso)) {
      await this.d.errors.record(logBot, 'postback', 'UNKNOWN_CLICK', `source ${sourceId}: ${clickRaw ? 'unknown or expired click_id' : 'no click_id'} (event ${(params[source.mapping.eventType] ?? '').slice(0, 32)})`);
      throw new AppError('BAD_REQUEST', 'valid click_id is required for the global postback');
    }
    const targetBotId = isGlobal ? routedClick!.botId : source.botId;
    const bundle = await this.d.bots.find(targetBotId);
    if (!bundle) throw new AppError('NOT_FOUND');

    let ev: ReturnType<typeof normalizeEvent>;
    try {
      ev = normalizeEvent(source, params, traderPattern(bundle.config));
    } catch (e) {
      await this.d.errors.record(isGlobal ? logBot : targetBotId, 'postback', 'BAD_EVENT', `source ${sourceId}: ${e instanceof Error ? e.message : 'invalid event'}`);
      throw e;
    }
    const scope = new TenantScope(targetBotId);
    const tid = normalizeTraderId(ev.traderIdNorm);
    const tHash = hashTid(tid);
    const windowKey = ev.noNaturalKey ? `${sourceId}:${ev.similarKey}` : null;
    // Without a natural key every delivery gets its own document: a real repeat deposit is never lost.
    const docId = postbackEventDocId(sourceId, `${targetBotId}:${ev.eventKey}${ev.noNaturalKey ? `:${this.d.now().getTime()}:${randomBytes(6).toString('hex')}` : ''}`);
    const isFinancial = (FINANCIAL_EVENT_TYPES as readonly string[]).includes(ev.eventType);

    const outcome = await this.d.store.runTransaction(async (tx): Promise<{ duplicate: boolean; conflict: boolean; possibleDuplicateOf: string | null; matchedUser: string | null }> => {
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
        return { duplicate: true, conflict, possibleDuplicateOf: null, matchedUser: prev.matchedUserDocId };
      }
      const possibleDuplicateOf = similar?.id ?? null;
      const lock = await tx.get<TraderBindingRecord>(C.traderBindings, lockId(scope, tid));
      let clickTok: ClickTokenRecord | null = null;
      let clickUser: UserRecord | null = null;
      if (ev.clickId) {
        const t = await tx.get<ClickTokenRecord>(C.clickTokens, ev.clickId);
        clickTok = t && scope.owns(t) && t.expiresAt > nowIso ? t : null; // a click_id of another bot is ignored
        if (clickTok) clickUser = await tx.get<UserRecord>(C.users, clickTok.userDocId);
      }
      const lockUser = lock && isFinancial ? await tx.get<UserRecord>(C.users, lock.userDocId) : null;
      const ownClaim = ev.eventType === 'registration' && clickTok ? await tx.get<ClaimRecord>(C.bindingClaims, claimId(clickTok.userDocId, tid)) : null;

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
        excluded: null,
        occurredAt: ev.occurredAt,
        amount: ev.amount,
        currency: ev.currency,
        partnerId: ev.partnerId,
        receivedAt: nowIso,
        lastDeliveryAt: nowIso,
        deliveryCount: 1,
        matchStatus: 'unmatched' as MatchStatus,
        matchedUserDocId: null,
      });
      const save = (matchStatus: MatchStatus, matchedUserDocId: string | null) => tx.create(C.postbackEvents, docId, { ...record, matchStatus, matchedUserDocId });

      if (ev.eventType !== 'registration') {
        // Deposits never change the binding. They belong to the user who holds the Trader ID,
        // and — when the event carries a click_id — only if it is that same user's click.
        const owner = lock && attributable(record, lock.userDocId) ? lock.userDocId : null;
        save(owner ? 'matched' : 'unmatched', owner);
        if (isFinancial && owner && lockUser) {
          tx.update(C.users, owner, { deposit: applyDeposit(lockUser.deposit ?? null, { ...record, matchStatus: 'matched', matchedUserDocId: owner }, nowIso) });
        }
        if (isFinancial) {
          writeAudit(tx, {
            botId: scope.botId, actor: { type: 'system', id: `postback:${sourceId}` }, action: `finance.${ev.eventType}`, target: docId,
            after: { traderId: maskTraderId(tid), amount: ev.amount, currency: ev.currency, matched: Boolean(owner), userDocId: owner, possibleDuplicateOf },
          }, this.d.now());
        }
        return { duplicate: false, conflict: false, possibleDuplicateOf, matchedUser: owner };
      }

      // Registration.
      const none = { duplicate: false, conflict: false, possibleDuplicateOf: null };
      if (lock) {
        save(clickUserDocId && clickUserDocId !== lock.userDocId ? 'conflict' : 'matched', lock.userDocId);
        return { ...none, matchedUser: lock.userDocId };
      }
      if (clickTok && clickUser && !clickUser.traderId) {
        if (ownClaim && ownClaim.status === 'pending' && clickUser.bindingState !== 'manual_review' && clickUser.bindingState !== 'binding_conflict') {
          // The user already entered this Trader ID and the partner now confirms it with their own click_id.
          save('matched', clickTok.userDocId);
          this.bind(tx, scope, clickUser, clickTok.userDocId, tid, tHash, { id: claimId(clickTok.userDocId, tid), data: ownClaim }, 'click_id', null, nowIso, 'system', docId);
          return { ...none, matchedUser: clickTok.userDocId };
        }
        save('awaiting_confirmation', clickTok.userDocId); // waits for the user to enter this Trader ID
        return { ...none, matchedUser: null };
      }
      save('unmatched', null);
      return { ...none, matchedUser: null };
    });

    if (outcome.conflict) await this.d.errors.record(targetBotId, 'postback', 'AMOUNT_CONFLICT', `source ${sourceId}: re-delivered ${ev.eventType} with a different amount/currency; the first value is kept`);
    if (outcome.possibleDuplicateOf) {
      await this.d.errors.record(targetBotId, 'postback', 'POSSIBLE_DUPLICATE', `source ${sourceId}: ${ev.eventType} with the same Trader ID and amount within ${SIMILAR_WINDOW_MS / 60000} min; counted, check it in the postback history`);
    }
    this.d.stats.incr(targetBotId, outcome.duplicate ? 'postback_duplicate' : `postback_${ev.eventType}`);
    return { status: 200, body: { ok: true, duplicate: outcome.duplicate } };
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
    if (eventDocIdToMark) tx.update(C.postbackEvents, eventDocIdToMark, { matchStatus: 'matched', matchedUserDocId: uid });
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
    lastDepositAt: !base.lastDepositAt || at > base.lastDepositAt ? at : base.lastDepositAt,
    updatedAt: nowIso,
  };
}

/**
 * May this event be counted for `userDocId` (the holder of its Trader ID)?
 * An event carrying a click_id counts only for that click's owner; an event of the
 * global source must carry one. Old events of per-bot sources without click_id count.
 */
export function attributable(e: Pick<PostbackEventRecord, 'clickUserDocId' | 'globalSource' | 'clickId'>, userDocId: string): boolean {
  if (e.clickUserDocId) return e.clickUserDocId === userDocId;
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
