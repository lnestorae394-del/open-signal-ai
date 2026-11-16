import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bollinger, rsi, sma, stochastic, type Candle } from '../src/index.ts';

const close = (a: number, b: number, eps = 0.01) =>
  assert.ok(Math.abs(a - b) <= eps, `expected ${b}, got ${a}`);

// Reference series from J. Welles Wilder's RSI method as published in the
// StockCharts ChartSchool RSI calculation example (14 periods).
// The spreadsheet uses 4-decimal prices; rounding them to 2 decimals shifts RSI by ~0.07.
const WILDER_CLOSES = [
  44.3389, 44.0902, 44.1497, 43.6124, 44.3278, 44.8264, 45.0955, 45.4245, 45.8433, 46.0826,
  45.8931, 46.0328, 45.614, 46.282, 46.282, 46.0028, 46.0328, 46.4116, 46.2222, 45.6418,
];

test('RSI(14) matches the published Wilder example', () => {
  const r = rsi(WILDER_CLOSES, 14);
  for (let i = 0; i < 14; i++) assert.equal(r[i], null, 'no value without enough history');
  const expected = [70.53, 66.32, 66.55, 69.41, 66.36, 57.97];
  // The published table rounds intermediate averages, so drift grows slightly per step.
  expected.forEach((v, n) => close(r[14 + n]!, v, 0.03));
});

test('RSI edge cases: only gains → 100, flat → 50', () => {
  assert.equal(rsi([1, 2, 3, 4, 5, 6], 5)[5], 100);
  assert.equal(rsi([3, 3, 3, 3, 3, 3], 5)[5], 50);
});

test('SMA', () => {
  assert.deepEqual(sma([1, 2, 3, 4, 5], 3), [null, null, 2, 3, 4]);
});

test('Bollinger Bands use population standard deviation', () => {
  const b = bollinger([2, 4, 4, 4, 5, 5, 7, 9], 8, 2);
  // mean 5, population sd 2 → bands 1 and 9
  close(b[7]!.middle!, 5, 1e-9);
  close(b[7]!.upper!, 9, 1e-9);
  close(b[7]!.lower!, 1, 1e-9);
  assert.equal(b[6]!.middle, null);
});

test('Stochastic %K and %D', () => {
  const candles: Candle[] = [
    { time: 1, open: 1, high: 10, low: 5, close: 6 },
    { time: 2, open: 1, high: 12, low: 6, close: 11 },
    { time: 3, open: 1, high: 11, low: 4, close: 8 },
    { time: 4, open: 1, high: 13, low: 7, close: 13 },
  ];
  const s = stochastic(candles, 3, 2, 1);
  assert.equal(s[1]!.k, null);
  // window 0..2: HH 12, LL 4, close 8 → 50
  close(s[2]!.k!, 50, 1e-9);
  // window 1..3: HH 13, LL 4, close 13 → 100
  close(s[3]!.k!, 100, 1e-9);
  close(s[3]!.d!, 75, 1e-9);
  assert.equal(s[2]!.d, null);
});
