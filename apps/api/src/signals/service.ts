import { hasSignalAccess } from '../binding/access.ts';
import { randomBytes } from 'node:crypto';
import { FOREX_INSTRUMENTS, OTC_INSTRUMENTS, type SignalCategory, type SignalEngineKind, type SignalSettings } from '@open-signal/shared';
import { AppError } from '../lib/errors.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import type { StatsBuffer } from '../domain/observability.ts';
import type { UserRecord } from '../domain/records.ts';
import type { TenantScope } from '../domain/tenant.ts';
import type { PlatformSettings } from '../platform/settings.ts';
import type { SignalEngine } from './engine.ts';

export interface SignalRecord {
  [k: string]: unknown;
  botId: string;
  userDocId: string;
  instrumentId: string;
  category: SignalCategory;
  periodSec: number;
  direction: 'buy' | 'sell';
  engine: SignalEngineKind;
  createdAt: string;
  /** Moment the user pressed "I opened the trade" (server time). */
  openedAt: string | null;
  expiresAt: string | null;
}

export interface SignalView {
  id: string;
  instrumentId: string;
  category: SignalCategory;
  periodSec: number;
  direction: 'buy' | 'sell';
  engine: SignalEngineKind;
  createdAt: string;
  openedAt: string | null;
  expiresAt: string | null;
  status: 'issued' | 'open' | 'completed';
}

export interface SignalConfigView {
  engine: SignalEngineKind;
  categories: { id: SignalCategory; instruments: string[] }[];
  periods: number[];
  defaultPeriod: number;
  cooldownSec: number;
}

const categoryOf = (id: string, s: SignalSettings): SignalCategory | null =>
  s.forexInstruments.includes(id) && FOREX_INSTRUMENTS.some((i) => i.id === id)
    ? 'forex'
    : s.otcInstruments.includes(id) && OTC_INSTRUMENTS.some((i) => i.id === id)
      ? 'otc'
      : null;

/** One signal system for every bot; records are still stored per bot and per user. */
export class SignalService {
  private readonly d: { store: DocumentStore; settings: PlatformSettings; engine: SignalEngine; stats: StatsBuffer; now: () => Date };

  constructor(deps: { store: DocumentStore; settings: PlatformSettings; engine: SignalEngine; stats: StatsBuffer; now: () => Date }) {
    this.d = deps;
  }

  async config(): Promise<SignalConfigView> {
    const s = await this.d.settings.signals();
    return {
      engine: this.d.engine.kind,
      categories: [
        { id: 'forex' as const, instruments: s.forexInstruments },
        { id: 'otc' as const, instruments: s.otcInstruments },
      ].filter((c) => c.instruments.length > 0),
      periods: s.periods,
      defaultPeriod: s.defaultPeriod,
      cooldownSec: s.cooldownSec,
    };
  }

  /** Signals are available only after onboarding or with manual access from an admin (server-side check, not a UI flag). */
  private requireOnboarded(user: UserRecord): void {
    if (!hasSignalAccess(user)) throw new AppError('ONBOARDING_REQUIRED');
  }

  async issue(scope: TenantScope, user: UserRecord, raw: { instrumentId?: unknown; periodSec?: unknown }): Promise<SignalView> {
    this.requireOnboarded(user);
    const s = await this.d.settings.signals();
    const instrumentId = typeof raw.instrumentId === 'string' ? raw.instrumentId : '';
    const periodSec = typeof raw.periodSec === 'number' ? raw.periodSec : NaN;
    const category = categoryOf(instrumentId, s);
    if (!category) throw new AppError('BAD_REQUEST', 'unknown instrument');
    if (!s.periods.includes(periodSec)) throw new AppError('BAD_REQUEST', 'unsupported period');

    const uid = scope.userDocId(user.telegramId);
    const now = this.d.now();
    const dayStart = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate())).toISOString();
    const today = await this.d.store.query<SignalRecord>(C.signals, {
      where: scope.where({ field: 'userDocId', op: '==', value: uid }, { field: 'createdAt', op: '>=', value: dayStart }),
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: s.maxPerDay + 1,
    });
    const last = today[0]?.data;
    if (last) {
      const wait = Math.ceil((Date.parse(last.createdAt) + s.cooldownSec * 1000 - now.getTime()) / 1000);
      if (wait > 0) throw new AppError('SIGNAL_COOLDOWN', 'wait before the next signal', { retryAfterSec: wait });
    }
    if (today.length >= s.maxPerDay) throw new AppError('SIGNAL_LIMIT');

    const decision = await this.d.engine.decide({ instrumentId, category, periodSec });
    const id = `${now.getTime().toString(36)}${randomBytes(5).toString('hex')}`;
    const record: SignalRecord = scope.stamp({
      userDocId: uid,
      instrumentId,
      category,
      periodSec,
      direction: decision.direction,
      engine: this.d.engine.kind,
      createdAt: now.toISOString(),
      openedAt: null,
      expiresAt: null,
    });
    await this.d.store.create(C.signals, id, record);
    this.d.stats.incr(scope.botId, 'signals_issued');
    return this.view(id, record);
  }

  /** "I opened the trade": fixes the moment once; the countdown is derived from it. */
  async open(scope: TenantScope, user: UserRecord, signalId: string): Promise<SignalView> {
    this.requireOnboarded(user);
    const uid = scope.userDocId(user.telegramId);
    const nowIso = this.d.now().toISOString();
    const rec = await this.d.store.runTransaction(async (tx) => {
      const r = await tx.get<SignalRecord>(C.signals, signalId);
      if (!r || !scope.owns(r) || r.userDocId !== uid) throw new AppError('NOT_FOUND');
      if (r.openedAt) return r; // idempotent
      const expiresAt = new Date(Date.parse(nowIso) + r.periodSec * 1000).toISOString();
      tx.update(C.signals, signalId, { openedAt: nowIso, expiresAt });
      return { ...r, openedAt: nowIso, expiresAt };
    });
    if (rec.openedAt === nowIso) this.d.stats.incr(scope.botId, 'signals_opened');
    return this.view(signalId, rec);
  }

  async list(scope: TenantScope, user: UserRecord, limit = 20): Promise<SignalView[]> {
    const rows = await this.d.store.query<SignalRecord>(C.signals, {
      where: scope.where({ field: 'userDocId', op: '==', value: scope.userDocId(user.telegramId) }),
      orderBy: { field: 'createdAt', direction: 'desc' },
      limit: Math.min(Math.max(limit, 1), 50),
    });
    return rows.map((r) => this.view(r.id, r.data));
  }

  private view(id: string, r: SignalRecord): SignalView {
    const now = this.d.now().getTime();
    const status = !r.openedAt ? 'issued' : r.expiresAt && Date.parse(r.expiresAt) <= now ? 'completed' : 'open';
    return {
      id,
      instrumentId: r.instrumentId,
      category: r.category,
      periodSec: r.periodSec,
      direction: r.direction,
      engine: r.engine,
      createdAt: r.createdAt,
      openedAt: r.openedAt,
      expiresAt: r.expiresAt,
      status,
    };
  }
}
