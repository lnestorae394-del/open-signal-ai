import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHmac } from 'node:crypto';
import { bearer, harness, seedBot, seedGlobalSource, seedSource, type Harness, type TestBot } from './helpers.ts';
import { C } from '../src/storage/collections.ts';
import { TenantScope } from '../src/domain/tenant.ts';
import { canTransition } from '../src/binding/state-machine.ts';
import { AppError } from '../src/lib/errors.ts';
import { normalizeEvent } from '../src/binding/postback.ts';
import type { PartnerSource } from '@open-signal/shared';

/**
 * Onboarding step 2 (Trader ID verification) and the postback that feeds it.
 * The rule under test: a Trader ID is linked only when the partner confirmed a
 * registration of that Trader ID made through THIS user's personal click_id.
 */

async function setup() {
  const h = harness();
  const bot = await seedBot(h.s, 'botBind');
  const src = await seedGlobalSource(h.s);
  return { h, bot, src };
}

/** Pocket Partners style request: secret in "key", event value in "event". */
const pp = (h: Harness, src: { sourceId: string; secret: string }, params: Record<string, string>) =>
  h.request('GET', `/postback/${src.sourceId}?${new URLSearchParams({ key: src.secret, ...params })}`, { ip: '192.0.2.1' });

const submit = (h: Harness, bot: TestBot, token: string, traderId: string) =>
  h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(token), body: { traderId } });

/** Step 1 as the Mini App does it: returns the personal click_id from the partner link. */
async function register(h: Harness, bot: TestBot, token: string): Promise<string> {
  const r = await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/register`, { headers: bearer(token) });
  assert.equal(r.status, 200);
  return new URL(r.json.link).searchParams.get('sub')!;
}

const me = (h: Harness, bot: TestBot, token: string) => h.request('GET', `/api/miniapp/${bot.botId}/me`, { headers: bearer(token) });
const user = async (h: Harness, botId: string, tgId: number) =>
  (await h.store.get<{ bindingState: string; traderId: string | null; lastBindingError?: { code: string } | null; deposit?: { conflict?: boolean } }>(C.users, `${botId}_${tgId}`))!;

test('new user starts at step 1; signals and academy are closed until onboarding is completed', async () => {
  const { h, bot } = await setup();
  const { body, token } = await h.login(bot, 1);
  assert.equal(body.onboarding.status, 'registration');
  assert.equal(body.binding.state, 'waiting_for_trader_id');
  for (const [m, p] of [['POST', 'signals'], ['GET', 'academy']] as const) {
    const r = await h.request(m, `/api/miniapp/${bot.botId}/${p}`, { headers: bearer(token), body: { instrumentId: 'EURUSD', periodSec: 60 } });
    assert.equal(r.status, 403, p);
    assert.equal(r.json.error.code, 'ONBOARDING_REQUIRED');
  }
});

test('happy path: register via own link → partner confirms with that click_id → Trader ID linked → step 3', async () => {
  const { h, bot, src } = await setup();
  const { token } = await h.login(bot, 2);
  const click = await register(h, bot, token);
  assert.equal((await me(h, bot, token)).json.onboarding.status, 'registration_started');
  assert.equal((await pp(h, src, { event: 'reg', click_id: click, trader_id: '70001234' })).status, 200);
  await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/returned`, { headers: bearer(token) });
  assert.equal((await me(h, bot, token)).json.onboarding.status, 'trader_id');
  const r = await submit(h, bot, token, '70001234');
  assert.equal(r.status, 200);
  assert.equal(r.json.binding.state, 'account_bound');
  assert.equal(r.json.onboarding.status, 'deposit', 'a confirmed first deposit is still required');
  assert.equal(r.json.onboarding.verification, 'confirmed');
  const ev = (await h.store.query<{ matchStatus: string }>(C.postbackEvents, {}))[0]!;
  assert.equal(ev.data.matchStatus, 'matched');
});

test('format only is never enough: no registration postback → REGISTRATION_NOT_CONFIRMED, nothing linked, retry goes back to step 1', async () => {
  const { h, bot, src } = await setup();
  const { token } = await h.login(bot, 3);
  const click = await register(h, bot, token);
  await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/returned`, { headers: bearer(token) });
  assert.equal((await submit(h, bot, token, 'bad id!')).json.error.code, 'TRADER_ID_INVALID');
  const r = await submit(h, bot, token, '70002222');
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'REGISTRATION_NOT_CONFIRMED');
  assert.equal(r.json.binding.state, 'waiting_for_trader_id');
  assert.equal((await user(h, bot.botId, 3)).traderId, null, 'no fake registration');
  // "Try again" → step 1, Telegram ID, click_id and the reason are kept
  const back = await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/restart`, { headers: bearer(token) });
  assert.equal(back.json.onboarding.status, 'registration_started');
  assert.equal(back.json.onboarding.lastError, 'REGISTRATION_NOT_CONFIRMED');
  assert.equal(await register(h, bot, token), click, 'the same personal click_id is reused');
  // The partner confirms later with this user's click_id → linked automatically (the user already entered it).
  await pp(h, src, { event: 'reg', click_id: click, trader_id: '70002222' });
  assert.equal((await user(h, bot.botId, 3)).bindingState, 'account_bound');
});

test("someone else's registration: Trader ID registered via user A's link cannot be linked by user B", async () => {
  const { h, bot, src } = await setup();
  const a = await h.login(bot, 4);
  const b = await h.login(bot, 5);
  const clickA = await register(h, bot, a.token);
  await register(h, bot, b.token);
  await pp(h, src, { event: 'reg', click_id: clickA, trader_id: '70003333' });
  const rb = await submit(h, bot, b.token, '70003333');
  assert.equal(rb.json.error.code, 'CLICK_MISMATCH');
  assert.equal((await user(h, bot.botId, 5)).traderId, null);
  const ra = await submit(h, bot, a.token, '70003333');
  assert.equal(ra.json.binding.state, 'account_bound');
  // Already linked to A → B gets TRADER_ID_TAKEN
  assert.equal((await submit(h, bot, b.token, '70003333')).json.error.code, 'TRADER_ID_TAKEN');
  assert.equal((await user(h, bot.botId, 4)).traderId, '70003333');
});

test('registration without any click_id (Academy rule): the first user who enters it links it; strict mode refuses', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botLegacy');
  const src = await seedSource(h.s, bot.botId, 'partner-legacy'); // a per-bot source: click_id optional
  const pb = (p: Record<string, string>) => h.request('GET', `/postback/${src.sourceId}?${new URLSearchParams({ token: src.secret, ...p })}`);
  assert.equal((await pb({ event: 'reg', trader_id: 'NOCLICK1' })).status, 200);
  const { token } = await h.login(bot, 6);
  assert.equal((await submit(h, bot, token, 'NOCLICK1')).json.binding.state, 'account_bound');
  const second = await h.login(bot, 7);
  assert.equal((await submit(h, bot, second.token, 'NOCLICK1')).json.error.code, 'TRADER_ID_TAKEN', 'one account per Trader ID');
  // Strict mode: a registration without our click_id is not enough.
  const owner = { uid: 'o', email: 'o@example.com', role: 'owner' as const, botPermissions: {} };
  await h.s.platform.updateSignals(owner, { ...(await h.s.platform.signals()), allowClicklessRegistration: false });
  assert.equal((await pb({ event: 'reg', trader_id: 'NOCLICK2' })).status, 200);
  const third = await h.login(bot, 8);
  assert.equal((await submit(h, bot, third.token, 'NOCLICK2')).json.error.code, 'CLICK_MISMATCH');
});

test('bound user cannot replace their Trader ID; relaunch and another device keep everything', async () => {
  const { h, bot, src } = await setup();
  const first = await h.login(bot, 7);
  const click = await register(h, bot, first.token);
  await pp(h, src, { event: 'reg', click_id: click, trader_id: '70004444' });
  await submit(h, bot, first.token, '70004444');
  const r = await submit(h, bot, first.token, '70005555');
  assert.equal(r.status, 409);
  assert.equal(r.json.error.code, 'TRADER_ID_CHANGE_FORBIDDEN');
  h.clock.advance(3 * 86_400);
  const other = await h.login(bot, 7); // new Telegram session, e.g. another phone
  assert.equal(other.body.onboarding.status, 'deposit');
  assert.equal(other.body.user.traderId, '70004444');
  assert.equal(other.body.onboarding.verification, 'confirmed');
});

async function boundUser(h: Harness, bot: TestBot, src: { sourceId: string; secret: string }, tgId: number, tid: string) {
  const s = await h.login(bot, tgId);
  const click = await register(h, bot, s.token);
  await pp(h, src, { event: 'reg', click_id: click, trader_id: tid });
  assert.equal((await submit(h, bot, s.token, tid)).status, 200);
  return { ...s, click };
}

test('FTD: confirmed only from the postback (≥ $10) → onboarding completed; redelivery counted once; amount cannot be replaced', async () => {
  const { h, bot, src } = await setup();
  const u = await boundUser(h, bot, src, 8, '70006666');
  let m = (await me(h, bot, u.token)).json;
  assert.equal(m.onboarding.deposit.check, 'awaiting');
  for (let i = 0; i < 3; i++) assert.equal((await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: '70006666', sumdep: '25' })).status, 200);
  m = (await me(h, bot, u.token)).json;
  assert.equal(m.onboarding.deposit.check, 'confirmed');
  assert.equal(m.onboarding.deposit.ftdAmount, 25);
  assert.equal(m.onboarding.deposit.depositsCount, 1, 'three deliveries of one FTD = one deposit');
  assert.equal(m.onboarding.status, 'completed');
  const ftd = (await h.store.query<{ deliveryCount: number; eventType: string }>(C.postbackEvents, { where: [{ field: 'eventType', op: '==', value: 'ftd' }] }))[0]!;
  assert.equal(ftd.data.deliveryCount, 3);
  // A re-delivery with another amount never overwrites the first one; it is flagged and audited.
  await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: '70006666', sumdep: '9000' });
  m = (await me(h, bot, u.token)).json;
  assert.equal(m.onboarding.deposit.ftdAmount, 25);
  assert.equal((await user(h, bot.botId, 8)).deposit?.conflict, true);
  assert.equal(m.onboarding.status, 'completed', 'once completed, onboarding stays completed');
  const audit = (await h.store.query<{ action: string }>(C.auditLogs, {})).map((a) => a.data.action);
  assert.ok(audit.includes('finance.ftd'));
  assert.ok(audit.includes('finance.amount_conflict'));
  const errs = await h.store.query<{ code: string }>(C.errorLogs, {});
  assert.ok(errs.some((e) => e.data.code === 'AMOUNT_CONFLICT'));
});

test('FTD below $10 → error; FTD without amount → checking; neither opens the app', async () => {
  const { h, bot, src } = await setup();
  const low = await boundUser(h, bot, src, 9, '70007777');
  await pp(h, src, { event: 'ftd', click_id: low.click, trader_id: '70007777', sumdep: '5' });
  let m = (await me(h, bot, low.token)).json;
  assert.equal(m.onboarding.deposit.check, 'error');
  assert.equal(m.onboarding.deposit.checkReason, 'below_threshold');
  assert.equal(m.onboarding.status, 'deposit');
  const noAmount = await boundUser(h, bot, src, 10, '70008888');
  await pp(h, src, { event: 'ftd', click_id: noAmount.click, trader_id: '70008888' });
  m = (await me(h, bot, noAmount.token)).json;
  assert.equal(m.onboarding.deposit.check, 'checking');
  assert.equal(m.onboarding.status, 'deposit');
});

const OWNER = { uid: 'owner-1', role: 'owner' as const, botPermissions: {} };
type Ev = { eventType: string; amount: number | null; possibleDuplicateOf?: string | null; excluded?: unknown; matchedUserDocId: string | null };
const events = async (h: Harness, type: string) =>
  (await h.store.query<Ev>(C.postbackEvents, { where: [{ field: 'eventType', op: '==', value: type }] })).sort((a, b) => String(a.data['receivedAt' as never]).localeCompare(String(b.data['receivedAt' as never])));

test('repeat deposit with the same amount within 10 minutes (no event id): kept, NOT counted twice automatically; nothing is lost', async () => {
  const { h, bot, src } = await setup();
  const u = await boundUser(h, bot, src, 11, '70009999');
  await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: '70009999', sumdep: '50' });
  const dep = () => pp(h, src, { event: 'dep', click_id: u.click, trader_id: '70009999', sumdep: '100' });
  assert.equal((await dep()).json.duplicate, false);
  h.clock.advance(60);
  assert.equal((await dep()).status, 200, 'same amount one minute later: stored');
  h.clock.advance(1);
  assert.equal((await pp(h, src, { event: 'dep', click_id: u.click, trader_id: '70009999', sumdep: '40' })).json.duplicate, false);
  h.clock.advance(11 * 60);
  assert.equal((await dep()).json.duplicate, false, 'same amount after the window: a new deposit');
  const d = (await me(h, bot, u.token)).json.onboarding.deposit;
  assert.equal(d.depositsCount, 4, 'FTD + 3 repeat deposits; the possible re-delivery waits for the admin');
  assert.equal(d.ftdAmount, 50, 'FTD stays the first deposit');
  const deps = await events(h, 'redeposit');
  assert.equal(deps.length, 4, 'every delivery is stored');
  assert.deepEqual(deps.map((e) => Boolean(e.data.possibleDuplicateOf)), [false, true, false, false]);
  const errs = await h.store.query<{ code: string }>(C.errorLogs, { where: [{ field: 'module', op: '==', value: 'postback' }] });
  assert.ok(errs.some((e) => e.data.code === 'POSSIBLE_DUPLICATE'), 'admin sees it in "Integration errors"');
});

test('admin confirms a held repeat deposit (reason + audit) or excludes any deposit; totals are recomputed, nothing deleted', async () => {
  const { h, bot, src } = await setup();
  const u = await boundUser(h, bot, src, 14, '70011111');
  await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: '70011111', sumdep: '20' });
  await pp(h, src, { event: 'dep', click_id: u.click, trader_id: '70011111', sumdep: '30' });
  h.clock.advance(5);
  await pp(h, src, { event: 'dep', click_id: u.click, trader_id: '70011111', sumdep: '30' });
  const held = (await events(h, 'redeposit')).find((e) => e.data.possibleDuplicateOf)!;
  assert.deepEqual((held.data.excluded as { reason: string }).reason, 'possible_repeat');
  assert.equal((await me(h, bot, u.token)).json.onboarding.deposit.depositsCount, 2);
  await assert.rejects(h.s.binding.adminSetEventExcluded(OWNER, held.id, { excluded: false, reason: '' }), (e: AppError) => e.code === 'BAD_REQUEST');
  const manager = { uid: 'm1', role: 'manager' as const, botPermissions: { [bot.botId]: ['users.view' as const] } };
  await assert.rejects(h.s.binding.adminSetEventExcluded(manager, held.id, { excluded: false, reason: 'it was a real deposit' }), (e: AppError) => e.code === 'FORBIDDEN');
  await h.s.binding.adminSetEventExcluded(OWNER, held.id, { excluded: false, reason: 'it was a real deposit' });
  assert.equal((await me(h, bot, u.token)).json.onboarding.deposit.depositsCount, 3);
  assert.equal((await me(h, bot, u.token)).json.onboarding.deposit.ftdAmount, 20);
  await h.s.binding.adminSetEventExcluded(OWNER, held.id, { excluded: true, reason: 'retry of the same deposit after all' });
  assert.equal((await me(h, bot, u.token)).json.onboarding.deposit.depositsCount, 2);
  assert.equal((await events(h, 'redeposit')).length, 2, 'the event is kept');
  const audit = await h.store.query<{ action: string; reason: string }>(C.auditLogs, {});
  assert.ok(audit.some((a) => a.data.action === 'finance.event_restored' && a.data.reason === 'it was a real deposit'));
  assert.ok(audit.some((a) => a.data.action === 'finance.event_excluded'));
  // Registration is not a deposit: cannot be excluded.
  const reg = (await events(h, 'registration'))[0]!;
  await assert.rejects(h.s.binding.adminSetEventExcluded(OWNER, reg.id, { excluded: true, reason: 'not a deposit' }), (e: AppError) => e.code === 'VALIDATION_FAILED');
});

test('event keys: registration and FTD are one per Trader ID even if an event id is sent; repeat deposits use the id/time when there is one', () => {
  const source = {
    id: 's', botId: '*', name: 's', enabled: true, ipAllowlist: [], eventTypeMap: { reg: 'registration', ftd: 'ftd', dep: 'redeposit' },
    auth: { method: 'shared_secret', location: 'query', name: 'key', secretEnc: 'x' },
    mapping: { eventType: 'event', traderId: 'trader_id', clickId: 'click_id', amount: 'sumdep', currency: null, eventId: 'eid', occurredAt: 'ts', partnerId: null },
  } as unknown as PartnerSource;
  const key = (p: Record<string, string>) => normalizeEvent(source, { trader_id: 'T100', ...p }, /^[a-z0-9]+$/i);
  assert.equal(key({ event: 'ftd', eid: 'a1' }).eventKey, key({ event: 'ftd', eid: 'b2' }).eventKey, 'two ids can never make a second FTD');
  assert.equal(key({ event: 'reg', eid: 'a1' }).eventKey, 'reg:t100');
  assert.notEqual(key({ event: 'dep', eid: 'a1' }).eventKey, key({ event: 'dep', eid: 'b2' }).eventKey);
  assert.equal(key({ event: 'dep', eid: 'a1' }).noNaturalKey, false);
  assert.equal(key({ event: 'dep', ts: '2026-11-16T10:00:00Z' }).noNaturalKey, false);
  const plain = key({ event: 'dep', sumdep: '100' });
  assert.equal(plain.noNaturalKey, true, 'Pocket Partners style: no id, no time → every delivery is its own event');
  assert.equal(plain.similarKey, 'redeposit:t100:100:');
});

test('deposit order: a repeat deposit never becomes the FTD; only repeat deposits and no FTD event → "checking", not confirmed', async () => {
  const { h, bot, src } = await setup();
  const u = await boundUser(h, bot, src, 15, '70012222');
  await pp(h, src, { event: 'dep', click_id: u.click, trader_id: '70012222', sumdep: '500' });
  let d = (await me(h, bot, u.token)).json.onboarding;
  assert.equal(d.deposit.check, 'checking', 'a repeat deposit without the FTD event does not open the app');
  assert.equal(d.deposit.checkReason, 'no_ftd_event');
  assert.equal(d.status, 'deposit');
  h.clock.advance(30);
  await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: '70012222', sumdep: '15' });
  d = (await me(h, bot, u.token)).json.onboarding;
  assert.equal(d.deposit.ftdAmount, 15, 'the FTD amount comes only from the ftd event');
  assert.equal(d.deposit.check, 'confirmed');
  assert.equal(d.deposit.depositsCount, 2);
  assert.equal(d.status, 'completed');
});

test('deposits that arrive BEFORE the user links the Trader ID are credited after linking', async () => {
  const { h, bot, src } = await setup();
  const s = await h.login(bot, 16);
  const click = await register(h, bot, s.token);
  await pp(h, src, { event: 'reg', click_id: click, trader_id: '70013333' });
  await pp(h, src, { event: 'ftd', click_id: click, trader_id: '70013333', sumdep: '25' });
  await pp(h, src, { event: 'dep', click_id: click, trader_id: '70013333', sumdep: '25' });
  assert.equal((await me(h, bot, s.token)).json.onboarding.status, 'registration_started');
  const r = await submit(h, bot, s.token, '70013333');
  assert.equal(r.status, 200);
  const m = (await me(h, bot, s.token)).json.onboarding;
  assert.equal(m.deposit.check, 'confirmed');
  assert.equal(m.deposit.depositsCount, 2);
  assert.equal(m.status, 'completed');
});

test('deposit with another user’s click_id is not credited to the Trader ID holder', async () => {
  const { h, bot, src } = await setup();
  const a = await boundUser(h, bot, src, 12, '70010000');
  const b = await h.login(bot, 13);
  const clickB = await register(h, bot, b.token);
  await pp(h, src, { event: 'ftd', click_id: clickB, trader_id: '70010000', sumdep: '30' });
  const d = (await me(h, bot, a.token)).json.onboarding.deposit;
  assert.equal(d.check, 'awaiting');
  const ev = (await h.store.query<{ matchStatus: string; diagnosis: string }>(C.postbackEvents, { where: [{ field: 'eventType', op: '==', value: 'ftd' }] }))[0]!;
  assert.equal(ev.data.matchStatus, 'conflict');
  assert.equal(ev.data.diagnosis, 'click_other_user');
});

test('one global postback for all bots: events go to the bot of the click_id; bots stay isolated', async () => {
  const h = harness();
  const botA = await seedBot(h.s, 'botGlobalA');
  const botB = await seedBot(h.s, 'botGlobalB');
  const src = await seedGlobalSource(h.s);
  const a = await h.login(botA, 901);
  const b = await h.login(botB, 901); // the same Telegram user in two bots = two separate users
  const clickA = await register(h, botA, a.token);
  const clickB = await register(h, botB, b.token);
  await pp(h, src, { event: 'reg', click_id: clickA, trader_id: '80001111' });
  // Bot B's user cannot use bot A's registration…
  assert.equal((await submit(h, botB, b.token, '80001111')).json.error.code, 'REGISTRATION_NOT_CONFIRMED');
  // …but bot A's user can.
  assert.equal((await submit(h, botA, a.token, '80001111')).json.binding.state, 'account_bound');
  await pp(h, src, { event: 'reg', click_id: clickB, trader_id: '80002222' });
  assert.equal((await submit(h, botB, b.token, '80002222')).json.binding.state, 'account_bound');
  const events = await h.store.query<{ botId: string; globalSource: boolean }>(C.postbackEvents, {});
  assert.deepEqual(new Set(events.map((e) => e.data.botId)), new Set([botA.botId, botB.botId]));
  assert.ok(events.every((e) => e.data.globalSource === true));
  // Unknown click_id (Academy rule): kept without a bot until somebody links this Trader ID.
  const bad = await pp(h, src, { event: 'reg', click_id: 'AAAAAAAAAAAAAAAAAAAAAA', trader_id: '80003333' });
  assert.equal(bad.status, 200);
  const unclaimed = (await h.store.query<{ botId: string; diagnosis: string; traderIdNorm: string }>(C.postbackEvents, {})).find((e) => e.data.traderIdNorm === '80003333')!;
  assert.equal(unclaimed.data.botId, 'global');
  assert.equal(unclaimed.data.diagnosis, 'registration_unclaimed');
});

test('global postback, 3 bots: every event (reg, FTD, redeposit) lands only in the bot of its click_id', async () => {
  const h = harness();
  const bots = [await seedBot(h.s, 'botR1'), await seedBot(h.s, 'botR2'), await seedBot(h.s, 'botR3')];
  const src = await seedGlobalSource(h.s);
  const users = [];
  for (const [i, b] of bots.entries()) {
    const s = await h.login(b, 777); // the same Telegram person in all three bots
    const click = await register(h, b, s.token);
    const tid = `9000000${i}`;
    await pp(h, src, { event: 'reg', click_id: click, trader_id: tid });
    assert.equal((await submit(h, b, s.token, tid)).json.binding.state, 'account_bound');
    users.push({ ...s, click, tid, bot: b });
  }
  // Deposits of different sizes per bot.
  for (const [i, u] of users.entries()) {
    await pp(h, src, { event: 'ftd', click_id: u.click, trader_id: u.tid, sumdep: String(10 * (i + 2)) });
    for (let k = 0; k < i; k++) {
      h.clock.advance(1);
      await pp(h, src, { event: 'dep', click_id: u.click, trader_id: u.tid, sumdep: String(5 + k) }); // different amounts: same amount within 10 min would be held as a possible repeat
    }
  }
  for (const [i, u] of users.entries()) {
    const d = (await me(h, u.bot, u.token)).json.onboarding.deposit;
    assert.equal(d.ftdAmount, 10 * (i + 2), `bot ${i + 1}: own FTD only`);
    assert.equal(d.depositsCount, 1 + i, `bot ${i + 1}: own repeat deposits only`);
  }
  // A Trader ID of bot 1 reported with the click_id of bot 2 is NOT credited in bot 1 (and not in bot 2: nobody holds it there).
  await pp(h, src, { event: 'dep', click_id: users[1]!.click, trader_id: users[0]!.tid, sumdep: '999' });
  assert.equal((await me(h, users[0]!.bot, users[0]!.token)).json.onboarding.deposit.depositsCount, 1);
  const cross = (await h.store.query<{ botId: string; matchStatus: string; amount: number; diagnosis: string }>(C.postbackEvents, { where: [{ field: 'eventType', op: '==', value: 'redeposit' }] })).find((e) => e.data.amount === 999)!;
  assert.equal(cross.data.botId, users[1]!.bot.botId, 'routed by click_id');
  assert.equal(cross.data.matchStatus, 'conflict');
  assert.equal(cross.data.diagnosis, 'click_other_user', 'the Trader ID is linked in another bot: no bypass through the Trader ID');
});

test('click_id robustness: upper-cased by the partner still matches; former 22-char ids still work; expired / unknown → 400 + integration error', async () => {
  const { h, bot, src } = await setup();
  const s = await h.login(bot, 31);
  const click = await register(h, bot, s.token);
  assert.match(click, /^[0-9a-f]{32}$/);
  await pp(h, src, { event: 'reg', click_id: click.toUpperCase(), trader_id: '70031000' });
  assert.equal((await submit(h, bot, s.token, '70031000')).json.binding.state, 'account_bound');

  // A user who opened the link before the update has a click token in the former format.
  const old = await h.login(bot, 32);
  const oldId = 'Ab-_cdEFgh0123456789xy';
  await h.store.create(C.clickTokens, oldId, { botId: bot.botId, userDocId: `${bot.botId}_32`, createdAt: h.clock.now().toISOString(), expiresAt: new Date(h.clock.t + 86_400_000).toISOString(), clicks: 1 });
  await pp(h, src, { event: 'reg', click_id: oldId, trader_id: '70032000' });
  assert.equal((await submit(h, bot, old.token, '70032000')).json.binding.state, 'account_bound');

  // Expired click (older than 90 days).
  const late = await h.login(bot, 33);
  const lateClick = await register(h, bot, late.token);
  h.clock.advance(91 * 24 * 3600);
  const r = await pp(h, src, { event: 'reg', click_id: lateClick, trader_id: '70033000' });
  assert.equal(r.status, 200, 'our click_id still names the owner after it expired (Academy rule)');
  const late2 = await h.login(bot, 33);
  assert.equal((await submit(h, bot, late2.token, '70033000')).json.binding.state, 'account_bound');
  const other = await h.login(bot, 34);
  await pp(h, src, { event: 'reg', click_id: lateClick, trader_id: '70034000' });
  assert.equal((await submit(h, bot, other.token, '70034000')).json.error.code, 'CLICK_MISMATCH', 'registered through user 33’s link');
});

test('existing users after the update: each lands on the right onboarding step', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botLegacy');
  const legacySrc = await seedSource(h.s, bot.botId, 'legacy-src'); // a former per-bot source, events without click_id
  const set = async (tg: number, patch: Record<string, unknown>) => {
    await h.login(bot, tg);
    await h.store.update(C.users, `${bot.botId}_${tg}`, patch);
  };
  const status = async (tg: number) => (await h.login(bot, tg)).body.onboarding.status as string;
  const owner = { uid: 'o', role: 'owner' as const, botPermissions: {} };

  // 1. Used the app before as a guest (never pressed "Register") → step 1.
  await set(41, { registrationStartedAt: null, traderIdSubmitStartedAt: null });
  assert.equal(await status(41), 'registration');
  // 2. Former intermediate states of the old binding flow, Trader ID not linked → step 2.
  await set(42, { bindingState: 'registration_pending', registrationStartedAt: '2026-10-01T00:00:00.000Z', traderIdSubmitStartedAt: '2026-10-01T00:05:00.000Z' });
  assert.equal(await status(42), 'trader_id');
  // 3. Linked earlier by an admin, no deposit → step 3.
  await set(43, {});
  await h.s.binding.adminBind(owner, new TenantScope(bot.botId), { telegramId: 43, traderId: '50004300', reason: 'linked before the update' });
  assert.equal(await status(43), 'deposit');
  // 4. Linked earlier + FTD ≥ $10 from the former per-bot source (no click_id) → completed.
  await set(44, {});
  await h.s.binding.adminBind(owner, new TenantScope(bot.botId), { telegramId: 44, traderId: '50004400', reason: 'linked before the update' });
  await h.request('GET', `/postback/${legacySrc.sourceId}?${new URLSearchParams({ token: legacySrc.secret, event: 'ftd', trader_id: '50004400', amount: '30', event_id: 'old-1' })}`, { ip: '192.0.2.1' });
  assert.equal(await status(44), 'completed');
  // 5. Completed earlier: stays completed even if the deposit later gets a conflict.
  await set(45, { onboardingCompletedAt: '2026-10-02T00:00:00.000Z', bindingState: 'account_bound', traderId: '50004500' });
  assert.equal(await status(45), 'completed');
  // 6. In manual review from the old flow → support screen, not a dead end.
  await set(46, { bindingState: 'manual_review' });
  assert.equal(await status(46), 'needs_support');
  // 7. Brand-new user → step 1.
  assert.equal(await status(47), 'registration');
});

test('repeated postback: 5 sequential and 10 concurrent deliveries → one event', async () => {
  const { h, bot, src } = await setup();
  const { token } = await h.login(bot, 14);
  const click = await register(h, bot, token);
  for (let i = 0; i < 5; i++) await pp(h, src, { event: 'reg', click_id: click, trader_id: '70011111' });
  await Promise.all(Array.from({ length: 10 }, () => pp(h, src, { event: 'reg', click_id: click, trader_id: '70011111' })));
  const evs = await h.store.query<{ deliveryCount: number }>(C.postbackEvents, {});
  assert.equal(evs.length, 1);
  assert.equal(evs[0]!.data.deliveryCount, 15);
});

test('postback source checks: wrong secret 401 (logged), unknown source 404, bad Trader ID / missing event 400', async () => {
  const { h, bot, src } = await setup();
  const { token } = await h.login(bot, 15);
  const click = await register(h, bot, token);
  assert.equal((await h.request('GET', `/postback/${src.sourceId}?key=wrong&event=reg&trader_id=1&click_id=${click}`)).status, 401);
  assert.equal((await h.request('GET', `/postback/no-such-source?key=${src.secret}&event=reg`)).status, 404);
  assert.equal((await pp(h, src, { event: 'reg', click_id: click, trader_id: 'bad id with spaces' })).status, 400);
  assert.equal((await pp(h, src, { click_id: click, trader_id: 'T1' })).status, 400, 'event type missing');
  const errs = await h.store.query<{ code: string }>(C.errorLogs, {});
  assert.ok(errs.some((e) => e.data.code === 'UNAUTHORIZED'));
  assert.ok(errs.some((e) => e.data.code === 'BAD_EVENT'));
  assert.equal((await h.store.query(C.postbackEvents, {})).length, 0, 'rejected events are never stored');
});

test('HMAC-signed source: valid signature accepted, any change rejected', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botHmac');
  const src = await seedSource(h.s, bot.botId, 'partner-h', 'hmac_sha256');
  const body = JSON.stringify({ event: 'reg', trader_id: 'H100', event_id: 'h1' });
  const sig = createHmac('sha256', src.secret).update(body).digest('hex');
  assert.equal((await h.request('POST', `/postback/${src.sourceId}`, { raw: body, headers: { 'x-signature': sig } })).status, 200);
  const tampered = body.replace('H100', 'H101');
  assert.equal((await h.request('POST', `/postback/${src.sourceId}`, { raw: tampered, headers: { 'x-signature': sig } })).status, 401);
});

test('admin re-binding: requires permission and reason, writes audit log with masked Trader IDs', async () => {
  const { h, bot, src } = await setup();
  await boundUser(h, bot, src, 16, '70012222');
  await h.login(bot, 17);
  const scope = new TenantScope(bot.botId);
  const manager = { uid: 'm1', role: 'manager' as const, botPermissions: { [bot.botId]: ['users.view' as const] } };
  await assert.rejects(h.s.binding.adminBind(manager, scope, { telegramId: 17, traderId: '70012222', reason: 'checked' }), (e: AppError) => e.code === 'FORBIDDEN');
  const owner = { uid: 'owner', role: 'owner' as const, botPermissions: {} };
  await assert.rejects(h.s.binding.adminBind(owner, scope, { telegramId: 17, traderId: '70012222', reason: '' }), (e: AppError) => e.code === 'BAD_REQUEST');
  await assert.rejects(h.s.binding.adminBind(owner, scope, { telegramId: 17, traderId: '70012222', reason: 'support ticket #42' }), (e: AppError) => e.code === 'ALREADY_EXISTS');
  await h.s.binding.adminBind(owner, scope, { telegramId: 17, traderId: '70012222', reason: 'support ticket #42', releaseFromOther: true });
  assert.equal((await user(h, bot.botId, 17)).bindingState, 'account_bound');
  assert.equal((await user(h, bot.botId, 16)).bindingState, 'waiting_for_trader_id');
  const audit = (await h.store.query<{ action: string; reason: string }>(C.auditLogs, {})).filter((a) => a.data.action.startsWith('binding.'));
  assert.deepEqual(audit.map((x) => x.data.action).sort(), ['binding.admin_bind', 'binding.release']);
  assert.equal(JSON.stringify(audit).includes('70012222'), false, 'audit stores masked Trader IDs');
});

test('state machine rejects illegal automatic transitions', () => {
  assert.equal(canTransition('account_bound', 'waiting_for_trader_id'), false);
  assert.equal(canTransition('manual_review', 'account_bound'), false);
  assert.equal(canTransition('manual_review', 'account_bound', 'admin'), true);
  assert.equal(canTransition('waiting_for_trader_id', 'account_bound'), true);
});
