import { findInstrument, forexSessionState, type MarketMode, type SimVolatility } from '@open-signal/shared';
import type { Candle } from '@open-signal/indicators';
import { AppError } from '../lib/errors.ts';
import type { MarketContext, MarketDataSource, Quote, SimParams } from './source.ts';

/**
 * SIMULATION MODE — synthetic prices, NOT market quotes.
 *
 * The price is a pure function of (seed, time): smooth multi-scale value noise
 * around a reference level. Consequences:
 *  - no storage and no background jobs: every server instance, restart and
 *    redeploy shows the same synthetic series;
 *  - a demo signal can be resolved later exactly, from the parameters stored with it;
 *  - Forex and OTC use different seeds and settings, so they are independent simulators;
 *  - every bot has its own seed, so two bots never show the same synthetic numbers.
 */

/** Reference levels used only to keep synthetic numbers in a familiar range. */
const REFERENCE_LEVEL: Record<string, number> = {
  EURUSD: 1.085, GBPUSD: 1.27, USDJPY: 150, USDCAD: 1.36, USDCHF: 0.88, AUDUSD: 0.66, EURJPY: 162,
  GBPJPY: 190, EURGBP: 0.855, EURAUD: 1.64, EURCAD: 1.47, EURCHF: 0.955, GBPCAD: 1.72, GBPCHF: 1.12,
  GBPAUD: 1.92, AUDCAD: 0.9, AUDCHF: 0.58, AUDJPY: 99, CADJPY: 110, CADCHF: 0.65, CHFJPY: 170,
};

/** [period seconds, weight] of each noise layer — from daily swings down to second-level ticks. */
const OCTAVES: readonly (readonly [number, number])[] = [
  [86_400, 1],
  [21_600, 0.55],
  [3_600, 0.32],
  [900, 0.2],
  [300, 0.13],
  [60, 0.08],
  [15, 0.045],
  [5, 0.025],
];

const SIGMA: Record<MarketMode, Record<SimVolatility, number>> = {
  forex: { low: 0.0015, normal: 0.003, high: 0.006 },
  otc: { low: 0.0025, normal: 0.005, high: 0.01 },
};

const HOUR = 3_600_000;

function hash32(str: string): number {
  let h = 2166136261 >>> 0;
  for (let i = 0; i < str.length; i++) {
    h ^= str.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

/** Deterministic value in [-1, 1] for (seed, layer, step). */
function lattice(seed: number, layer: number, step: number): number {
  let x = (seed ^ Math.imul(layer + 1, 0x9e3779b1) ^ Math.imul(step | 0, 0x85ebca77)) >>> 0;
  x ^= x >>> 16;
  x = Math.imul(x, 0x7feb352d);
  x ^= x >>> 15;
  x = Math.imul(x, 0x846ca68b);
  x ^= x >>> 16;
  return ((x >>> 0) / 4294967295) * 2 - 1;
}

function noise(seed: number, tSec: number): number {
  let sum = 0;
  for (let o = 0; o < OCTAVES.length; o++) {
    const [period, weight] = OCTAVES[o]!;
    const x = tSec / period;
    const i = Math.floor(x);
    const f = x - i;
    const s = f * f * (3 - 2 * f);
    const a = lattice(seed, o, i);
    const b = lattice(seed, o, i + 1);
    sum += weight * (a + (b - a) * s);
  }
  return sum;
}

const round = (v: number, d: number) => Math.round(v * 10 ** d) / 10 ** d;

/** While Forex is closed, the Forex simulation is frozen at the last Friday close. */
function effectiveTime(p: SimParams, at: Date): number {
  if (!p.followsForexHours) return at.getTime();
  const s = forexSessionState(at);
  return s.open ? at.getTime() : s.nextChangeAt.getTime() - 48 * HOUR;
}

export class SimulationSource implements MarketDataSource {
  readonly id = 'simulation';
  readonly simulated = true;

  params(ctx: MarketContext, instrumentId: string): SimParams {
    const inst = findInstrument(instrumentId);
    if (!inst || inst.market !== ctx.mode || !ctx.settings.instruments.includes(instrumentId)) throw new AppError('NOT_FOUND', 'instrument not available');
    const key = `${inst.base}${inst.quote}`;
    return {
      seed: `${ctx.botId}:${ctx.mode}:${instrumentId}`,
      base: REFERENCE_LEVEL[key] ?? 1,
      sigma: SIGMA[ctx.mode][ctx.settings.volatility],
      decimals: inst.quote === 'JPY' ? 3 : 5,
      followsForexHours: ctx.mode === 'forex',
    };
  }

  priceAt(p: SimParams, at: Date): number {
    const t = effectiveTime(p, at) / 1000;
    return round(p.base * Math.exp(p.sigma * noise(hash32(p.seed), t)), p.decimals);
  }

  status(ctx: MarketContext, now: Date) {
    if (ctx.mode === 'forex') {
      const s = forexSessionState(now);
      return { status: 'SIMULATED' as const, marketOpen: s.open, frozenAt: s.open ? null : new Date(s.nextChangeAt.getTime() - 48 * HOUR).toISOString() };
    }
    return { status: 'SIMULATED' as const, marketOpen: true, frozenAt: null };
  }

  quote(ctx: MarketContext, instrumentId: string, now: Date): Quote {
    const p = this.params(ctx, instrumentId);
    const price = this.priceAt(p, now);
    const hourAgo = this.priceAt(p, new Date(effectiveTime(p, now) - HOUR));
    return { instrumentId, price, changePct: round(((price - hourAgo) / hourAgo) * 100, 3), decimals: p.decimals, at: now.toISOString() };
  }

  candles(ctx: MarketContext, instrumentId: string, timeframeSec: number, count: number, now: Date): Candle[] {
    const p = this.params(ctx, instrumentId);
    const endMs = effectiveTime(p, now);
    const tf = timeframeSec * 1000;
    const last = Math.floor(endMs / tf);
    const out: Candle[] = [];
    const SAMPLES = 8;
    for (let k = last - count + 1; k <= last; k++) {
      const start = k * tf;
      const end = Math.min(start + tf, endMs);
      const open = this.priceAt({ ...p, followsForexHours: false }, new Date(start));
      let high = open;
      let low = open;
      let close = open;
      for (let i = 1; i <= SAMPLES; i++) {
        const v = this.priceAt({ ...p, followsForexHours: false }, new Date(start + ((end - start) * i) / SAMPLES));
        high = Math.max(high, v);
        low = Math.min(low, v);
        close = v;
      }
      out.push({ time: start, open, high, low, close });
    }
    return out;
  }
}
