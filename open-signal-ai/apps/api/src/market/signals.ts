import { randomBytes } from 'node:crypto';
import { MARKET_MODES, type MarketMode, type MarketSettings } from '@open-signal/shared';
import { rsi, sma } from '@open-signal/indicators';
import { AppError } from '../lib/errors.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import type { StatsBuffer } from '../domain/observability.ts';
import type { TenantScope } from '../domain/tenant.ts';
import type { MarketContext, MarketDataSource, SimParams } from './source.ts';

export type SignalDirection = 'up' | 'down';
export type SignalOutcome = 'open' | 'win' | 'loss' | 'draw';
export type SignalBasis = 'rsi_oversold' | 'rsi_overbought' | 'above_average' | 'below_average';

/** simulation_history/{id} — one demo signal of one user. */
export interface DemoSignalRecord {
  [k: string]: unknown;
  botId: string;
  userDocId: string;
  mode: MarketMode;
  instrumentId: string;
  direction: SignalDirection;
  basis: SignalBasis;
  rsi: number | null;
  periodSec: number;
  entryPrice: number;
  entryAt: string;
  expiresAt: string;
  outcome: SignalOutcome;
  exitPrice: number | null;
  resolvedAt: string | null;
  /** Data source that produced the prices. "simulation" = synthetic, never a real quote. */
  sourceId: string;
  simulated: boolean;
  sim: SimParams;
}

export interface SignalView {
  id: string;
  mode: MarketMode;
  instrumentId: string;
  direction: SignalDirection;
  basis: SignalBasis;
  rsi: number | null;
  periodSec: number;
  entryPrice: number;
  entryAt: string;
  expiresAt: string;
  outcome: SignalOutcome;
  exitPrice: number | null;
  simulated: boolean;
}

export interface SignalStats {
  total: number;
  open: number;
  win: number;
  loss: number;
  draw: number;
}

const DAY = 86_400_000;

const view = (id: string, r: DemoSignalRecord): SignalView => ({
  id,
  mode: r.mode,
  instrumentId: r.instrumentId,
  direction: r.direction,
  basis: r.basis,
  rsi: r.rsi,
  periodSec: r.periodSec,
  entryPrice: r.entryPrice,
  entryAt: r.entryAt,
  expiresAt: r.expiresAt,
  outcome: r.outcome,
  exitPrice: r.exitPrice,
  simulated: r.simulated,
});

/**
 * Demo signals in SIMULATION MODE. The direction is a simple rule on synthetic
 * candles (RSI extremes, otherwise position against the moving average). It is
 * a teaching demo of how a rule-based signal works — not market analysis and
 * not a forecast; the interface says so next to every signal.
 */
export class DemoSignalService {
  private readonly store: DocumentStore;
  private readonly source: (mode: MarketMode) => MarketDataSource;
  private readonly stats: StatsBuffer;
  private readonly now: () => Date;

  constructor(deps: { store: DocumentStore; source: (mode: MarketMode) => MarketDataSource; stats: StatsBuffer; now: () => Date }) {
    this.store = deps.store;
    this.source = deps.source;
    this.stats = deps.stats;
    this.now = deps.now;
  }

  async create(scope: TenantScope, telegramId: number, ctx: MarketContext, input: { instrumentId?: unknown; periodSec?: unknown }): Promise<SignalView> {
    const s = ctx.settings;
    if (!s.enabled) throw new AppError('MARKET_DISABLED');
    const instrumentId = String(input.instrumentId ?? '');
    const periodSec = Number(input.periodSec ?? s.defaultPeriod);
    if (!s.periods.includes(periodSec)) throw new AppError('BAD_REQUEST', 'period not offered');
    const src = this.source(ctx.mode);
    const now = this.now();
    const st = src.status(ctx, now);
    if (!st.marketOpen) throw new AppError('MARKET_CLOSED');
    const params = src.params(ctx, instrumentId);

    // Cooldown and daily limit per user and mode.
    const userDocId = scope.userDocId(telegramId);
    const today = await this.store.query<DemoSignalRecord>(C.simulationHistory, {
      where: scope.where(
        { field: 'userDocId', op: '==', value: userDocId },
        { field: 'mode', op: '==', value: ctx.mode },
        { field: 'entryAt', op: '>=', value: new Date(now.getTime() - DAY).toISOString() },
      ),
      orderBy: { field: 'entryAt', direction: 'desc' },
      limit: s.maxSignalsPerDay,
    });
    if (today.length >= s.maxSignalsPerDay) throw new AppError('SIGNAL_LIMIT');
    const lastAt = today[0] ? Date.parse(today[0].data.entryAt) : 0;
    const wait = Math.ceil((lastAt + s.signalCooldownSec * 1000 - now.getTime()) / 1000);
    if (wait > 0) throw new AppError('RECHECK_TOO_SOON', `wait ${wait}s`, { retryAfterSec: wait });

    const candles = src.candles(ctx, instrumentId, s.timeframeSec, Math.max(40, s.rsiPeriod * 3), now);
    const closes = candles.map((c) => c.close);
    const r = rsi(closes, s.rsiPeriod).at(-1) ?? null;
    const avg = sma(closes, 20).at(-1) ?? null;
    const last = closes.at(-1)!;
    let direction: SignalDirection;
    let basis: SignalBasis;
    if (r !== null && r <= 30) [direction, basis] = ['up', 'rsi_oversold'];
    else if (r !== null && r >= 70) [direction, basis] = ['down', 'rsi_overbought'];
    else if (avg !== null && last >= avg) [direction, basis] = ['up', 'above_average'];
    else [direction, basis] = ['down', 'below_average'];

    const record: DemoSignalRecord = scope.stamp({
      userDocId,
      mode: ctx.mode,
      instrumentId,
      direction,
      basis,
      rsi: r === null ? null : Math.round(r * 10) / 10,
      periodSec,
      entryPrice: src.priceAt(params, now),
      entryAt: now.toISOString(),
      expiresAt: new Date(now.getTime() + periodSec * 1000).toISOString(),
      outcome: 'open' as const,
      exitPrice: null,
      resolvedAt: null,
      sourceId: src.id,
      simulated: src.simulated,
      sim: params,
    });
    const id = `${userDocId}_${now.getTime().toString(36)}${randomBytes(4).toString('hex')}`;
    await this.store.create(C.simulationHistory, id, record);
    this.stats.incr(scope.botId, `demo_signals_${ctx.mode}`);
    return view(id, record);
  }

  /** History of one user in one mode, newest first. Expired signals are resolved on read. */
  async list(scope: TenantScope, telegramId: number, mode: MarketMode, limit = 50): Promise<{ signals: SignalView[]; stats: SignalStats }> {
    if (!(MARKET_MODES as readonly string[]).includes(mode)) throw new AppError('NOT_FOUND');
    const rows = await this.store.query<DemoSignalRecord>(C.simulationHistory, {
      where: scope.where({ field: 'userDocId', op: '==', value: scope.userDocId(telegramId) }, { field: 'mode', op: '==', value: mode }),
      orderBy: { field: 'entryAt', direction: 'desc' },
      limit: Math.min(Math.max(limit, 1), 200),
    });
    const now = this.now();
    const out: SignalView[] = [];
    const stats: SignalStats = { total: 0, open: 0, win: 0, loss: 0, draw: 0 };
    for (const row of rows) {
      let r = row.data;
      if (!scope.owns(r)) continue;
      if (r.outcome === 'open' && Date.parse(r.expiresAt) <= now.getTime()) r = await this.resolve(row.id, r);
      out.push(view(row.id, r));
      stats.total++;
      stats[r.outcome]++;
    }
    return { signals: out, stats };
  }

  private async resolve(id: string, r: DemoSignalRecord): Promise<DemoSignalRecord> {
    const src = this.source(r.mode);
    const exitPrice = src.priceAt(r.sim, new Date(r.expiresAt));
    const outcome: SignalOutcome =
      exitPrice === r.entryPrice ? 'draw' : (exitPrice > r.entryPrice) === (r.direction === 'up') ? 'win' : 'loss';
    const patch = { outcome, exitPrice, resolvedAt: this.now().toISOString() };
    // Resolution is deterministic, so a concurrent resolver writes the same values.
    await this.store.update(C.simulationHistory, id, patch).catch(() => undefined);
    return { ...r, ...patch };
  }
}

export function marketContext(botId: string, mode: MarketMode, settings: MarketSettings): MarketContext {
  return { botId, mode, settings };
}
