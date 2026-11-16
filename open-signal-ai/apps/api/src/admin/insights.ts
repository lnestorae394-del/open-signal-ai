import { randomBytes } from 'node:crypto';
import { BINDING_STATES, POSTBACK_EVENT_TYPES, type BindingState, type PartnerSource } from '@open-signal/shared';
import type { Env } from '../config/env.ts';
import { AppError } from '../lib/errors.ts';
import type { SecretBox } from '../lib/crypto.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore, Filter } from '../storage/types.ts';
import { writeAudit } from '../domain/audit.ts';
import type { BotRecord, UserRecord } from '../domain/records.ts';
import { secretAad } from '../binding/postback.ts';
import { maskTraderId, type ClaimRecord } from '../binding/service.ts';
import { canSeeBot, requireOwner, requirePermission, type AdminActor } from './auth.ts';

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

  constructor(deps: { store: DocumentStore; box: SecretBox; env: Env; now: () => Date }) {
    this.store = deps.store;
    this.box = deps.box;
    this.env = deps.env;
    this.now = deps.now;
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

  async users(actor: AdminActor, botId: string, opts: { state?: string | null; before?: string | null }) {
    requirePermission(actor, botId, 'users.view');
    const where: Filter[] = [{ field: 'botId', op: '==', value: botId }];
    if (opts.state) {
      if (!(BINDING_STATES as readonly string[]).includes(opts.state)) throw new AppError('VALIDATION_FAILED', 'unknown state');
      where.push({ field: 'bindingState', op: '==', value: opts.state });
    }
    if (opts.before) where.push({ field: 'createdAt', op: '<', value: opts.before });
    const rows = await this.store.query<UserRecord>(C.users, { where, orderBy: { field: 'createdAt', direction: 'desc' }, limit: 50 });
    return {
      users: rows.map(({ data: u }) => ({
        telegramId: u.telegramId,
        username: u.username,
        firstName: u.firstName,
        languageCode: u.languageCode,
        createdAt: u.createdAt,
        lastSeenAt: u.lastSeenAt,
        launches: u.launches,
        bindingState: u.bindingState,
        traderIdMasked: u.traderId ? maskTraderId(u.traderId) : null,
      })),
      nextBefore: rows.length === 50 ? rows[rows.length - 1]!.data.createdAt : null,
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

  // ───────── partner postback sources (owner only) ─────────

  async listSources(actor: AdminActor, botId: string) {
    requireOwner(actor);
    const rows = await this.store.query<PartnerSource & Record<string, unknown>>(C.partnerSources, { where: [{ field: 'botId', op: '==', value: botId }] });
    return rows.map(({ data: s }) => this.sourceView(s));
  }

  private sourceView(s: PartnerSource) {
    return {
      id: s.id,
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
    const id = `src-${randomBytes(5).toString('hex')}`;
    const secret = randomBytes(24).toString('hex');
    const secretEnc = this.box.encrypt(secret, secretAad(id));
    const source: PartnerSource = {
      id,
      botId,
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
      const bot = await tx.get(C.bots, botId);
      if (!bot) throw new AppError('NOT_FOUND');
      tx.create(C.partnerSources, id, source as unknown as Record<string, unknown>);
      writeAudit(tx, { botId, actor: { type: 'admin', id: actor.uid }, action: 'source.created', target: id, after: { name: input.name, authMethod: input.authMethod } }, this.now());
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
      if (!s || s.botId !== botId) throw new AppError('NOT_FOUND');
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
}

function parseSourceInput(raw: unknown): SourceInput {
  const b = (raw ?? {}) as Record<string, unknown>;
  const str = (v: unknown, max: number, re = /^[A-Za-z0-9_.-]+$/) => (typeof v === 'string' && v.length <= max && (v === '' || re.test(v)) ? v : null);
  const name = typeof b['name'] === 'string' ? b['name'].trim().slice(0, 80) : '';
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
  const mapping = { eventId: field('eventId', false), eventType: field('eventType', true)!, traderId: field('traderId', true)!, clickId: field('clickId', false), occurredAt: field('occurredAt', false) };
  const etm = (b['eventTypeMap'] ?? {}) as Record<string, unknown>;
  const eventTypeMap: PartnerSource['eventTypeMap'] = {};
  for (const [k, v] of Object.entries(etm)) {
    if (!str(k, 64) || !(POSTBACK_EVENT_TYPES as readonly string[]).includes(String(v))) throw new AppError('VALIDATION_FAILED', 'eventTypeMap invalid');
    eventTypeMap[k] = v as PartnerSource['eventTypeMap'][string];
  }
  if (!Object.values(eventTypeMap).includes('registration')) throw new AppError('VALIDATION_FAILED', 'eventTypeMap must map at least one event to "registration"');
  const ips = Array.isArray(b['ipAllowlist']) ? b['ipAllowlist'].map(String) : [];
  if (ips.length > 50 || ips.some((ip) => !/^[0-9a-fA-F:.]{3,45}$/.test(ip))) throw new AppError('VALIDATION_FAILED', 'ipAllowlist invalid');
  return { name, authMethod, authName, ipAllowlist: ips, mapping, eventTypeMap };
}
