import { randomBytes } from 'node:crypto';
import { BINDING_STATES, LANGUAGES, POSTBACK_EVENT_TYPES, upgradeBotConfig, type BindingState, type PartnerSource } from '@open-signal/shared';
import type { Env } from '../config/env.ts';
import { AppError } from '../lib/errors.ts';
import type { SecretBox } from '../lib/crypto.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore, Filter } from '../storage/types.ts';
import { writeAudit } from '../domain/audit.ts';
import type { BotConfigRecord, BotRecord, UserRecord } from '../domain/records.ts';
import { depositCheck, onboardingStatus } from '../binding/onboarding.ts';
import { accessView } from '../binding/access.ts';
import { TenantScope } from '../domain/tenant.ts';
import type { DepositCheckStatus, OnboardingStatus } from '@open-signal/shared';
import type { PlatformSettings } from '../platform/settings.ts';
import { secretAad } from '../binding/postback.ts';
import { GLOBAL_LOG_BOT_ID, GLOBAL_SOURCE_BOT_ID, maskTraderId, type ClaimRecord, type PostbackEventRecord } from '../binding/service.ts';
import { can, canSeeBot, requireOwner, requirePermission, type AdminActor } from './auth.ts';

const DAY = 86_400_000;
const isoDay = (d: Date) => d.toISOString().slice(0, 10);

export interface DailyPoint {
  day: string;
  metrics: Record<string, number>;
}

/**
 * Read models for the admin panel: dashboard, users, statistics, logs, binding
 * review queue, and partner postback sources. All numbers come from stored
 * records — nothing is estimated or generated.
 */
export class AdminInsights {
  private readonly store: DocumentStore;
  private readonly box: SecretBox;
  private readonly env: Env;
  private readonly now: () => Date;
  private readonly platform: PlatformSettings;

  constructor(deps: { store: DocumentStore; box: SecretBox; env: Env; now: () => Date; platform: PlatformSettings }) {
    this.store = deps.store;
    this.box = deps.box;
    this.env = deps.env;
    this.now = deps.now;
    this.platform = deps.platform;
  }

  async overview(actor: AdminActor, indexStatus: unknown) {
    const bots = (await this.store.query<BotRecord>(C.bots, {})).filter((b) => canSeeBot(actor, b.id));
    const since = isoDay(new Date(this.now().getTime() - 6 * DAY));
    const series = new Map<string, Record<string, number>>();
    let errors = 0;
    for (const b of bots) {
      const rows = await this.store.query<Record<string, unknown>>(C.botStatsDaily, {
        where: [{ field: 'botId', op: '==', value: b.id }, { field: 'day', op: '>=', value: since }],
        orderBy: { field: 'day', direction: 'desc' },
      });
      for (const r of rows) {
        const day = String(r.data['day']);
        const acc = series.get(day) ?? {};
        for (const [k, v] of Object.entries(r.data)) if (k.startsWith('m_') && typeof v === 'number') acc[k.slice(2)] = (acc[k.slice(2)] ?? 0) + v;
        series.set(day, acc);
      }
      const errs = await this.store.query(C.errorLogs, { where: [{ field: 'botId', op: '==', value: b.id }], orderBy: { field: 'lastSeenAt', direction: 'desc' }, limit: 50 });
      errors += errs.length;
    }
    const days: DailyPoint[] = [];
    for (let i = 6; i >= 0; i--) {
      const day = isoDay(new Date(this.now().getTime() - i * DAY));
      days.push({ day, metrics: series.get(day) ?? {} });
    }
    const recent = actor.role === 'owner'
      ? await this.store.query<Record<string, unknown>>(C.auditLogs, { orderBy: { field: 'at', direction: 'desc' }, limit: 15 })
      : [];
    return {
      bots: {
        total: bots.length,
        active: bots.filter((b) => b.data.status === 'active').length,
        disabled: bots.filter((b) => b.data.status !== 'active').length,
      },
      users: bots.reduce((n, b) => n + (b.data.usersCount ?? 0), 0),
      days,
      errorGroups: errors,
      recentEvents: recent.map((r) => ({ id: r.id, action: r.data['action'], botId: r.data['botId'], at: r.data['at'], actor: r.data['actor'] })),
      telegramIssues: bots.filter((b) => (b.data.telegram?.issues.length ?? 0) > 0).map((b) => ({ botId: b.id, issues: b.data.telegram!.issues })),
      storage: { driver: this.store.kind, indexes: indexStatus },
    };
  }

  async users(actor: AdminActor, botId: string, opts: { state?: string | null; access?: string | null; before?: string | null }) {
    requirePermission(actor, botId, 'users.view');
    return this.userRows(actor, [botId], opts);
  }

  /**
   * Users of every bot the admin may see (or one bot). Columns: Telegram ID, bot,
   * Trader ID, registration date, onboarding, verification and deposit status.
   */
  async allUsers(actor: AdminActor, opts: { botId?: string | null; state?: string | null; access?: string | null; before?: string | null }) {
    if (opts.botId) return this.users(actor, opts.botId, opts);
    const bots = (await this.store.query<BotRecord>(C.bots, {})).map((b) => b.id).filter((id) => can(actor, id, 'users.view'));
    if (!bots.length) return { users: [], nextBefore: null };
    return this.userRows(actor, actor.role === 'owner' ? null : bots.slice(0, 30), opts);
  }

  private async userRows(actor: AdminActor, botIds: string[] | null, opts: { state?: string | null; access?: string | null; before?: string | null }) {
    const where: Filter[] = [];
    if (botIds) where.push(botIds.length === 1 ? { field: 'botId', op: '==', value: botIds[0]! } : { field: 'botId', op: 'in', value: botIds });
    if (opts.state) {
      if (!(BINDING_STATES as readonly string[]).includes(opts.state)) throw new AppError('VALIDATION_FAILED', 'unknown state');
      where.push({ field: 'bindingState', op: '==', value: opts.state });
    }
    if (opts.access) {
      if (opts.access !== 'manual') throw new AppError('VALIDATION_FAILED', 'unknown access filter');
      where.push({ field: 'manualAccessActive', op: '==', value: true });
    }
    if (opts.before) where.push({ field: 'createdAt', op: '<', value: opts.before });
    const rows = await this.store.query<UserRecord>(C.users, { where, orderBy: { field: 'createdAt', direction: 'desc' }, limit: 50 });
    return { users: await this.rowsFor(actor, rows), nextBefore: rows.length === 50 ? rows[rows.length - 1]!.data.createdAt : null };
  }

  /** Admin view of user records: the same statuses in the list and in the user card. */
  private async rowsFor(actor: AdminActor, rows: { id: string; data: UserRecord }[]) {
    const { requireFtd } = await this.platform.signals();
    const configs = new Map<string, BotConfigRecord | null>();
    const configOf = async (id: string) => {
      if (!configs.has(id)) {
        const c = await this.store.get<BotConfigRecord>(C.botConfigs, id);
        configs.set(id, c ? upgradeBotConfig(c) : null);
      }
      return configs.get(id) ?? null;
    };
    // Latest click_id of every user on the page (one query per 30 users; ids are not secrets, the partner sees them anyway).
    const clickOf = new Map<string, { id: string; at: string }>();
    const ids = rows.map((r) => r.id);
    for (let i = 0; i < ids.length; i += 30) {
      const chunk = ids.slice(i, i + 30);
      const clicks = await this.store.query<{ userDocId: string; createdAt: string; lastClickAt?: string | null }>(C.clickTokens, { where: [{ field: 'userDocId', op: 'in', value: chunk }], limit: 300 });
      for (const c of clicks) {
        const at = c.data.lastClickAt ?? c.data.createdAt;
        const prev = clickOf.get(c.data.userDocId);
        if (!prev || at > prev.at) clickOf.set(c.data.userDocId, { id: c.id, at });
      }
    }
    const out = [];
    for (const { id: userDocId, data: u } of rows) {
      const cfg = await configOf(u.botId);
      const check = depositCheck(u.deposit ?? null);
      const status = onboardingStatus(u, check.status, requireFtd);
      out.push({
        botId: u.botId,
        botName: cfg?.name ?? u.botId,
        telegramId: u.telegramId,
        username: u.username,
        firstName: u.firstName,
        languageCode: u.languageCode,
        createdAt: u.createdAt,
        lastSeenAt: u.lastSeenAt,
        launches: u.launches,
        bindingState: u.bindingState,
        onboardingStatus: status,
        verification:
          u.bindingState === 'account_bound'
            ? 'confirmed'
            : u.bindingState === 'manual_review' || u.bindingState === 'binding_conflict'
              ? 'review'
              : u.lastBindingError
                ? 'failed'
                : 'not_submitted',
        lastBindingError: u.traderId ? null : (u.lastBindingError?.code ?? null),
        depositCheck: check.status,
        // Full Trader ID only for admins who manage bindings of this bot.
        traderId: u.traderId ? (can(actor, u.botId, 'binding.manage') ? u.traderId : maskTraderId(u.traderId)) : (u.submittedTraderIdMasked ?? null),
        traderIdMasked: u.traderId ? maskTraderId(u.traderId) : (u.submittedTraderIdMasked ?? null),
        registrationStartedAt: u.registrationStartedAt ?? null,
        deposit: u.deposit ? { status: u.deposit.status, ftdAmount: u.deposit.ftdAmount, ftdCurrency: u.deposit.ftdCurrency, ftdAt: u.deposit.ftdAt, depositsCount: u.deposit.depositsCount, totalAmount: u.deposit.totalAmount ?? null } : null,
        clickId: clickOf.get(userDocId)?.id ?? null,
        // Partner registration: confirmed (Trader ID linked) · link opened · not started.
        registrationStatus: u.traderId ? 'confirmed' : u.registrationStartedAt ? 'started' : 'not_started',
        accessStatus: accessStatus(u, status, check.status),
        access: accessView(u),
        manualAccessActive: u.manualAccess?.active === true,
        canManage: can(actor, u.botId, 'binding.manage'),
      });
    }
    return out;
  }

  /**
   * One user, for the admin user card: every status, manual access (who / when / why) and
   * the last manual admin action on this user. No secrets, full Trader ID only with binding.manage.
   */
  async userCard(actor: AdminActor, botId: string, telegramId: number) {
    if (!can(actor, botId, 'users.view')) throw new AppError('FORBIDDEN');
    if (!Number.isSafeInteger(telegramId) || telegramId <= 0) throw new AppError('NOT_FOUND');
    const scope = new TenantScope(botId);
    const uid = scope.userDocId(telegramId);
    const u = await this.store.get<UserRecord>(C.users, uid);
    if (!u || !scope.owns(u)) throw new AppError('NOT_FOUND', 'user not found');
    const row = (await this.rowsFor(actor, [{ id: uid, data: u }]))[0]!;
    const audit = (await this.store.query<{ botId: string; action: string; actor: { type: string; id: string }; reason: string | null; at: string }>(C.auditLogs, {
      where: [{ field: 'target', op: '==', value: uid }],
      limit: 200,
    }))
      .map((a) => a.data)
      .filter((a) => a.botId === botId && a.actor.type === 'admin' && MANUAL_ACTIONS.includes(a.action))
      .sort((a, b) => (a.at < b.at ? 1 : -1));
    const emails = new Map<string, string>();
    const emailOf = async (adminUid: string | null | undefined) => {
      if (!adminUid) return null;
      if (!emails.has(adminUid)) emails.set(adminUid, (await this.store.get<{ email: string }>(C.adminUsers, adminUid))?.email ?? adminUid);
      return emails.get(adminUid)!;
    };
    const m = u.manualAccess ?? null;
    const last = audit[0] ?? null;
    return {
      ...row,
      lastName: u.lastName,
      bindingUpdatedAt: u.bindingUpdatedAt,
      onboardingCompletedAt: u.onboardingCompletedAt ?? null,
      manualAccess: m
        ? {
            active: m.active,
            grantedAt: m.grantedAt,
            grantedBy: await emailOf(m.grantedBy),
            grantReason: m.grantReason,
            revokedAt: m.revokedAt,
            revokedBy: await emailOf(m.revokedBy),
            revokeReason: m.revokeReason,
          }
        : null,
      lastManualAction: last ? { action: last.action, at: last.at, by: await emailOf(last.actor.id), reason: last.reason } : null,
    };
  }

  /** System parameters for the Settings page (no secrets, only whether they are set). */
  system(actor: AdminActor, indexStatus: unknown) {
    requireOwner(actor);
    return {
      nodeVersion: process.version,
      environment: this.env.NODE_ENV,
      publicUrl: this.env.PUBLIC_URL,
      storage: this.store.kind,
      indexes: indexStatus,
      languages: LANGUAGES,
      encryptionKeyId: this.env.ENCRYPTION_KEY_ID,
      previousKeyConfigured: Boolean(this.env.ENCRYPTION_KEY_PREVIOUS),
      sessionTtlSec: this.env.SESSION_TTL_SEC,
      adminSessionTtlSec: this.env.ADMIN_SESSION_TTL_SEC,
      initDataMaxAgeSec: this.env.INIT_DATA_MAX_AGE_SEC,
      corsOrigins: this.env.CORS_ORIGINS ? this.env.CORS_ORIGINS.split(',').map((v) => v.trim()).filter(Boolean) : [],
      signalEngine: 'training',
      marketData: 'not_connected',
    };
  }

  async stats(actor: AdminActor, botId: string, days = 14): Promise<DailyPoint[]> {
    requirePermission(actor, botId, 'stats.view');
    const n = Math.min(Math.max(days, 1), 90);
    const since = isoDay(new Date(this.now().getTime() - (n - 1) * DAY));
    const rows = await this.store.query<Record<string, unknown>>(C.botStatsDaily, {
      where: [{ field: 'botId', op: '==', value: botId }, { field: 'day', op: '>=', value: since }],
      orderBy: { field: 'day', direction: 'desc' },
    });
    const byDay = new Map(rows.map((r) => [String(r.data['day']), r.data]));
    const out: DailyPoint[] = [];
    for (let i = n - 1; i >= 0; i--) {
      const day = isoDay(new Date(this.now().getTime() - i * DAY));
      const d = byDay.get(day) ?? {};
      const metrics: Record<string, number> = {};
      for (const [k, v] of Object.entries(d)) if (k.startsWith('m_') && typeof v === 'number') metrics[k.slice(2)] = v;
      out.push({ day, metrics });
    }
    return out;
  }

  async logs(actor: AdminActor, botId: string, type: string) {
    requirePermission(actor, botId, 'logs.view');
    if (type === 'errors') {
      const rows = await this.store.query<Record<string, unknown>>(C.errorLogs, { where: [{ field: 'botId', op: '==', value: botId }], orderBy: { field: 'lastSeenAt', direction: 'desc' }, limit: 100 });
      return rows.map((r) => ({ id: r.id, ...r.data }));
    }
    if (type === 'audit') {
      const rows = await this.store.query<Record<string, unknown>>(C.auditLogs, { where: [{ field: 'botId', op: '==', value: botId }], orderBy: { field: 'at', direction: 'desc' }, limit: 100 });
      return rows.map((r) => ({ id: r.id, ...r.data }));
    }
    throw new AppError('VALIDATION_FAILED', 'type must be errors or audit');
  }

  /** Users waiting for a human decision, with their Trader ID claims (masked). */
  async reviewQueue(actor: AdminActor, botId: string) {
    requirePermission(actor, botId, 'binding.manage');
    const rows = await this.store.query<UserRecord>(C.users, {
      where: [{ field: 'botId', op: '==', value: botId }, { field: 'bindingState', op: 'in', value: ['manual_review', 'binding_conflict'] satisfies BindingState[] }],
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: 100,
    });
    const out = [];
    for (const { id, data: u } of rows) {
      const claims = await this.store.query<ClaimRecord>(C.bindingClaims, { where: [{ field: 'botId', op: '==', value: botId }, { field: 'userDocId', op: '==', value: id }] });
      out.push({
        telegramId: u.telegramId,
        username: u.username,
        firstName: u.firstName,
        state: u.bindingState,
        since: u.bindingUpdatedAt,
        claims: claims.map((c) => ({ traderId: c.data.traderIdNorm, status: c.data.status, updatedAt: c.data.updatedAt })),
      });
    }
    return out;
  }

  // ───────── postback history & integration errors ─────────

  /**
   * Registrations and deposits as received from the partner (history of the global
   * postback and of any per-bot source). Owner: every bot; manager: bots with users.view.
   */
  async postbackEvents(actor: AdminActor, opts: { botId?: string | null; type?: string | null; before?: string | null }) {
    const visible = (await this.store.query<BotRecord>(C.bots, {})).map((b) => b.id).filter((id) => can(actor, id, 'users.view'));
    if (opts.botId && !visible.includes(opts.botId)) throw new AppError('FORBIDDEN', 'missing permission');
    const where: Filter[] = [];
    if (opts.botId) where.push({ field: 'botId', op: '==', value: opts.botId });
    else if (actor.role !== 'owner') {
      if (!visible.length) return { events: [], nextBefore: null };
      where.push({ field: 'botId', op: 'in', value: visible.slice(0, 30) });
    }
    if (opts.type) {
      if (!(POSTBACK_EVENT_TYPES as readonly string[]).includes(opts.type)) throw new AppError('VALIDATION_FAILED', 'unknown event type');
      where.push({ field: 'eventType', op: '==', value: opts.type });
    }
    if (opts.before) where.push({ field: 'receivedAt', op: '<', value: opts.before });
    const rows = await this.store.query<PostbackEventRecord>(C.postbackEvents, { where, orderBy: { field: 'receivedAt', direction: 'desc' }, limit: 50 });
    const names = new Map<string, string>();
    const nameOf = async (id: string) => {
      if (!names.has(id)) names.set(id, (await this.store.get<BotConfigRecord>(C.botConfigs, id))?.name ?? id);
      return names.get(id)!;
    };
    const tg = (userDocId: string | null | undefined) => (userDocId ? Number(userDocId.slice(userDocId.lastIndexOf('_') + 1)) || null : null);
    const events = [];
    for (const { id, data: e } of rows) {
      events.push({
        id,
        botId: e.botId,
        botName: e.botId === GLOBAL_LOG_BOT_ID ? '—' : await nameOf(e.botId),
        sourceId: e.sourceId,
        global: e.globalSource === true,
        eventType: e.eventType,
        rawEventType: e.rawEventType,
        traderId: can(actor, e.botId, 'binding.manage') ? e.traderIdNorm : maskTraderId(e.traderIdNorm),
        clickId: e.clickId ? `${e.clickId.slice(0, 6)}…` : null,
        clickTelegramId: tg(e.clickUserDocId),
        matchStatus: e.matchStatus,
        matchedTelegramId: tg(e.matchedUserDocId),
        amount: e.amount ?? null,
        currency: e.currency ?? null,
        deliveryCount: e.deliveryCount,
        conflictingDelivery: e.conflictingDelivery ?? null,
        possibleDuplicate: Boolean(e.possibleDuplicateOf),
        diagnosis: e.diagnosis ?? null,
        routedBy: e.routedBy ?? null,
        excluded: e.excluded ? { at: e.excluded.at, reason: e.excluded.reason } : null,
        canExclude: (e.eventType === 'ftd' || e.eventType === 'redeposit') && can(actor, e.botId, 'binding.manage'),
        receivedAt: e.receivedAt,
      });
    }
    return { events, nextBefore: rows.length === 50 ? rows[rows.length - 1]!.data.receivedAt : null };
  }

  /** Postback integration errors (owner): rejected requests of every source, newest first. */
  async integrationErrors(actor: AdminActor) {
    requireOwner(actor);
    const rows = await this.store.query<Record<string, unknown>>(C.errorLogs, {
      where: [{ field: 'module', op: '==', value: 'postback' }],
      orderBy: { field: 'lastSeenAt', direction: 'desc' },
      limit: 100,
    });
    return rows.map((r) => ({ id: r.id, ...r.data, global: r.data['botId'] === GLOBAL_LOG_BOT_ID }));
  }

  /** Every postback source of the platform (owner): the global one and any former per-bot sources. */
  async allSources(actor: AdminActor) {
    requireOwner(actor);
    const rows = await this.store.query<PartnerSource & Record<string, unknown>>(C.partnerSources, {});
    return rows.map(({ data: s }) => ({ ...this.sourceView(s), botId: s.botId === GLOBAL_SOURCE_BOT_ID ? null : s.botId }));
  }

  // ───────── partner postback sources (owner only) ─────────

  async updateSourceById(actor: AdminActor, sourceId: string, raw: unknown) {
    requireOwner(actor);
    const src = await this.store.get<PartnerSource & Record<string, unknown>>(C.partnerSources, sourceId);
    if (!src) throw new AppError('NOT_FOUND');
    return this.updateSource(actor, src.botId, sourceId, raw);
  }

  private sourceView(s: PartnerSource) {
    return {
      id: s.id,
      scope: s.botId === '*' ? 'global' : 'bot',
      name: s.name,
      enabled: s.enabled,
      authMethod: s.auth.method,
      authLocation: s.auth.method === 'shared_secret' ? `${s.auth.location}:${s.auth.name}` : `header:${s.auth.signatureHeader}`,
      ipAllowlist: s.ipAllowlist,
      mapping: s.mapping,
      eventTypeMap: s.eventTypeMap,
      postbackUrl: `${this.env.PUBLIC_URL}/postback/${s.id}`,
    };
  }

  async createSource(actor: AdminActor, botId: string, raw: unknown) {
    requireOwner(actor);
    const input = parseSourceInput(raw);
    const sourceBotId = input.global ? '*' : botId;
    if (input.global) {
      const existingGlobal = await this.store.query(C.partnerSources, { where: [{ field: 'botId', op: '==', value: '*' }], limit: 1 });
      if (existingGlobal.length) throw new AppError('VALIDATION_FAILED', 'a global postback source already exists; edit it instead of creating another');
    }
    const id = `src-${randomBytes(5).toString('hex')}`;
    const secret = randomBytes(24).toString('hex');
    const secretEnc = this.box.encrypt(secret, secretAad(id));
    const source: PartnerSource = {
      id,
      botId: sourceBotId,
      name: input.name,
      enabled: true,
      auth: input.authMethod === 'hmac_sha256'
        ? { method: 'hmac_sha256', signatureHeader: input.authName || 'x-signature', secretEnc }
        : { method: 'shared_secret', location: input.authMethod === 'secret_header' ? 'header' : 'query', name: input.authName || 'token', secretEnc },
      ipAllowlist: input.ipAllowlist,
      mapping: input.mapping,
      eventTypeMap: input.eventTypeMap,
    };
    await this.store.runTransaction(async (tx) => {
      if (sourceBotId !== '*') {
        const bot = await tx.get(C.bots, botId);
        if (!bot) throw new AppError('NOT_FOUND');
      }
      tx.create(C.partnerSources, id, source as unknown as Record<string, unknown>);
      writeAudit(tx, { botId: sourceBotId, actor: { type: 'admin', id: actor.uid }, action: 'source.created', target: id, after: { name: input.name, authMethod: input.authMethod, scope: sourceBotId === '*' ? 'global' : 'bot' } }, this.now());
    });
    // The secret is returned exactly once so the owner can give it to the partner program.
    return { source: this.sourceView(source), secret };
  }

  async updateSource(actor: AdminActor, botId: string, sourceId: string, raw: unknown) {
    requireOwner(actor);
    const body = raw as { enabled?: unknown; name?: unknown; mapping?: unknown; eventTypeMap?: unknown; ipAllowlist?: unknown; rotateSecret?: unknown };
    let secret: string | null = null;
    const updated = await this.store.runTransaction(async (tx) => {
      const s = await tx.get<PartnerSource & Record<string, unknown>>(C.partnerSources, sourceId);
      if (!s || (s.botId !== botId && s.botId !== '*')) throw new AppError('NOT_FOUND');
      const patch: Record<string, unknown> = {};
      if (body.enabled !== undefined) patch['enabled'] = Boolean(body.enabled);
      if (body.name !== undefined || body.mapping !== undefined || body.eventTypeMap !== undefined || body.ipAllowlist !== undefined) {
        const merged = parseSourceInput({
          name: body.name ?? s.name,
          authMethod: s.auth.method === 'hmac_sha256' ? 'hmac_sha256' : s.auth.location === 'header' ? 'secret_header' : 'secret_query',
          authName: s.auth.method === 'hmac_sha256' ? s.auth.signatureHeader : s.auth.name,
          mapping: body.mapping ?? s.mapping,
          eventTypeMap: body.eventTypeMap ?? s.eventTypeMap,
          ipAllowlist: body.ipAllowlist ?? s.ipAllowlist,
          global: s.botId === '*',
        });
        Object.assign(patch, { name: merged.name, mapping: merged.mapping, eventTypeMap: merged.eventTypeMap, ipAllowlist: merged.ipAllowlist });
      }
      if (body.rotateSecret === true) {
        secret = randomBytes(24).toString('hex');
        patch['auth'] = { ...s.auth, secretEnc: this.box.encrypt(secret, secretAad(sourceId)) };
      }
      tx.update(C.partnerSources, sourceId, patch);
      writeAudit(tx, { botId, actor: { type: 'admin', id: actor.uid }, action: body.rotateSecret ? 'source.secret_rotated' : 'source.updated', target: sourceId, after: { ...patch, auth: undefined } }, this.now());
      return { ...s, ...patch } as PartnerSource;
    });
    return { source: this.sourceView(updated), secret };
  }
}

interface SourceInput {
  name: string;
  authMethod: 'secret_query' | 'secret_header' | 'hmac_sha256';
  authName: string;
  ipAllowlist: string[];
  mapping: PartnerSource['mapping'];
  eventTypeMap: PartnerSource['eventTypeMap'];
  global: boolean;
}

function parseSourceInput(raw: unknown): SourceInput {
  const b = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number, re = /^[A-Za-z0-9_.-]+$/) => (typeof v === 'string' && v.length <= max && (v === '' || re.test(v)) ? v : null);
  const name = typeof b['name'] === 'string' ? b['name'].trim().slice(0, 80) : '';
  const global = b['global'] === true;
  if (!name) throw new AppError('VALIDATION_FAILED', 'name is required');
  const authMethod = b['authMethod'];
  if (authMethod !== 'secret_query' && authMethod !== 'secret_header' && authMethod !== 'hmac_sha256') throw new AppError('VALIDATION_FAILED', 'authMethod invalid');
  const authName = str(b['authName'] ?? '', 64) ?? (() => { throw new AppError('VALIDATION_FAILED', 'authName invalid'); })();
  const m = (b['mapping'] ?? {}) as Record<string, unknown>;
  const field = (k: string, required: boolean) => {
    const v = str(m[k] ?? '', 64);
    if (v === null || (required && !v)) throw new AppError('VALIDATION_FAILED', `mapping.${k} invalid`);
    return v || null;
  };
  const mapping = { eventId: field('eventId', false), eventType: field('eventType', true)!, traderId: field('traderId', true)!, clickId: field('clickId', false), occurredAt: field('occurredAt', false), amount: field('amount', false), currency: field('currency', false), partnerId: field('partnerId', false) };
  const etm = (b['eventTypeMap'] ?? {}) as Record<string, unknown>;
  const eventTypeMap: PartnerSource['eventTypeMap'] = {};
  for (const [k, v] of Object.entries(etm)) {
    if (!str(k, 64) || !(POSTBACK_EVENT_TYPES as readonly string[]).includes(String(v))) throw new AppError('VALIDATION_FAILED', 'eventTypeMap invalid');
    eventTypeMap[k] = v as PartnerSource['eventTypeMap'][string];
  }
  if (!Object.values(eventTypeMap).includes('registration')) throw new AppError('VALIDATION_FAILED', 'eventTypeMap must map at least one event to "registration"');
  const ips = Array.isArray(b['ipAllowlist']) ? b['ipAllowlist'].map(String) : [];
  if (ips.length > 50 || ips.some((ip) => !/^[0-9a-fA-F:.]{3,45}$/.test(ip))) throw new AppError('VALIDATION_FAILED', 'ipAllowlist invalid');
  if (global && !Object.values(eventTypeMap).includes('ftd')) {
    throw new AppError('VALIDATION_FAILED', 'global source must map the first-deposit (FTD) event');
  }
  if (global && !mapping.clickId) throw new AppError('VALIDATION_FAILED', 'global source requires click_id mapping');
  return { name, authMethod, authName, ipAllowlist: ips, mapping, eventTypeMap, global };
}

/** Admin actions on one user that the user card reports as "last manual action". */
const MANUAL_ACTIONS = [
  'access.manual_grant', 'access.manual_revoke', 'onboarding.set_step', 'finance.deposit_recheck',
  'binding.admin_bind', 'binding.rebind', 'binding.unbind', 'binding.release',
];

/**
 * One status for the admin list: normal access first, then manual access, then the onboarding step.
 *  confirmed · manual · revoked · needs_review · checking · awaiting_deposit · awaiting_trader_id · awaiting_registration
 */
export function accessStatus(u: UserRecord, status: OnboardingStatus, check: DepositCheckStatus): string {
  if (u.onboardingCompletedAt || status === 'completed') return 'confirmed';
  if (u.manualAccess?.active) return 'manual';
  if (u.manualAccess && !u.manualAccess.active) return 'revoked';
  if (status === 'needs_support') return 'needs_review';
  if (status === 'deposit') return check === 'checking' ? 'checking' : check === 'error' ? 'needs_review' : 'awaiting_deposit';
  if (status === 'trader_id') return 'awaiting_trader_id';
  return 'awaiting_registration';
}
