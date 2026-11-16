import type { DataStatus, MarketMode, MarketSettings } from '@open-signal/shared';
import type { Candle } from '@open-signal/indicators';

/**
 * Pluggable market data source. Today only the built-in simulation exists.
 * A verified provider (Forex) or a licensed OTC feed is added later by
 * implementing this interface and registering it for a mode — screens,
 * signals and history do not change.
 */
export interface MarketContext {
  botId: string;
  mode: MarketMode;
  settings: MarketSettings;
}

export interface Quote {
  instrumentId: string;
  price: number;
  /** Change against the price one hour earlier, percent. */
  changePct: number;
  decimals: number;
  at: string;
}

export interface MarketDataSource {
  /** Stable id stored with every signal, e.g. "simulation". */
  readonly id: string;
  /** True for synthetic data. The interface must then show DEMO / SIMULATED. */
  readonly simulated: boolean;
  status(ctx: MarketContext, now: Date): { status: DataStatus; marketOpen: boolean; frozenAt: string | null };
  quote(ctx: MarketContext, instrumentId: string, now: Date): Quote;
  candles(ctx: MarketContext, instrumentId: string, timeframeSec: number, count: number, now: Date): Candle[];
  /** Price at an exact moment, with the parameters frozen into a signal. */
  priceAt(params: SimParams, at: Date): number;
  params(ctx: MarketContext, instrumentId: string): SimParams;
}

/** Everything needed to reproduce a simulated price later (stored with each demo signal). */
export interface SimParams {
  seed: string;
  base: number;
  sigma: number;
  decimals: number;
  /** Forex simulation pauses while the real Forex market is closed. */
  followsForexHours: boolean;
}
