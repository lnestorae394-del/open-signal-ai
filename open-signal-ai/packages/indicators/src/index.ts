/**
 * Technical indicators computed on the server from provider candles.
 * Pure functions, no I/O. Output arrays are aligned with the input:
 * positions without enough history are `null` (never a made-up value).
 */

export interface Candle {
  /** Candle open time, epoch ms (UTC). */
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

function assertPeriod(period: number, name = 'period'): void {
  if (!Number.isInteger(period) || period < 1) throw new RangeError(`${name} must be a positive integer`);
}

/** Simple moving average. */
export function sma(values: readonly number[], period: number): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(values.length).fill(null);
  let sum = 0;
  for (let i = 0; i < values.length; i++) {
    sum += values[i]!;
    if (i >= period) sum -= values[i - period]!;
    if (i >= period - 1) out[i] = sum / period;
  }
  return out;
}

/**
 * RSI with Wilder's smoothing (the original definition).
 * First average gain/loss = simple average of the first `period` changes,
 * then avg = (prevAvg × (period − 1) + current) / period.
 * When both averages are 0 (flat market) RSI is reported as 50.
 */
export function rsi(closes: readonly number[], period = 14): (number | null)[] {
  assertPeriod(period);
  const out: (number | null)[] = new Array(closes.length).fill(null);
  if (closes.length <= period) return out;

  let gain = 0;
  let loss = 0;
  for (let i = 1; i <= period; i++) {
    const d = closes[i]! - closes[i - 1]!;
    if (d > 0) gain += d;
    else loss -= d;
  }
  let avgGain = gain / period;
  let avgLoss = loss / period;
  out[period] = toRsi(avgGain, avgLoss);

  for (let i = period + 1; i < closes.length; i++) {
    const d = closes[i]! - closes[i - 1]!;
    avgGain = (avgGain * (period - 1) + (d > 0 ? d : 0)) / period;
    avgLoss = (avgLoss * (period - 1) + (d < 0 ? -d : 0)) / period;
    out[i] = toRsi(avgGain, avgLoss);
  }
  return out;
}

function toRsi(avgGain: number, avgLoss: number): number {
  if (avgGain === 0 && avgLoss === 0) return 50;
  if (avgLoss === 0) return 100;
  return 100 - 100 / (1 + avgGain / avgLoss);
}

export interface StochasticPoint {
  k: number | null;
  d: number | null;
}

/**
 * Stochastic oscillator.
 * raw %K = (close − lowest low) / (highest high − lowest low) × 100 over `kPeriod`,
 * %K = SMA(raw %K, `smoothK`) (1 = fast stochastic), %D = SMA(%K, `dPeriod`).
 * A zero range (high == low over the window) yields 50.
 */
export function stochastic(
  candles: readonly Candle[],
  kPeriod = 14,
  dPeriod = 3,
  smoothK = 1,
): StochasticPoint[] {
  assertPeriod(kPeriod, 'kPeriod');
  assertPeriod(dPeriod, 'dPeriod');
  assertPeriod(smoothK, 'smoothK');
  const raw: (number | null)[] = candles.map((c, i) => {
    if (i < kPeriod - 1) return null;
    let hh = -Infinity;
    let ll = Infinity;
    for (let j = i - kPeriod + 1; j <= i; j++) {
      hh = Math.max(hh, candles[j]!.high);
      ll = Math.min(ll, candles[j]!.low);
    }
    return hh === ll ? 50 : ((c.close - ll) / (hh - ll)) * 100;
  });
  const k = smoothNullable(raw, smoothK);
  const d = smoothNullable(k, dPeriod);
  return candles.map((_, i) => ({ k: k[i] ?? null, d: d[i] ?? null }));
}

/** SMA over a series that starts with nulls. */
function smoothNullable(values: readonly (number | null)[], period: number): (number | null)[] {
  if (period === 1) return [...values];
  const first = values.findIndex((v) => v !== null);
  const out: (number | null)[] = new Array(values.length).fill(null);
  if (first < 0) return out;
  const tail = sma(values.slice(first) as number[], period);
  tail.forEach((v, i) => (out[first + i] = v));
  return out;
}

export interface BollingerPoint {
  middle: number | null;
  upper: number | null;
  lower: number | null;
}

/** Bollinger Bands: SMA(period) ± multiplier × population standard deviation. */
export function bollinger(closes: readonly number[], period = 20, multiplier = 2): BollingerPoint[] {
  assertPeriod(period);
  const mid = sma(closes, period);
  return closes.map((_, i) => {
    const m = mid[i];
    if (m === null || m === undefined) return { middle: null, upper: null, lower: null };
    let variance = 0;
    for (let j = i - period + 1; j <= i; j++) variance += (closes[j]! - m) ** 2;
    const sd = Math.sqrt(variance / period);
    return { middle: m, upper: m + multiplier * sd, lower: m - multiplier * sd };
  });
}
