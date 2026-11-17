import { test } from 'node:test';
import assert from 'node:assert/strict';
import { bearer, harness, seedBot, seedGlobalSource, type Harness, type TestBot } from './helpers.ts';
import { C } from '../src/storage/collections.ts';

/**
 * Global postback routing.
 *  - Registration: a valid click_id is mandatory and decides the user.
 *  - FTD / repeat deposit: a valid click_id decides; without one (missing / unknown / expired)
 *    the Trader ID decides, but only when it is linked to exactly one user. A valid click of
 *    another user is never bypassed.
 */

type Src = { sourceId: string; secret: string };
const pp = (h: Harness, src: Src, params: Record<string, string>) =>
  h.request('GET', `/postback/${src.sourceId}?${new URLSearchParams({ key: src.secret, ...params })}`, { ip: '192.0.2.1' });
const me = async (h: Harness, bot: TestBot, token: string) => (await h.request('GET', `/api/miniapp/${bot.botId}/me`, { headers: bearer(token) })).json;
async function register(h: Harness, bot: TestBot, token: string): Promise<string> {
  const r = await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/register`, { headers: bearer(token) });
  return new URL(r.json.link).searchParams.get('sub')!;
}
/** A user who registered through their own link and linked the Trader ID (steps 1–2 done). */
async function linked(h: Harness, bot: TestBot, src: Src, tg: number, tid: string) {
  const s = await h.login(bot, tg);
  const click = await register(h, bot, s.token);
  assert.equal((await pp(h, src, { event: 'reg', click_id: click, trader_id: tid })).status, 200);
  const r = await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(s.token), body: { traderId: tid } });
  assert.equal(r.json.binding.state, 'account_bound');
  return { token: s.token, click };
}
type Ev = { botId: string; eventType: string; amount: number | null; matchStatus: string; matchedUserDocId: string | null; diagnosis: string; routedBy: string };
const events = async (h: Harness) => (await h.store.query<Ev>(C.postbackEvents, {})).map((e) => e.data);
const errorCodes = async (h: Harness) => (await h.store.query<{ code: string; message: string }>(C.errorLogs, {})).map((e) => e.data);

async function setup() {
  const h = harness();
  const bot = await seedBot(h.s, 'botRoute');
  const src = await seedGlobalSource(h.s);
  return { h, bot, src };
}

test('1) registration through a valid click_id is linked to the owner of that click', async () => {
  const { h, bot, src } = await setup();
  await linked(h, bot, src, 1, '61000001');
  const reg = (await events(h)).find((e) => e.eventType === 'registration')!;
  assert.equal(reg.diagnosis, 'matched_click');
  assert.equal(reg.routedBy, 'click_id');
});

test('2) registration without our click_id: stored (Academy rule), never linked to another user’s account; strict mode rejects it', async () => {
  const { h, bot, src } = await setup();
  const owner = await linked(h, bot, src, 2, '61000002');
  // The Trader ID is already linked: a click-less registration does not touch the binding.
  for (const click of ['0123456789abcdef0123456789abcdef', '']) {
    assert.equal((await pp(h, src, { event: 'reg', click_id: click, trader_id: '61000002' })).status, 200);
  }
  assert.equal((await me(h, bot, owner.token)).binding.state, 'account_bound');
  // A new Trader ID without click: kept with an unknown owner, no bot yet.
  assert.equal((await pp(h, src, { event: 'reg', trader_id: '61000003' })).status, 200);
  const ev = (await events(h)).find((e) => e.eventType === 'registration' && e.diagnosis === 'registration_unclaimed')!;
  assert.equal(ev.botId, 'global');
  assert.equal(ev.matchedUserDocId, null);
  // Strict mode: rejected, with the precise reason in "Integration errors".
  const OWNER = { uid: 'o', email: 'o@example.com', role: 'owner' as const, botPermissions: {} };
  await h.s.platform.updateSignals(OWNER, { ...(await h.s.platform.signals()), allowClicklessRegistration: false });
  assert.equal((await pp(h, src, { event: 'reg', click_id: '0123456789abcdef0123456789abcdef', trader_id: '61000004' })).status, 400);
  assert.equal((await pp(h, src, { event: 'reg', trader_id: '61000004' })).status, 400);
  const codes = (await errorCodes(h)).map((e) => e.code);
  for (const c of ['CLICK_NOT_FOUND', 'CLICK_MISSING']) assert.ok(codes.includes(c), c);
});

test('3, 4) FTD and repeat deposit with a valid click_id are credited', async () => {
  const { h, bot, src } = await setup();
  const u = await linked(h, bot, src, 4, '61000004');
  assert.equal((await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: '61000004', sumdep: '20' })).status, 200);
  assert.equal((await pp(h, src, { event: 'dep', click_id: u.click, trader_id: '61000004', sumdep: '35' })).status, 200);
  const d = (await me(h, bot, u.token)).onboarding;
  assert.equal(d.deposit.check, 'confirmed');
  assert.equal(d.deposit.depositsCount, 2);
  assert.equal(d.status, 'completed');
  assert.deepEqual((await events(h)).filter((e) => e.eventType !== 'registration').map((e) => e.diagnosis), ['matched_click', 'matched_click']);
});

test('5) repeat deposit WITHOUT click_id is matched by the uniquely linked Trader ID', async () => {
  const { h, bot, src } = await setup();
  const u = await linked(h, bot, src, 5, '61000005');
  await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: '61000005', sumdep: '50' });
  const r = await pp(h, src, { event: 'dep', trader_id: '61000005', sumdep: '70' });
  assert.equal(r.status, 200, 'before the fix: 400 UNKNOWN_CLICK');
  const dep = (await events(h)).find((e) => e.eventType === 'redeposit')!;
  assert.equal(dep.botId, bot.botId);
  assert.equal(dep.matchStatus, 'matched');
  assert.equal(dep.diagnosis, 'matched_trader_id');
  assert.equal(dep.routedBy, 'trader_id');
  assert.equal((await me(h, bot, u.token)).onboarding.deposit.depositsCount, 2);
  // The same with an unknown click_id value (e.g. the partner sends something else).
  await pp(h, src, { event: 'dep', click_id: 'ffffffffffffffffffffffffffffffff', trader_id: '61000005', sumdep: '15' });
  assert.equal((await me(h, bot, u.token)).onboarding.deposit.depositsCount, 3);
});

test('6) deposit with an EXPIRED click_id of the same user uses the safe Trader ID fallback (deposits after 90 days)', async () => {
  const { h, bot, src } = await setup();
  const u = await linked(h, bot, src, 6, '61000006');
  h.clock.advance(120 * 24 * 3600); // the original click_id (the one Pocket Partners keeps sending) has expired
  const r = await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: '61000006', sumdep: '40' });
  assert.equal(r.status, 200);
  await pp(h, src, { event: 'dep', click_id: u.click, trader_id: '61000006', sumdep: '40' });
  const s = await h.login(bot, 6); // session token expired too
  const d = (await me(h, bot, s.token)).onboarding;
  assert.equal(d.deposit.check, 'confirmed');
  assert.equal(d.deposit.depositsCount, 2);
  assert.ok((await events(h)).filter((e) => e.eventType !== 'registration').every((e) => e.diagnosis === 'matched_trader_id'));
});

test('7) deposit with ANOTHER user’s valid click_id is not credited and does not fall back to the Trader ID', async () => {
  const { h, bot, src } = await setup();
  const a = await linked(h, bot, src, 7, '61000007');
  const b = await h.login(bot, 8);
  const clickB = await register(h, bot, b.token);
  await pp(h, src, { event: 'ftd', click_id: clickB, trader_id: '61000007', sumdep: '100' });
  assert.equal((await me(h, bot, a.token)).onboarding.deposit.check, 'awaiting', 'the holder is not credited');
  assert.equal((await me(h, bot, b.token)).onboarding.deposit.depositsCount, 0, 'the click owner is not credited either');
  const ftd = (await events(h)).find((e) => e.eventType === 'ftd')!;
  assert.equal(ftd.diagnosis, 'click_other_user');
  assert.equal(ftd.matchStatus, 'conflict');
  // An EXPIRED click of another user is still evidence against the fallback.
  h.clock.advance(100 * 24 * 3600);
  await pp(h, src, { event: 'dep', click_id: clickB, trader_id: '61000007', sumdep: '10' });
  const a2 = await h.login(bot, 7);
  assert.equal((await me(h, bot, a2.token)).onboarding.deposit.depositsCount, 0);
  assert.ok((await errorCodes(h)).some((e) => e.code === 'CLICK_OTHER_USER'));
});

test('8) a Trader ID linked in several bots is ambiguous: a deposit without a click is NOT credited automatically', async () => {
  const h = harness();
  const b1 = await seedBot(h.s, 'botAmb1');
  const b2 = await seedBot(h.s, 'botAmb2');
  const src = await seedGlobalSource(h.s);
  const owner = { uid: 'o', role: 'owner' as const, botPermissions: {} };
  const u1 = await linked(h, b1, src, 11, '61000008');
  await h.login(b2, 12);
  const { TenantScope } = await import('../src/domain/tenant.ts');
  await h.s.binding.adminBind(owner, new TenantScope(b2.botId), { telegramId: 12, traderId: '61000008', reason: 'linked by support in the second bot' });
  const r = await pp(h, src, { event: 'ftd', trader_id: '61000008', sumdep: '25' });
  assert.equal(r.status, 200, 'stored for the admin, not lost');
  const ev = (await events(h)).find((e) => e.eventType === 'ftd')!;
  assert.equal(ev.diagnosis, 'trader_ambiguous');
  assert.equal(ev.botId, 'global');
  assert.equal(ev.matchedUserDocId, null);
  assert.equal((await me(h, b1, u1.token)).onboarding.deposit.check, 'awaiting');
  assert.ok((await errorCodes(h)).some((e) => e.code === 'TRADER_AMBIGUOUS' && !e.message.includes('61000008')), 'Trader ID masked in the log');
  // With a valid click_id the click decides as usual.
  await pp(h, src, { event: 'ftd', click_id: u1.click, trader_id: '61000008', sumdep: '25' });
  assert.equal((await me(h, b1, u1.token)).onboarding.deposit.check, 'confirmed');
});

test('9) a deposit for a Trader ID that nobody linked does not open access — it waits (Pending) and is credited once the Trader ID is linked', async () => {
  const { h, bot, src } = await setup();
  const s = await h.login(bot, 13);
  const click = await register(h, bot, s.token);
  const r = await pp(h, src, { event: 'ftd', trader_id: '61000009', sumdep: '500' });
  assert.equal(r.status, 200);
  const ev = (await events(h)).find((e) => e.eventType === 'ftd')!;
  assert.equal(ev.diagnosis, 'trader_not_bound');
  assert.equal(ev.botId, 'global');
  assert.equal((await me(h, bot, s.token)).onboarding.status, 'registration_started', 'nothing opened');
  assert.ok((await errorCodes(h)).some((e) => e.code === 'TRADER_NOT_BOUND'));
  // The user's own registration arrives and they link the Trader ID → the pending FTD is credited.
  await pp(h, src, { event: 'reg', click_id: click, trader_id: '61000009' });
  await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(s.token), body: { traderId: '61000009' } });
  const o = (await me(h, bot, s.token)).onboarding;
  assert.equal(o.deposit.check, 'confirmed');
  assert.equal(o.status, 'completed');
  const promoted = (await events(h)).find((e) => e.eventType === 'ftd')!;
  assert.equal(promoted.botId, bot.botId);
  assert.equal(promoted.diagnosis, 'matched_pending');
  // A deposit with the user's own valid click before linking is kept and credited after linking (unchanged rule).
  const s2 = await h.login(bot, 14);
  const c2 = await register(h, bot, s2.token);
  await pp(h, src, { event: 'ftd', click_id: c2, trader_id: '61000010', sumdep: '30' });
  assert.equal((await events(h)).find((e) => e.amount === 30)!.diagnosis, 'deposit_unmatched');
  await pp(h, src, { event: 'reg', click_id: c2, trader_id: '61000010' });
  await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(s2.token), body: { traderId: '61000010' } });
  assert.equal((await me(h, bot, s2.token)).onboarding.status, 'completed');
});

test('10) a re-delivered FTD never makes a second first deposit — with or without click_id', async () => {
  const { h, bot, src } = await setup();
  const u = await linked(h, bot, src, 15, '61000011');
  await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: '61000011', sumdep: '60' });
  const again = await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: '61000011', sumdep: '60' });
  assert.equal(again.json.duplicate, true);
  const noClick = await pp(h, src, { event: 'ftd', trader_id: '61000011', sumdep: '60' });
  assert.equal(noClick.json.duplicate, true, 'routed to the same bot → same event key');
  const d = (await me(h, bot, u.token)).onboarding.deposit;
  assert.equal(d.depositsCount, 1);
  assert.equal(d.ftdAmount, 60);
});

test('several bots, one global source: click-less deposits go to the single bot where the Trader ID is linked', async () => {
  const h = harness();
  const bots = [await seedBot(h.s, 'botMultiA'), await seedBot(h.s, 'botMultiB'), await seedBot(h.s, 'botMultiC')];
  const src = await seedGlobalSource(h.s);
  const us = [];
  for (const [i, b] of bots.entries()) us.push({ b, ...(await linked(h, b, src, 500, `6200000${i}`)) });
  for (const [i, u] of us.entries()) {
    await pp(h, src, { event: 'ftd', trader_id: `6200000${i}`, sumdep: String(11 + i) }); // no click at all
    await pp(h, src, { event: 'dep', trader_id: `6200000${i}`, sumdep: '5' });
  }
  for (const [i, u] of us.entries()) {
    const d = (await me(h, u.b, u.token)).onboarding.deposit;
    assert.equal(d.ftdAmount, 11 + i, `bot ${i}: its own FTD only`);
    assert.equal(d.depositsCount, 2);
  }
  const byBot = (await events(h)).filter((e) => e.eventType !== 'registration');
  for (const [i, u] of us.entries()) assert.equal(byBot.filter((e) => e.botId === u.b.botId).length, 2, `bot ${i}`);
});
