import { FINANCIAL_EVENT_TYPES, renderPartnerLink, type AdminUser, type BindingState, type BotConfig, type ManagerPermission, type PartnerSource } from '@open-signal/shared';
import { AppError, type ErrorCode } from '../lib/errors.ts';
import { sha256Hex, type SecretBox } from '../lib/crypto.ts';
import { newClickId } from '../lib/ids.ts';
import type { Logger } from '../lib/logger.ts';
import { C } from '../storage/collections.ts';
import { increment, type DocumentStore, type StoredDoc, type Transaction } from '../storage/types.ts';
import { writeAudit, type AuditActor } from '../domain/audit.ts';
import type { BotRepository } from '../domain/bots.ts';
import type { ErrorLog, StatsBuffer } from '../domain/observability.ts';
import type { DepositSummary, UserRecord } from '../domain/records.ts';
import { TenantScope } from '../domain/tenant.ts';
import { assertTransition } from './state-machine.ts';
import { authenticateSource, collectParams, normalizeEvent, postbackEventDocId, type PostbackRequest } from './postback.ts';

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
  recheckAvailableAt: string | null;
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

const MAX_MISMATCH_ATTEMPTS = 5;
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

  isEnabled(config: Pick<BotConfig, 'modules'>): boolean {
    return config.modules.account_binding === true;
  }

  view(user: UserRecord, config: BotConfig): BindingView {
    const s = config.accountBinding;
    const now = this.d.now().getTime();
    const last = user.lastRecheckAt ? Date.parse(user.lastRecheckAt) : 0;
    const nextRecheck = last + s.recheckCooldownSec * 1000;
    const pendingSince = Date.parse(user.bindingUpdatedAt);
    return {
      enabled: this.isEnabled(config),
      state: user.bindingState,
      traderIdMasked: user.traderId ? maskTraderId(user.traderId) : (user.submittedTraderIdMasked ?? null),
      recheckAvailableAt: user.bindingState === 'registration_pending' && nextRecheck > now ? new Date(nextRecheck).toISOString() : null,
      showSupport:
        user.bindingState === 'binding_conflict' ||
        user.bindingState === 'manual_review' ||
        (user.bindingState === 'registration_pending' && now - pendingSince >= s.supportHintAfterHours * 3600_000),
      supportContact: config.supportContact,
    };
  }

  /** telegram_created → waiting_for_trader_id when the module is enabled for the bot. */
  async ensureInitialState(scope: TenantScope, config: BotConfig, user: UserRecord): Promise<UserRecord> {
    if (!this.isEnabled(config) || user.bindingState !== 'telegram_created') return user;
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
    if (!this.isEnabled(config)) throw new AppError('FORBIDDEN', 'account binding is disabled for this bot');
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

  async submitTraderId(scope: TenantScope, config: BotConfig, telegramId: number, raw: string): Promise<BindingResult> {
    if (!this.isEnabled(config)) throw new AppError('FORBIDDEN', 'account binding is disabled for this bot');
    const tid = normalizeTraderId(raw);
    if (!traderPattern(config).test(tid)) throw new AppError('TRADER_ID_INVALID');
    return this.match(scope, config, telegramId, tid, false);
  }

  async recheck(scope: TenantScope, config: BotConfig, telegramId: number): Promise<BindingResult> {
    if (!this.isEnabled(config)) throw new AppError('FORBIDDEN', 'account binding is disabled for this bot');
    const userDocId = scope.userDocId(telegramId);
    const user = await this.d.store.get<UserRecord>(C.users, userDocId);
    if (!user || !scope.owns(user)) throw new AppError('UNAUTHORIZED');
    if (user.bindingState !== 'registration_pending') return { view: this.view(user, config) };

    const now = this.d.now().getTime();
    const last = user.lastRecheckAt ? Date.parse(user.lastRecheckAt) : 0;
    const wait = Math.ceil((last + config.accountBinding.recheckCooldownSec * 1000 - now) / 1000);
    if (wait > 0) return { view: this.view(user, config), error: 'RECHECK_TOO_SOON', retryAfterSec: wait };

    const claims = await this.d.store.query<ClaimRecord>(C.bindingClaims, {
      where: scope.where({ field: 'userDocId', op: '==', value: userDocId }, { field: 'status', op: '==', value: 'pending' }),
      orderBy: { field: 'updatedAt', direction: 'desc' },
      limit: 1,
    });
    const claim = claims[0];
    if (!claim) return { view: this.view(user, config) };
    return this.match(scope, config, telegramId, claim.data.traderIdNorm, true);
  }

  /** Shared matching logic for submit and recheck. All reads first, then writes (Firestore rule). */
  private match(scope: TenantScope, config: BotConfig, telegramId: number, tid: string, isRecheck: boolean): Promise<BindingResult> {
    const uid = scope.userDocId(telegramId);
    const tHash = hashTid(tid);
    const now = this.d.now();
    const nowIso = now.toISOString();

    return this.d.store.runTransaction(async (tx) => {
      // ── reads ──
      const user = await tx.get<UserRecord>(C.users, uid);
      if (!user || !scope.owns(user)) throw new AppError('UNAUTHORIZED');
      const lock = await tx.get<TraderBindingRecord>(C.traderBindings, lockId(scope, tid));
      const claims = await tx.query<ClaimRecord>(C.bindingClaims, { where: scope.where({ field: 'traderIdHash', op: '==', value: tHash }) });
      const events = await tx.query<PostbackEventRecord>(C.postbackEvents, {
        where: scope.where({ field: 'traderIdHash', op: '==', value: tHash }, { field: 'eventType', op: '==', value: 'registration' }),
        orderBy: { field: 'receivedAt', direction: 'asc' },
      });
      const event = events[0] ?? null;
      const clickTok = event?.data.clickId ? await tx.get<ClickTokenRecord>(C.clickTokens, event.data.clickId) : null;
      const competing = claims.filter((c) => c.data.userDocId !== uid && (c.data.status === 'pending' || c.data.status === 'review'));
      const competingUsers = await this.loadUsers(tx, competing.map((c) => c.data.userDocId));

      // ── decisions & writes ──
      const myClaim = claims.find((c) => c.data.userDocId === uid) ?? null;
      const finish = (u: UserRecord, extra?: Omit<BindingResult, 'view'>): BindingResult => ({ view: this.view(u, config), ...extra });
      // The submitted (not yet confirmed) Trader ID is shown back to its owner only in masked form.
      const recheckStamp = { ...(isRecheck ? { lastRecheckAt: nowIso } : {}), submittedTraderIdMasked: maskTraderId(tid) };

      if (user.traderId) {
        if (user.traderId === tid) return finish(user);
        throw new AppError('TRADER_ID_CHANGE_FORBIDDEN');
      }
      if (user.bindingState === 'manual_review') return finish(user);

      if (lock) {
        if (lock.userDocId === uid) {
          // self-heal: lock exists but user record was not updated
          const u = this.setUser(tx, user, uid, 'account_bound', nowIso, { traderId: tid, ...recheckStamp });
          return finish(u);
        }
        this.upsertClaim(tx, scope, myClaim, uid, tid, tHash, 'conflict', nowIso);
        return finish(this.setUser(tx, user, uid, 'binding_conflict', nowIso, recheckStamp));
      }

      if (event) {
        const clickOwner = event.data.clickId && clickTok && scope.owns(clickTok) ? clickTok.userDocId : null;
        if (clickOwner && clickOwner !== uid) {
          // Registration was made through another user's personal link.
          this.upsertClaim(tx, scope, myClaim, uid, tid, tHash, 'conflict', nowIso);
          return finish(this.setUser(tx, user, uid, 'binding_conflict', nowIso, recheckStamp));
        }
        if (!clickOwner && competing.length > 0) {
          // Same Trader ID claimed by several Telegram accounts and no click_id proof → humans decide.
          this.toReview(tx, scope, competing, competingUsers, nowIso);
          this.upsertClaim(tx, scope, myClaim, uid, tid, tHash, 'review', nowIso);
          tx.update(C.postbackEvents, event.id, { matchStatus: 'review' });
          return finish(this.setUser(tx, user, uid, 'manual_review', nowIso, recheckStamp));
        }
        return finish(this.bind(tx, scope, user, uid, tid, tHash, myClaim, clickOwner ? 'click_id' : 'trader_id', event.id, nowIso, 'system'));
      }

      // No confirmed registration yet.
      if (user.bindingState === 'registration_verified' && user.verifiedTraderIdHash && user.verifiedTraderIdHash !== tHash) {
        const attempts = user.mismatchAttempts + 1;
        if (attempts >= MAX_MISMATCH_ATTEMPTS) {
          return finish(this.setUser(tx, user, uid, 'manual_review', nowIso, { mismatchAttempts: attempts }));
        }
        tx.update(C.users, uid, { mismatchAttempts: attempts });
        return finish({ ...user, mismatchAttempts: attempts }, { error: 'TRADER_ID_MISMATCH' });
      }

      this.upsertClaim(tx, scope, myClaim, uid, tid, tHash, 'pending', nowIso);
      return finish(this.setUser(tx, user, uid, 'registration_pending', nowIso, recheckStamp));
    });
  }

  // ───────── postback ─────────

  async processPostback(sourceId: string, req: PostbackRequest): Promise<{ status: number; body: { ok: true; duplicate: boolean } }> {
    if (!/^[a-z0-9-]{3,40}$/.test(sourceId)) throw new AppError('NOT_FOUND');
    const source = await this.d.store.get<PartnerSource & Record<string, unknown>>(C.partnerSources, sourceId);
    if (!source) throw new AppError('NOT_FOUND');
    if (!source.enabled) throw new AppError('FORBIDDEN', 'source disabled');

    try {
      authenticateSource(source, req, this.d.box);
    } catch (e) {
      await this.d.errors.record(source.botId === '*' ? 'global' : source.botId, 'postback', 'UNAUTHORIZED', `postback auth failed for source ${sourceId}`);
      throw e;
    }

    const params = collectParams(req);
    // A global source resolves the tenant from the per-user click_id. The same
    // endpoint can therefore receive events for every Telegram bot safely.
    const clickRaw = source.mapping.clickId ? (params[source.mapping.clickId] ?? '').trim() : '';
    const globalClick = clickRaw ? await this.d.store.get<ClickTokenRecord>(C.clickTokens, clickRaw) : null;
    if (source.botId === '*' && (!globalClick || globalClick.expiresAt <= this.d.now().toISOString())) {
      throw new AppError('BAD_REQUEST', 'valid click_id is required for the global postback');
    }
    const targetBotId = source.botId === '*' ? globalClick!.botId : source.botId;
    if (source.botId !== '*' && globalClick && globalClick.botId !== source.botId) {
      throw new AppError('BAD_REQUEST', 'click_id belongs to another bot');
    }
    const bundle = await this.d.bots.find(targetBotId);
    if (!bundle) throw new AppError('NOT_FOUND');

    const ev = normalizeEvent(source, params, traderPattern(bundle.config));
    if (source.botId === '*' && !ev.clickId) throw new AppError('BAD_REQUEST', 'valid click_id is required for the global postback');
    const scope = new TenantScope(targetBotId);
    const tid = normalizeTraderId(ev.traderIdNorm);
    const tHash = hashTid(tid);
    const docId = postbackEventDocId(sourceId, `${targetBotId}:${ev.eventKey}`);
    const nowIso = this.d.now().toISOString();

    const duplicate = await this.d.store.runTransaction(async (tx) => {
      // ── reads ──
      const existing = await tx.get<PostbackEventRecord>(C.postbackEvents, docId);
      if (existing) {
        tx.update(C.postbackEvents, docId, { deliveryCount: increment(1), lastDeliveryAt: nowIso });
        return true;
      }
      const lock = await tx.get<TraderBindingRecord>(C.traderBindings, lockId(scope, tid));
      const isFinancial = (FINANCIAL_EVENT_TYPES as readonly string[]).includes(ev.eventType);
      const depositUser = isFinancial && lock ? await tx.get<UserRecord>(C.users, lock.userDocId) : null;
      let clickTok: ClickTokenRecord | null = null;
      let clickUser: UserRecord | null = null;
      if (ev.clickId) {
        const t = await tx.get<ClickTokenRecord>(C.clickTokens, ev.clickId);
        clickTok = t && scope.owns(t) && t.expiresAt > nowIso ? t : null;
        if (clickTok) clickUser = await tx.get<UserRecord>(C.users, clickTok.userDocId);
      }
      let claims: StoredDoc<ClaimRecord>[] = [];
      let claimUsers = new Map<string, UserRecord>();
      if (ev.eventType === 'registration') {
        claims = await tx.query<ClaimRecord>(C.bindingClaims, {
          where: scope.where({ field: 'traderIdHash', op: '==', value: tHash }, { field: 'status', op: 'in', value: ['pending', 'review'] }),
        });
        claimUsers = await this.loadUsers(tx, claims.map((c) => c.data.userDocId));
      }

      // ── writes ──
      const record: PostbackEventRecord = scope.stamp({
        sourceId,
        eventType: ev.eventType,
        rawEventType: ev.rawEventType,
        partnerEventId: ev.partnerEventId,
        traderIdNorm: tid,
        traderIdHash: tHash,
        clickId: ev.clickId,
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
      const save = (matchStatus: MatchStatus, matchedUserDocId: string | null) =>
        tx.create(C.postbackEvents, docId, { ...record, matchStatus, matchedUserDocId });

      if (ev.eventType !== 'registration') {
        // Financial / other events: never change binding state or access. For a bound
        // user the deposit summary (onboarding step 3) is updated from the event.
        const clickMatches = source.botId !== '*' || Boolean(clickTok && lock && clickTok.userDocId === lock.userDocId);
        const matched = Boolean(lock && clickMatches);
        save(matched ? 'matched' : 'unmatched', matched ? lock!.userDocId : null);
        if (isFinancial && matched && lock && depositUser) {
          tx.update(C.users, lock.userDocId, { deposit: applyDeposit(depositUser.deposit ?? null, { ...record, matchStatus: 'matched', matchedUserDocId: lock.userDocId }, nowIso) });
        }
        return false;
      }

      if (lock) {
        const conflict = clickTok !== null && clickTok.userDocId !== lock.userDocId;
        save(conflict ? 'conflict' : 'matched', lock.userDocId);
        return false;
      }

      if (clickTok && clickUser) {
        const uid = clickTok.userDocId;
        if (clickUser.traderId || clickUser.bindingState === 'manual_review') {
          save(clickUser.traderId ? 'conflict' : 'review', uid);
          return false;
        }
        // Other users who claimed this Trader ID are now in conflict: the registration belongs to the click owner.
        for (const c of claims) {
          const u = claimUsers.get(c.data.userDocId);
          if (c.data.userDocId === uid || !u || u.traderId) continue;
          tx.update(C.bindingClaims, c.id, { status: 'conflict', updatedAt: nowIso });
          if (u.bindingState !== 'manual_review') this.setUser(tx, u, c.data.userDocId, 'binding_conflict', nowIso);
        }
        const own = claims.find((c) => c.data.userDocId === uid && c.data.status === 'pending') ?? null;
        if (own) {
          save('matched', uid);
          this.bind(tx, scope, clickUser, uid, tid, tHash, own, 'click_id', null, nowIso, 'system', docId);
        } else {
          save('awaiting_confirmation', uid);
          this.setUser(tx, clickUser, uid, 'registration_verified', nowIso, { verifiedTraderIdHash: tHash, mismatchAttempts: 0 });
        }
        return false;
      }

      const pending = claims.filter((c) => c.data.status === 'pending' && claimUsers.get(c.data.userDocId) && !claimUsers.get(c.data.userDocId)!.traderId);
      if (pending.length === 1) {
        const c = pending[0]!;
        save('matched', c.data.userDocId);
        this.bind(tx, scope, claimUsers.get(c.data.userDocId)!, c.data.userDocId, tid, tHash, c, 'trader_id', null, nowIso, 'system', docId);
      } else if (pending.length > 1) {
        save('review', null);
        this.toReview(tx, scope, pending, claimUsers, nowIso);
      } else {
        save('unmatched', null); // kept until the user enters this Trader ID
      }
      return false;
    });

    this.d.stats.incr(targetBotId, duplicate ? 'postback_duplicate' : `postback_${ev.eventType}`);
    return { status: 200, body: { ok: true, duplicate } };
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

  private async loadUsers(tx: Transaction, ids: string[]): Promise<Map<string, UserRecord>> {
    const unique = [...new Set(ids)];
    const docs = await Promise.all(unique.map((id) => tx.get<UserRecord>(C.users, id)));
    const map = new Map<string, UserRecord>();
    unique.forEach((id, i) => {
      const u = docs[i];
      if (u) map.set(id, u);
    });
    return map;
  }

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

  private toReview(tx: Transaction, scope: TenantScope, claims: StoredDoc<ClaimRecord>[], users: Map<string, UserRecord>, nowIso: string): void {
    for (const c of claims) {
      tx.update(C.bindingClaims, c.id, { status: 'review', updatedAt: nowIso });
      const u = users.get(c.data.userDocId);
      if (u && !u.traderId && u.bindingState !== 'manual_review') this.setUser(tx, u, c.data.userDocId, 'manual_review', nowIso);
    }
    void scope;
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
    return this.setUser(tx, user, uid, 'account_bound', nowIso, { traderId: tid, mismatchAttempts: 0 });
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

/** Adds one financial event to a deposit summary (events are already de-duplicated). */
export function applyDeposit(prev: DepositSummary | null, e: PostbackEventRecord, nowIso: string): DepositSummary {
  const at = eventTime(e);
  const base: DepositSummary = prev ?? { status: 'none', ftdAmount: null, ftdCurrency: null, ftdAt: null, depositsCount: 0, lastDepositAt: null, updatedAt: nowIso };
  const isFirst = base.depositsCount === 0;
  const takesFtd = e.eventType === 'ftd' ? !base.ftdAt || at < base.ftdAt : isFirst;
  const count = base.depositsCount + 1;
  return {
    status: count > 1 ? 'redeposit' : 'ftd',
    ftdAmount: takesFtd ? (e.amount ?? null) : base.ftdAmount,
    ftdCurrency: takesFtd ? (e.currency ?? null) : base.ftdCurrency,
    ftdAt: takesFtd ? at : base.ftdAt,
    depositsCount: count,
    lastDepositAt: !base.lastDepositAt || at > base.lastDepositAt ? at : base.lastDepositAt,
    updatedAt: nowIso,
  };
}

/** Full recomputation from the stored events of one Trader ID. */
export function summarizeDeposits(events: PostbackEventRecord[], nowIso: string): DepositSummary {
  const fin = events
    .filter((e) => (FINANCIAL_EVENT_TYPES as readonly string[]).includes(e.eventType))
    .sort((a, b) => (eventTime(a) < eventTime(b) ? -1 : 1));
  let s: DepositSummary | null = null;
  for (const e of fin) s = applyDeposit(s, e, nowIso);
  return s ?? { status: 'none', ftdAmount: null, ftdCurrency: null, ftdAt: null, depositsCount: 0, lastDepositAt: null, updatedAt: nowIso };
}
