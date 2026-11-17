import { test } from 'node:test';
import assert from 'node:assert/strict';
import { forexSessionState } from '../src/market-hours.ts';

test('Forex is open Monday-Friday from 02:00 until 22:45 in UTC+2', () => {
  assert.equal(forexSessionState(new Date('2026-11-18T00:00:00.000Z')).open, true); // Wed 02:00
  assert.equal(forexSessionState(new Date('2026-11-18T20:44:00.000Z')).open, true); // Wed 22:44
  assert.equal(forexSessionState(new Date('2026-11-18T20:45:00.000Z')).open, false); // Wed 22:45
  assert.equal(forexSessionState(new Date('2026-11-18T20:45:00.000Z')).nextChangeAt.toISOString(), '2026-11-19T00:00:00.000Z');
});

test('Forex remains closed through the weekend and opens Monday at 02:00 UTC+2', () => {
  const fridayClose = forexSessionState(new Date('2026-11-20T20:45:00.000Z'));
  assert.equal(fridayClose.open, false);
  assert.equal(fridayClose.nextChangeAt.toISOString(), '2026-11-23T00:00:00.000Z');
  const saturday = forexSessionState(new Date('2026-11-21T12:00:00.000Z'));
  assert.equal(saturday.open, false);
  assert.equal(saturday.nextChangeAt.toISOString(), '2026-11-23T00:00:00.000Z');
  const sunday = forexSessionState(new Date('2026-11-22T12:00:00.000Z'));
  assert.equal(sunday.open, false);
  assert.equal(sunday.nextChangeAt.toISOString(), '2026-11-23T00:00:00.000Z');
});
