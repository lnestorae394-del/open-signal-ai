import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, harness, seedBot, seedGlobalSource, type Harness, type TestBot } from './helpers.ts';
import { C } from '../src/storage/collections.ts';
import { TenantScope } from '../src/domain/tenant.ts';

/**
 * The 12 acceptance checks of the task "Postback как в Hidden Dinox Academy + ручное управление доступом".
 * Postbacks use the Pocket Partners URL form of Open Signal: key, event (reg / ftd / dep), click_id, trader_id, sumdep —
 * both `/postback?key=…` and `/postback/<sourceId>?key=…`.
 */

const OWNER = { uid: 'owner-1', email: 'owner@example.com', role: 'owner' as const, botPermissions: {} };
type Src = { sourceId: string; secret: string };
/** `/postback?key=…` — the URL form used in the Pocket Partners cabinet (no source ID in the path). */
const pk = (h: Harness, src: Src, params: Record<string, string>) =>
  h.request('GET', `/postback?${new URLSearchParams({ key: src.secret, ...params })}`, { ip: '192.0.2.1' });
const me = async (h: Harness, bot: TestBot, token: string) => (await h.request('GET', `/api/miniapp/${bot.botId}/me`, { headers: bearer(token) })).json;
const signal = (h: Harness, bot: TestBot, token: string) =>
  h.request('POST', `/api/miniapp/${bot.botId}/signals`, { headers: bearer(token), body: { instrumentId: 'EURUSD', periodSec: 60 } });
const submit = (h: Harness, bot: TestBot, token: string, traderId: string) =>
  h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(token), body: { traderId } });
async function register(h: Harness, bot: TestBot, token: string): Promise<string> {
  const r = await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/register`, { headers: bearer(token) });
  return new URL(r.json.link).searchParams.get('sub')!;
}
const grant = (h: Harness, bot: TestBot, tg: number, on: boolean) =>
  h.s.binding.adminSetManualAccess(OWNER, new TenantScope(bot.botId), { telegramId: tg, grant: on, reason: on ? 'technical problem, ticket #7' : 'problem solved' });

async function setup() {
  const h = harness();
  const bot = await seedBot(h.s, 'botAcademy');
  const src = await seedGlobalSource(h.s);
  return { h, bot, src };
}

test('1, 2, 3) no registration, no deposit → "Grant access" opens signals; kept after relaunch; "Revoke access" restores the restriction', async () => {
  const { h, bot } = await setup();
  const s = await h.login(bot, 1);
  assert.equal((await signal(h, bot, s.token)).status, 403);
  await grant(h, bot, 1, true);
  assert.equal((await signal(h, bot, s.token)).status, 201, 'opened without registration, Trader ID, click_id or deposit');
  // Relaunch: new session (other device / reload).
  const again = await h.login(bot, 1);
  assert.deepEqual((await me(h, bot, again.token)).access, { signals: true, via: 'manual' });
  h.clock.advance(31);
  assert.equal((await signal(h, bot, again.token)).status, 201);
  await grant(h, bot, 1, false);
  assert.equal((await signal(h, bot, again.token)).status, 403, 'back to the normal rules');
  assert.equal((await me(h, bot, again.token)).onboarding.status, 'registration', 'the real onboarding state was never changed');
});

test('4) deposit access → manual grant → revoke: the deposit access stays', async () => {
  const { h, bot, src } = await setup();
  const s = await h.login(bot, 2);
  const click = await register(h, bot, s.token);
  await pk(h, src, { event: 'reg', click_id: click, trader_id: '91000002' });
  await submit(h, bot, s.token, '91000002');
  await pk(h, src, { event: 'ftd', click_id: click, trader_id: '91000002', sumdep: '25' });
  assert.equal((await me(h, bot, s.token)).onboarding.status, 'completed');
  await grant(h, bot, 2, true);
  await grant(h, bot, 2, false);
  assert.deepEqual((await me(h, bot, s.token)).access, { signals: true, via: 'onboarding' });
  assert.equal((await signal(h, bot, s.token)).status, 201);
});

test('5) manual access first, then the user links the account and deposits → after revoke the normal access remains', async () => {
  const { h, bot, src } = await setup();
  const s = await h.login(bot, 3);
  await grant(h, bot, 3, true);
  // From the profile ("Link account") the user goes through the normal steps.
  const click = await register(h, bot, s.token);
  await pk(h, src, { event: 'reg', click_id: click, trader_id: '91000003' });
  assert.equal((await submit(h, bot, s.token, '91000003')).json.binding.state, 'account_bound');
  await pk(h, src, { event: 'ftd', click_id: click, trader_id: '91000003', sumdep: '10' });
  assert.equal((await me(h, bot, s.token)).onboarding.status, 'completed');
  await grant(h, bot, 3, false);
  assert.deepEqual((await me(h, bot, s.token)).access, { signals: true, via: 'onboarding' });
  assert.equal((await signal(h, bot, s.token)).status, 201);
});

test('6) an unknown click_id does not block a correctly linked Trader ID', async () => {
  const { h, bot, src } = await setup();
  const s = await h.login(bot, 4);
  const click = await register(h, bot, s.token);
  await pk(h, src, { event: 'reg', click_id: click, trader_id: '91000004' });
  await submit(h, bot, s.token, '91000004');
  assert.equal((await pk(h, src, { event: 'ftd', click_id: 'ffffffffffffffffffffffffffffffff', trader_id: '91000004', sumdep: '30' })).status, 200);
  assert.equal((await pk(h, src, { event: 'dep', click_id: 'not-ours-123456', trader_id: '91000004', sumdep: '12' })).status, 200);
  const o = (await me(h, bot, s.token)).onboarding;
  assert.equal(o.deposit.check, 'confirmed');
  assert.equal(o.deposit.depositsCount, 2);
});

test('7) deposit BEFORE the registration: stored (Pending), processed after the registration is confirmed', async () => {
  const { h, bot, src } = await setup();
  // a) Partner sends FTD and repeat deposit first, then a registration without our click_id; the user enters the Trader ID.
  const s = await h.login(bot, 5);
  assert.equal((await pk(h, src, { event: 'ftd', trader_id: '91000005', sumdep: '40' })).status, 200);
  assert.equal((await pk(h, src, { event: 'dep', trader_id: '91000005', sumdep: '15' })).status, 200);
  assert.equal((await me(h, bot, s.token)).onboarding.status, 'registration', 'nothing credited to anybody yet');
  assert.equal((await pk(h, src, { event: 'reg', trader_id: '91000005' })).status, 200);
  assert.equal((await submit(h, bot, s.token, '91000005')).json.binding.state, 'account_bound');
  let o = (await me(h, bot, s.token)).onboarding;
  assert.equal(o.deposit.check, 'confirmed');
  assert.equal(o.deposit.depositsCount, 2);
  assert.equal(o.deposit.ftdAmount, 40);
  assert.equal(o.status, 'completed');
  // b) The user entered the Trader ID first (waiting), deposit, then the registration → linked and credited automatically.
  const s2 = await h.login(bot, 6);
  assert.equal((await submit(h, bot, s2.token, '91000006')).json.error.code, 'REGISTRATION_NOT_CONFIRMED');
  await pk(h, src, { event: 'ftd', trader_id: '91000006', sumdep: '20' });
  await pk(h, src, { event: 'reg', trader_id: '91000006' });
  o = (await me(h, bot, s2.token)).onboarding;
  assert.equal(o.status, 'completed');
  assert.equal(o.deposit.ftdAmount, 20);
  const promoted = (await h.store.query<{ diagnosis: string; botId: string; amount: number }>(C.postbackEvents, {})).filter((e) => e.data.diagnosis === 'matched_pending');
  assert.equal(promoted.length, 3);
  assert.ok(promoted.every((e) => e.data.botId === bot.botId));
});

test('8) a repeated postback never credits a deposit twice (FTD, repeat deposit, registration)', async () => {
  const { h, bot, src } = await setup();
  const s = await h.login(bot, 7);
  const click = await register(h, bot, s.token);
  for (let i = 0; i < 3; i++) await pk(h, src, { event: 'reg', click_id: click, trader_id: '91000007' });
  await submit(h, bot, s.token, '91000007');
  for (let i = 0; i < 3; i++) await pk(h, src, { event: 'ftd', click_id: click, trader_id: '91000007', sumdep: '50' });
  for (let i = 0; i < 3; i++) await pk(h, src, { event: 'dep', click_id: click, trader_id: '91000007', sumdep: '70' });
  const d = (await me(h, bot, s.token)).onboarding.deposit;
  assert.equal(d.depositsCount, 2, 'one FTD + one repeat deposit');
  assert.equal(d.ftdAmount, 50);
  const regs = (await h.store.query(C.postbackEvents, { where: [{ field: 'eventType', op: '==', value: 'registration' }] })).length;
  assert.equal(regs, 1);
});

test('9) Trader ID conflict: the binding is never overwritten, the event goes to review', async () => {
  const { h, bot, src } = await setup();
  const a = await h.login(bot, 8);
  const clickA = await register(h, bot, a.token);
  await pk(h, src, { event: 'reg', click_id: clickA, trader_id: '91000008' });
  await submit(h, bot, a.token, '91000008');
  const b = await h.login(bot, 9);
  const clickB = await register(h, bot, b.token);
  await pk(h, src, { event: 'reg', click_id: clickB, trader_id: '91000008' });
  await pk(h, src, { event: 'ftd', click_id: clickB, trader_id: '91000008', sumdep: '99' });
  assert.equal((await submit(h, bot, b.token, '91000008')).json.error.code, 'TRADER_ID_TAKEN');
  assert.equal((await me(h, bot, a.token)).binding.state, 'account_bound');
  assert.equal((await me(h, bot, a.token)).onboarding.deposit.depositsCount, 0, 'the deposit with B’s click_id is not credited to A');
  const evs = (await h.store.query<{ eventType: string; matchStatus: string; diagnosis: string }>(C.postbackEvents, {})).map((e) => e.data);
  assert.ok(evs.some((e) => e.eventType === 'registration' && e.matchStatus === 'conflict' && e.diagnosis === 'click_other_user'));
  assert.ok(evs.some((e) => e.eventType === 'ftd' && e.matchStatus === 'conflict'));
  const lock = await h.store.query<{ userDocId: string }>(C.traderBindings, {});
  assert.deepEqual(lock.map((l) => l.data.userDocId), [`${bot.botId}_8`]);
  // B's FTD did not take the place of A's first deposit: A's real FTD is still credited.
  await pk(h, src, { event: 'ftd', click_id: clickA, trader_id: '91000008', sumdep: '25' });
  const d = (await me(h, bot, a.token)).onboarding.deposit;
  assert.equal(d.check, 'confirmed');
  assert.equal(d.ftdAmount, 25);
});

test('10) a regular user cannot grant themselves access', async () => {
  const { h, bot } = await setup();
  const s = await h.login(bot, 10);
  // The admin API does not accept a Mini App session.
  const r = await h.request('POST', `/api/admin/bots/${bot.botId}/users/10/manual-access`, { headers: { ...bearer(s.token), 'x-os-admin': '1' }, body: { grant: true, reason: 'let me in please' } });
  assert.ok(r.status === 401 || r.status === 403, String(r.status));
  // Mini App endpoints ignore any extra fields.
  await h.request('PUT', `/api/miniapp/${bot.botId}/settings`, { headers: bearer(s.token), body: { language: 'ru', manualAccess: { active: true }, manualAccessActive: true, onboardingCompletedAt: '2026-01-01T00:00:00Z' } });
  await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(s.token), body: { traderId: '91000010', manualAccess: { active: true } } });
  assert.deepEqual((await me(h, bot, s.token)).access, { signals: false, via: null });
  assert.equal((await signal(h, bot, s.token)).status, 403);
});

test('11) reg, ftd and dep are processed through /postback?key=… and /postback/<sourceId>?key=…', async () => {
  const { h, bot, src } = await setup();
  const s = await h.login(bot, 11);
  const click = await register(h, bot, s.token);
  assert.equal((await pk(h, src, { event: 'reg', click_id: click, trader_id: '91000011' })).status, 200);
  assert.equal((await submit(h, bot, s.token, '91000011')).json.binding.state, 'account_bound');
  assert.equal((await h.request('GET', `/postback/${src.sourceId}?${new URLSearchParams({ key: src.secret, event: 'ftd', click_id: click, trader_id: '91000011', sumdep: '33.50' })}`, { ip: '192.0.2.1' })).status, 200);
  assert.equal((await pk(h, src, { event: 'dep', click_id: click, trader_id: '91000011', sumdep: '16.50' })).status, 200);
  const d = (await me(h, bot, s.token)).onboarding.deposit;
  assert.equal(d.ftdAmount, 33.5);
  assert.equal(d.depositsCount, 2);
  const u = await h.store.get<{ deposit: { totalAmount: number } }>(C.users, `${bot.botId}_11`);
  assert.equal(u!.deposit.totalAmount, 50, 'deposit total for the admin table');
  // POST with the same parameters works too.
  assert.equal((await h.request('POST', `/postback?${new URLSearchParams({ key: src.secret, event: 'dep', click_id: click, trader_id: '91000011', sumdep: '7' })}`, { ip: '192.0.2.1' })).status, 200);
});

test('12) a wrong key never gets an event in — in either URL form; nothing is stored', async () => {
  const { h, src } = await setup();
  const bad = new URLSearchParams({ key: 'wrong-key-value-123456', event: 'ftd', trader_id: '91000012', sumdep: '500' });
  assert.equal((await h.request('GET', `/postback?${bad}`, { ip: '192.0.2.1' })).status, 401);
  assert.equal((await h.request('GET', `/postback/${src.sourceId}?${bad}`, { ip: '192.0.2.1' })).status, 401);
  assert.equal((await h.request('GET', `/postback?${new URLSearchParams({ event: 'ftd', trader_id: '91000012', sumdep: '500' })}`, { ip: '192.0.2.1' })).status, 401, 'no key at all');
  assert.equal((await h.store.query(C.postbackEvents, {})).length, 0);
  const errs = await h.store.query<{ code: string; message: string }>(C.errorLogs, {});
  assert.ok(errs.some((e) => e.data.code === 'UNAUTHORIZED'));
  assert.ok(errs.every((e) => !e.data.message.includes('wrong-key-value')), 'the key is never logged');
});

test('a Trader ID registered without click_id can be linked by only one account across all bots', async () => {
  const h = harness();
  const b1 = await seedBot(h.s, 'botOne');
  const b2 = await seedBot(h.s, 'botTwo');
  const src = await seedGlobalSource(h.s);
  await pk(h, src, { event: 'reg', trader_id: '91000013' });
  const u1 = await h.login(b1, 13);
  const u2 = await h.login(b2, 14);
  assert.equal((await submit(h, b1, u1.token, '91000013')).json.binding.state, 'account_bound');
  assert.equal((await submit(h, b2, u2.token, '91000013')).json.error.code, 'TRADER_ID_TAKEN');
});
