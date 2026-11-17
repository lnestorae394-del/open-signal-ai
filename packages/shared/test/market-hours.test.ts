import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forexSessionState, POCKET_OPTION_TIMEZONE } from '../src/market-hours.ts';

test('Pocket Option standard Forex pairs open Mon-Fri 02:00-22:45 in fixed UTC+2', () => {
  const atOpen = forexSessionState(new Date('2026-11-18T00:00:00.000Z'), 'EURUSD'); // Wed 02:00 UTC+2
  assert.equal(atOpen.open, true);
  assert.equal(atOpen.timezone, POCKET_OPTION_TIMEZONE);
  assert.equal(atOpen.opensAt, '02:00');
  assert.equal(atOpen.closesAt, '22:45');
  assert.equal(atOpen.nextChangeAt.toISOString(), '2026-11-18T20:45:00.000Z');

  const atClose = forexSessionState(new Date('2026-11-18T20:45:00.000Z'), 'EURUSD'); // Wed 22:45 UTC+2
  assert.equal(atClose.open, false);
  assert.equal(atClose.nextChangeAt.toISOString(), '2026-11-19T00:00:00.000Z'); // Thu 02:00 UTC+2
});

test('GBP/CAD and GBP/CHF use the later 04:10 opening time', () => {
  const gbpCad = forexSessionState(new Date('2026-11-18T00:00:00.000Z'), 'GBPCAD');
  assert.equal(gbpCad.open, false);
  assert.equal(gbpCad.opensAt, '04:10');
  assert.equal(gbpCad.nextChangeAt.toISOString(), '2026-11-18T02:10:00.000Z');

  const gbpChf = forexSessionState(new Date('2026-11-18T02:10:00.000Z'), 'GBPCHF');
  assert.equal(gbpChf.open, true);
});

test('regular Forex stays closed over the weekend and reopens Monday at 02:00 UTC+2', () => {
  const fridayClose = forexSessionState(new Date('2026-11-20T20:45:00.000Z'), 'EURUSD');
  assert.equal(fridayClose.open, false);
  assert.equal(fridayClose.nextChangeAt.toISOString(), '2026-11-23T00:00:00.000Z');

  const saturday = forexSessionState(new Date('2026-11-21T12:00:00.000Z'), 'EURUSD');
  assert.equal(saturday.open, false);
  assert.equal(saturday.nextChangeAt.toISOString(), '2026-11-23T00:00:00.000Z');

  const sunday = forexSessionState(new Date('2026-11-22T12:00:00.000Z'), 'EURUSD');
  assert.equal(sunday.open, false);
  assert.equal(sunday.nextChangeAt.toISOString(), '2026-11-23T00:00:00.000Z');
});
