import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { bearer, harness, seedBot, seedSource, type Harness, type TestBot } from './helpers.ts';
import { C } from '../src/storage/collections.ts';
import { TenantScope } from '../src/domain/tenant.ts';
import { isModuleAccessible } from '../src/binding/access.ts';
import { canTransition } from '../src/binding/state-machine.ts';
import { AppError } from '../src/lib/errors.ts';
import { botConfig } from './helpers.ts';

async function setup() {
  const h = harness();
  const bot = await seedBot(h.s, 'botBind');
  const src = await seedSource(h.s, bot.botId, 'partner-a');
  return { h, bot, src };
}

const pb = (h: Harness, sourceId: string, secret: string, params: Record<string, string>) =>
  h.request('GET', `/postback/${sourceId}?${new URLSearchParams({ token: secret, ...params })}`, { ip: '192.0.2.1' });

async function submit(h: Harness, bot: TestBot, token: string, traderId: string) {
  return h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(token), body: { traderId } });
}

async function state(h: Harness, botId: string, tgId: number) {
  return (await h.store.get<{ bindingState: string; traderId: string | null }>(C.users, `${botId}_${tgId}`))!;
}

test('first launch: telegram_created → waiting_for_trader_id when module is on', async () => {
  const { h, bot } = await setup();
  const { body } = await h.login(bot, 1);
  assert.equal(body.binding.state, 'waiting_for_trader_id');
  assert.equal(body.access.academy, true);
  assert.equal(body.access.simulator, true);
  assert.equal(body.access.signals, false, 'signals gated until account_bound');
});

test('happy path: event already received → immediate binding', async () => {
  const { h, bot, src } = await setup();
  assert.equal((await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T1001', event_id: 'e1' })).status, 200);
  const { token } = await h.login(bot, 2);
  const r = await submit(h, bot, token, 'T1001');
  assert.equal(r.status, 200);
  assert.equal(r.json.binding.state, 'account_bound');
  assert.equal(r.json.binding.traderIdMasked, '••••1001');
  const me = await h.request('GET', `/api/miniapp/${bot.botId}/me`, { headers: bearer(token) });
  assert.equal(me.json.access.signals, true);
});

test('delayed event: pending → bound automatically when the event arrives (no re-registration)', async () => {
  const { h, bot, src } = await setup();
  const { token } = await h.login(bot, 3);
  const r = await submit(h, bot, token, 'T2002');
  assert.equal(r.json.binding.state, 'registration_pending');
  h.clock.advance(3600);
  await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T2002', event_id: 'e2' });
  assert.equal((await state(h, bot.botId, 3)).bindingState, 'account_bound');
});

test('recheck: cooldown is enforced, then re-check works', async () => {
  const { h, bot } = await setup();
  const { token } = await h.login(bot, 4);
  await submit(h, bot, token, 'T3003');
  const first = await h.request('POST', `/api/miniapp/${bot.botId}/binding/recheck`, { headers: bearer(token) });
  assert.equal(first.status, 200);
  const tooSoon = await h.request('POST', `/api/miniapp/${bot.botId}/binding/recheck`, { headers: bearer(token) });
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.json.error.code, 'RECHECK_TOO_SOON');
  assert.equal(tooSoon.json.binding.state, 'registration_pending');
  h.clock.advance(31);
  assert.equal((await h.request('POST', `/api/miniapp/${bot.botId}/binding/recheck`, { headers: bearer(token) })).status, 200);
});

test('repeated webhook/postback: 5 deliveries → one event, one binding, deliveryCount = 5', async () => {
  const { h, bot, src } = await setup();
  const { token } = await h.login(bot, 5);
  await submit(h, bot, token, 'T4004');
  for (let i = 0; i < 5; i++) {
    const r = await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T4004', event_id: 'dup-1' });
    assert.equal(r.status, 200);
    assert.equal(r.json.duplicate, i > 0);
  }
  const events = await h.store.query<{ deliveryCount: number }>(C.postbackEvents, {});
  assert.equal(events.length, 1);
  assert.equal(events[0]!.data.deliveryCount, 5);
  assert.equal((await h.store.query(C.traderBindings, {})).length, 1);
});

test('concurrent duplicate postbacks: 10 in parallel → processed exactly once', async () => {
  const { h, bot, src } = await setup();
  const { token } = await h.login(bot, 6);
  await submit(h, bot, token, 'T5005');
  const rs = await Promise.all(Array.from({ length: 10 }, () => pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T5005', event_id: 'par-1' })));
  assert.equal(rs.filter((r) => r.json.duplicate === false).length, 1);
  assert.equal((await h.store.query(C.traderBindings, {})).length, 1);
});

test("someone else's Trader ID: A is bound, B tries it → binding_conflict, A unchanged", async () => {
  const { h, bot, src } = await setup();
  await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T6006', event_id: 'e6' });
  const a = await h.login(bot, 61);
  await submit(h, bot, a.token, 'T6006');
  const b = await h.login(bot, 62);
  const r = await submit(h, bot, b.token, 'T6006');
  assert.equal(r.json.binding.state, 'binding_conflict');
  assert.equal(r.json.binding.showSupport, true);
  const sa = await state(h, bot.botId, 61);
  assert.equal(sa.bindingState, 'account_bound');
  assert.equal(sa.traderId, 't6006');
});

test('one Trader ID claimed by two Telegram accounts without click_id → nobody gets it, both manual_review', async () => {
  const { h, bot, src } = await setup();
  const a = await h.login(bot, 71);
  const b = await h.login(bot, 72);
  await submit(h, bot, a.token, 'T7007'); // attacker first
  await submit(h, bot, b.token, 'T7007');
  await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T7007', event_id: 'e7' });
  assert.equal((await state(h, bot.botId, 71)).bindingState, 'manual_review');
  assert.equal((await state(h, bot.botId, 72)).bindingState, 'manual_review');
  assert.equal((await h.store.query(C.traderBindings, {})).length, 0, 'no automatic binding');
});

test('click_id proof: registration via B’s personal link → B binds; A who claimed it first gets conflict', async () => {
  const { h, bot, src } = await setup();
  const a = await h.login(bot, 81);
  const b = await h.login(bot, 82);
  const click = await h.request('POST', `/api/miniapp/${bot.botId}/binding/click`, { headers: bearer(b.token) });
  assert.match(click.json.clickId, /^[A-Za-z0-9_-]{22}$/, '128-bit base64url click_id');
  assert.ok(click.json.partnerLink.includes(click.json.clickId));
  await submit(h, bot, a.token, 'T8008');
  await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T8008', event_id: 'e8', sub_id: click.json.clickId });
  assert.equal((await state(h, bot.botId, 81)).bindingState, 'binding_conflict');
  assert.equal((await state(h, bot.botId, 82)).bindingState, 'registration_verified');
  const r = await submit(h, bot, b.token, 'T8008');
  assert.equal(r.json.binding.state, 'account_bound');
});

test('registration_verified + wrong Trader ID → mismatch error, state kept; 5 mismatches → manual_review', async () => {
  const { h, bot, src } = await setup();
  const u = await h.login(bot, 91);
  const click = await h.request('POST', `/api/miniapp/${bot.botId}/binding/click`, { headers: bearer(u.token) });
  await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T9009', event_id: 'e9', sub_id: click.json.clickId });
  for (let i = 0; i < 4; i++) {
    const r = await submit(h, bot, u.token, `WRONG${i}`);
    assert.equal(r.status, 409);
    assert.equal(r.json.error.code, 'TRADER_ID_MISMATCH');
    assert.equal(r.json.binding.state, 'registration_verified');
  }
  const last = await submit(h, bot, u.token, 'WRONG9');
  assert.equal(last.json.binding.state, 'manual_review');
});

test('bound user cannot replace their Trader ID themselves', async () => {
  const { h, bot, src } = await setup();
  await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T1111', event_id: 'e11' });
  await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T2222', event_id: 'e12' });
  const u = await h.login(bot, 11);
  await submit(h, bot, u.token, 'T1111');
  const r = await submit(h, bot, u.token, 'T2222');
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'TRADER_ID_CHANGE_FORBIDDEN');
  assert.equal((await state(h, bot.botId, 11)).traderId, 't1111');
});

test('admin re-binding: requires permission and reason, writes audit log', async () => {
  const { h, bot, src } = await setup();
  await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'T3333', event_id: 'e13' });
  const a = await h.login(bot, 12);
  const b = await h.login(bot, 13);
  await submit(h, bot, a.token, 'T3333');
  await submit(h, bot, b.token, 'T3333'); // conflict
  const scope = new TenantScope(bot.botId);
  const manager = { uid: 'm1', role: 'manager' as const, botPermissions: { [bot.botId]: ['users.view' as const] } };
  await assert.rejects(h.s.binding.adminBind(manager, scope, { telegramId: 13, traderId: 'T3333', reason: 'checked' }), (e: AppError) => e.code === 'FORBIDDEN');
  const owner = { uid: 'owner', role: 'owner' as const, botPermissions: {} };
  await assert.rejects(h.s.binding.adminBind(owner, scope, { telegramId: 13, traderId: 'T3333', reason: '' }), (e: AppError) => e.code === 'BAD_REQUEST');
  await assert.rejects(h.s.binding.adminBind(owner, scope, { telegramId: 13, traderId: 'T3333', reason: 'support ticket #42' }), (e: AppError) => e.code === 'ALREADY_EXISTS');
  await h.s.binding.adminBind(owner, scope, { telegramId: 13, traderId: 'T3333', reason: 'support ticket #42', releaseFromOther: true });
  assert.equal((await state(h, bot.botId, 13)).bindingState, 'account_bound');
  assert.equal((await state(h, bot.botId, 12)).bindingState, 'waiting_for_trader_id');
  const audit = await h.store.query<{ action: string; reason: string }>(C.auditLogs, {});
  assert.deepEqual(audit.map((x) => x.data.action).sort(), ['binding.admin_bind', 'binding.release']);
  assert.ok(audit.every((x) => x.data.reason === 'support ticket #42'));
  assert.equal(JSON.stringify(audit).includes('t3333'), false, 'audit stores masked Trader IDs');
});

test('postback source checks: wrong secret 401 (and logged), unknown source 404, bad format 400', async () => {
  const { h, src } = await setup();
  assert.equal((await pb(h, src.sourceId, 'wrong', { event: 'reg', trader_id: 'T1' })).status, 401);
  assert.equal((await pb(h, 'no-such-source', src.secret, { event: 'reg', trader_id: 'T1' })).status, 404);
  assert.equal((await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'bad id with spaces' })).status, 400);
  assert.equal((await pb(h, src.sourceId, src.secret, { trader_id: 'T1' })).status, 400, 'event type missing');
  assert.equal((await pb(h, src.sourceId, src.secret, { event: 'ftd', trader_id: 'T1' })).status, 400, 'financial event without id/timestamp cannot be deduplicated');
  const errs = await h.store.query(C.errorLogs, {});
  assert.equal(errs.length, 1, 'failed authentication recorded once per fingerprint');
  assert.equal((await h.store.query(C.postbackEvents, {})).length, 0, 'unauthenticated events are never stored');
});

test('HMAC-signed source: valid signature accepted, any change rejected', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botHmac');
  const src = await seedSource(h.s, bot.botId, 'partner-h', 'hmac_sha256');
  const body = JSON.stringify({ event: 'reg', trader_id: 'H100', event_id: 'h1' });
  const sig = createHmac('sha256', src.secret).update(body).digest('hex');
  const okRes = await h.request('POST', `/postback/${src.sourceId}`, { raw: body, headers: { 'x-signature': sig } });
  assert.equal(okRes.status, 200);
  const tampered = body.replace('H100', 'H101');
  assert.equal((await h.request('POST', `/postback/${src.sourceId}`, { raw: tampered, headers: { 'x-signature': sig } })).status, 401);
});

test('events arriving before the user exists are stored and used later', async () => {
  const { h, bot, src } = await setup();
  await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'EARLY1', event_id: 'early' });
  const ev = await h.store.query<{ matchStatus: string }>(C.postbackEvents, {});
  assert.equal(ev[0]!.data.matchStatus, 'unmatched');
  const u = await h.login(bot, 14);
  assert.equal((await submit(h, bot, u.token, 'EARLY1')).json.binding.state, 'account_bound');
});

test('financial events never change access; Academy and demo stay open without deposit', async () => {
  const { h, bot, src } = await setup();
  const u = await h.login(bot, 15);
  await submit(h, bot, u.token, 'FIN1');
  await pb(h, src.sourceId, src.secret, { event: 'ftd', trader_id: 'FIN1', event_id: 'f1' });
  await pb(h, src.sourceId, src.secret, { event: 'dep', trader_id: 'FIN1', event_id: 'f2' });
  assert.equal((await state(h, bot.botId, 15)).bindingState, 'registration_pending', 'deposit does not bind or unlock');
  const me = await h.request('GET', `/api/miniapp/${bot.botId}/me`, { headers: bearer(u.token) });
  assert.equal(me.json.access.academy, true);
  assert.equal(me.json.access.simulator, true);

  // Even a misconfiguration that tries to gate Academy cannot close it.
  const cfg = botConfig({ accountBinding: { ...botConfig().accountBinding, gatedModules: ['academy', 'simulator', 'signals'] } });
  assert.equal(isModuleAccessible('academy', cfg, 'waiting_for_trader_id'), true);
  assert.equal(isModuleAccessible('simulator', cfg, 'waiting_for_trader_id'), true);
  assert.equal(isModuleAccessible('signals', cfg, 'waiting_for_trader_id'), false);
});

test('a click_id from another bot is ignored (tenant isolation in matching)', async () => {
  const { h, bot, src } = await setup();
  const other = await seedBot(h.s, 'botOther');
  const o = await h.login(other, 16);
  const click = await h.request('POST', `/api/miniapp/${other.botId}/binding/click`, { headers: bearer(o.token) });
  await pb(h, src.sourceId, src.secret, { event: 'reg', trader_id: 'XBOT1', event_id: 'x1', sub_id: click.json.clickId });
  assert.equal((await state(h, other.botId, 16)).bindingState, 'waiting_for_trader_id');
  const u = await h.login(bot, 17);
  assert.equal((await submit(h, bot, u.token, 'XBOT1')).json.binding.state, 'account_bound');
});

test('state machine rejects illegal automatic transitions', () => {
  assert.equal(canTransition('account_bound', 'registration_pending'), false);
  assert.equal(canTransition('manual_review', 'account_bound'), false, 'only an admin can resolve review');
  assert.equal(canTransition('manual_review', 'account_bound', 'admin'), true);
  assert.equal(canTransition('waiting_for_trader_id', 'registration_pending'), true);
});
