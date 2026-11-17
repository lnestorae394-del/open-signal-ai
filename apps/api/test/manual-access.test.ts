import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ADMIN_SETUP_TOKEN, PROD_LIKE_ENV, TestClock, bearer, defaultStore, harness, seedBot, seedGlobalSource, type Harness, type TestBot } from './helpers.ts';
import { fakeTelegram } from './fake-telegram.ts';
import { C } from '../src/storage/collections.ts';
import { TenantScope } from '../src/domain/tenant.ts';
import { AppError } from '../src/lib/errors.ts';

/**
 * Manual admin actions on one user. Each is a separate operation with its own permission
 * check, mandatory reason and audit entry; none of them fakes a registration or a deposit.
 */

const OWNER = { uid: 'owner-1', email: 'owner@example.com', role: 'owner' as const, botPermissions: {} };
type Src = { sourceId: string; secret: string };
const pp = (h: Harness, src: Src, params: Record<string, string>) =>
  h.request('GET', `/postback/${src.sourceId}?${new URLSearchParams({ key: src.secret, ...params })}`, { ip: '192.0.2.1' });
const me = async (h: Harness, bot: TestBot, token: string) => (await h.request('GET', `/api/miniapp/${bot.botId}/me`, { headers: bearer(token) })).json;
const signal = (h: Harness, bot: TestBot, token: string) =>
  h.request('POST', `/api/miniapp/${bot.botId}/signals`, { headers: bearer(token), body: { instrumentId: 'EURUSD', periodSec: 60 } });
async function register(h: Harness, bot: TestBot, token: string): Promise<string> {
  const r = await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/register`, { headers: bearer(token) });
  return new URL(r.json.link).searchParams.get('sub')!;
}
async function linkedWithFtd(h: Harness, bot: TestBot, src: Src, tg: number, tid: string) {
  const s = await h.login(bot, tg);
  const click = await register(h, bot, s.token);
  await pp(h, src, { event: 'reg', click_id: click, trader_id: tid });
  await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(s.token), body: { traderId: tid } });
  await pp(h, src, { event: 'ftd', click_id: click, trader_id: tid, sumdep: '50' });
  await pp(h, src, { event: 'dep', click_id: click, trader_id: tid, sumdep: '20' });
  return { ...s, click };
}
const userDoc = async (h: Harness, bot: TestBot, tg: number) => (await h.store.get<Record<string, unknown>>(C.users, `${bot.botId}_${tg}`))!;
const audit = async (h: Harness) => (await h.store.query<{ action: string; reason: string | null; actor: { type: string; id: string }; target: string }>(C.auditLogs, {})).map((a) => a.data);

async function setup() {
  const h = harness();
  const bot = await seedBot(h.s, 'botManual');
  const src = await seedGlobalSource(h.s);
  return { h, bot, src, scope: new TenantScope(bot.botId) };
}

test('11) "Skip to signals" opens signals WITHOUT faking a deposit, a Trader ID or completed onboarding', async () => {
  const { h, bot, scope } = await setup();
  const s = await h.login(bot, 101);
  assert.equal((await signal(h, bot, s.token)).status, 403, 'closed before');
  const before = await userDoc(h, bot, 101);

  await h.s.binding.adminSetManualAccess(OWNER, scope, { telegramId: 101, grant: true, reason: 'Mini App hung on step 1 (ticket #42)' });

  const m = await me(h, bot, s.token);
  assert.deepEqual(m.access, { signals: true, via: 'manual' });
  assert.equal(m.onboarding.status, 'registration', 'the real onboarding status is unchanged');
  assert.equal((await signal(h, bot, s.token)).status, 201, 'the server issues signals');
  assert.equal((await h.request('GET', `/api/miniapp/${bot.botId}/academy`, { headers: bearer(s.token) })).status, 200);

  const after = await userDoc(h, bot, 101);
  for (const k of ['bindingState', 'traderId', 'deposit', 'onboardingCompletedAt', 'verifiedTraderIdHash', 'registrationStartedAt']) {
    assert.deepEqual(after[k] ?? null, before[k] ?? null, `${k} untouched`);
  }
  assert.equal((await h.store.query(C.postbackEvents, {})).length, 0, 'no postback event created');
  assert.equal((after.manualAccess as { grantReason: string }).grantReason, 'Mini App hung on step 1 (ticket #42)');
  await assert.rejects(h.s.binding.adminSetManualAccess(OWNER, scope, { telegramId: 101, grant: true, reason: 'second time' }), (e: AppError) => e.code === 'ALREADY_EXISTS');
});

test('12) revoking manual access returns the user to the normal rules (and keeps the history)', async () => {
  const { h, bot, scope } = await setup();
  const s = await h.login(bot, 102);
  await h.s.binding.adminSetManualAccess(OWNER, scope, { telegramId: 102, grant: true, reason: 'temporary access' });
  await h.s.binding.adminSetManualAccess(OWNER, scope, { telegramId: 102, grant: false, reason: 'problem solved' });
  const m = await me(h, bot, s.token);
  assert.deepEqual(m.access, { signals: false, via: null });
  assert.equal((await signal(h, bot, s.token)).status, 403);
  const ma = (await userDoc(h, bot, 102)).manualAccess as Record<string, unknown>;
  assert.equal(ma.active, false);
  assert.equal(ma.grantReason, 'temporary access', 'grant record kept');
  assert.equal(ma.revokeReason, 'problem solved');
  await assert.rejects(h.s.binding.adminSetManualAccess(OWNER, scope, { telegramId: 102, grant: false, reason: 'again please' }), (e: AppError) => e.code === 'VALIDATION_FAILED');
});

test('13) a user with normal access keeps it when manual access is revoked', async () => {
  const { h, bot, src, scope } = await setup();
  const u = await linkedWithFtd(h, bot, src, 103, '63000103');
  assert.equal((await me(h, bot, u.token)).onboarding.status, 'completed');
  await h.s.binding.adminSetManualAccess(OWNER, scope, { telegramId: 103, grant: true, reason: 'granted by mistake' });
  await h.s.binding.adminSetManualAccess(OWNER, scope, { telegramId: 103, grant: false, reason: 'not needed, normal access' });
  const m = await me(h, bot, u.token);
  assert.deepEqual(m.access, { signals: true, via: 'onboarding' });
  assert.equal((await signal(h, bot, u.token)).status, 201);
});

test('14) onboarding recovery actions never delete deposits or financial history', async () => {
  const { h, bot, src, scope } = await setup();
  await linkedWithFtd(h, bot, src, 104, '63000104');
  const eventsBefore = (await h.store.query(C.postbackEvents, {})).length;
  const depBefore = (await userDoc(h, bot, 104)).deposit;
  // Unlink (existing action) → Trader ID input again; deposits and events stay.
  await h.s.binding.adminReturnToInput(OWNER, scope, { telegramId: 104, reason: 'wrong Trader ID linked' });
  assert.equal((await h.store.query(C.postbackEvents, {})).length, eventsBefore);
  assert.deepEqual((await userDoc(h, bot, 104)).deposit, depBefore, 'deposit summary not removed');
  // Step fix for an unlinked user: only the step markers move.
  await h.s.binding.adminSetOnboardingStep(OWNER, scope, { telegramId: 104, step: 'registration', reason: 'start again from step 1' });
  await h.s.binding.adminSetOnboardingStep(OWNER, scope, { telegramId: 104, step: 'trader_id', reason: 'registered, app missed the return' });
  const u = await userDoc(h, bot, 104);
  assert.ok(u.traderIdSubmitStartedAt);
  assert.equal((await h.store.query(C.postbackEvents, {})).length, eventsBefore);
  // Link again manually (existing action) and re-check the deposit from the stored partner events.
  await h.s.binding.adminBind(OWNER, scope, { telegramId: 104, traderId: '63000104', reason: 'support verified the account' });
  const summary = await h.s.binding.adminRecheckDeposit(OWNER, scope, { telegramId: 104, reason: 'deposit step looked stuck' });
  assert.equal(summary.depositsCount, 2);
  assert.equal(summary.ftdAmount, 50);
  assert.equal((await h.store.query(C.postbackEvents, {})).length, eventsBefore, 'recheck creates no events');
  // A linked user's step cannot be "fixed" around the binding.
  await assert.rejects(h.s.binding.adminSetOnboardingStep(OWNER, scope, { telegramId: 104, step: 'registration', reason: 'should be refused' }), (e: AppError) => e.code === 'VALIDATION_FAILED');
});

test('re-check deposit confirms nothing the partner did not report', async () => {
  const { h, bot, src, scope } = await setup();
  const s = await h.login(bot, 105);
  const click = await register(h, bot, s.token);
  await pp(h, src, { event: 'reg', click_id: click, trader_id: '63000105' });
  await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(s.token), body: { traderId: '63000105' } });
  const summary = await h.s.binding.adminRecheckDeposit(OWNER, scope, { telegramId: 105, reason: 'user says they deposited' });
  assert.equal(summary.depositsCount, 0);
  assert.equal((await me(h, bot, s.token)).onboarding.deposit.check, 'awaiting');
});

test('15) a manager without binding.manage cannot do any manual action; other bots are out of reach', async () => {
  const { h, bot, scope } = await setup();
  const other = await seedBot(h.s, 'botManualOther');
  await h.login(bot, 106);
  await h.login(other, 106);
  const viewer = { uid: 'm-view', email: 'viewer@example.com', role: 'manager' as const, botPermissions: { [bot.botId]: ['users.view' as const] } };
  const forbidden = (e: AppError) => e.code === 'FORBIDDEN';
  await assert.rejects(h.s.binding.adminSetManualAccess(viewer, scope, { telegramId: 106, grant: true, reason: 'trying to skip' }), forbidden);
  await assert.rejects(h.s.binding.adminSetOnboardingStep(viewer, scope, { telegramId: 106, step: 'trader_id', reason: 'trying to skip' }), forbidden);
  await assert.rejects(h.s.binding.adminRecheckDeposit(viewer, scope, { telegramId: 106, reason: 'trying to skip' }), forbidden);
  await assert.rejects(h.s.binding.adminBind(viewer, scope, { telegramId: 106, traderId: '63000106', reason: 'trying to skip' }), forbidden);
  await assert.rejects(h.s.binding.adminReturnToInput(viewer, scope, { telegramId: 106, reason: 'trying to skip' }), forbidden);
  // A manager who manages bot A cannot touch the same Telegram user in bot B.
  const managerA = { uid: 'm-a', email: 'a@example.com', role: 'manager' as const, botPermissions: { [bot.botId]: ['users.view' as const, 'binding.manage' as const] } };
  await assert.rejects(h.s.binding.adminSetManualAccess(managerA, new TenantScope(other.botId), { telegramId: 106, grant: true, reason: 'wrong bot' }), forbidden);
  await h.s.binding.adminSetManualAccess(managerA, scope, { telegramId: 106, grant: true, reason: 'allowed in own bot' });
  assert.equal(((await h.store.get<{ manualAccess?: unknown }>(C.users, `${other.botId}_106`))!.manualAccess ?? null), null, 'bot B untouched');
  // Viewer can read the card, but not the full Trader ID / actions.
  const card = await h.s.insights.userCard(viewer, bot.botId, 106);
  assert.equal(card.canManage, false);
  assert.equal(card.accessStatus, 'manual');
  await assert.rejects(h.s.insights.userCard(viewer, other.botId, 106), forbidden);
});

test('16) every manual action is audited with the admin and the reason; reason is mandatory', async () => {
  const { h, bot, src, scope } = await setup();
  await linkedWithFtd(h, bot, src, 107, '63000107');
  await h.login(bot, 108);
  await assert.rejects(h.s.binding.adminSetManualAccess(OWNER, scope, { telegramId: 108, grant: true, reason: ' ' }), (e: AppError) => e.code === 'BAD_REQUEST');
  await h.s.binding.adminSetManualAccess(OWNER, scope, { telegramId: 108, grant: true, reason: 'reason grant' });
  await h.s.binding.adminSetManualAccess(OWNER, scope, { telegramId: 108, grant: false, reason: 'reason revoke' });
  await h.s.binding.adminSetOnboardingStep(OWNER, scope, { telegramId: 108, step: 'trader_id', reason: 'reason step' });
  await h.s.binding.adminRecheckDeposit(OWNER, scope, { telegramId: 107, reason: 'reason recheck' });
  await h.s.binding.adminReturnToInput(OWNER, scope, { telegramId: 107, reason: 'reason unlink' });
  await h.s.binding.adminBind(OWNER, scope, { telegramId: 107, traderId: '63000107', reason: 'reason bind' });
  const log = await audit(h);
  for (const [action, reason] of [
    ['access.manual_grant', 'reason grant'], ['access.manual_revoke', 'reason revoke'], ['onboarding.set_step', 'reason step'],
    ['finance.deposit_recheck', 'reason recheck'], ['binding.unbind', 'reason unlink'], ['binding.admin_bind', 'reason bind'],
  ] as const) {
    const e = log.find((a) => a.action === action);
    assert.ok(e, action);
    assert.equal(e.reason, reason, action);
    assert.deepEqual(e.actor, { type: 'admin', id: OWNER.uid }, action);
  }
  const card = await h.s.insights.userCard(OWNER, bot.botId, 108);
  assert.equal(card.accessStatus, 'revoked');
  assert.equal(card.manualAccess?.revokeReason, 'reason revoke');
  assert.equal(card.lastManualAction?.action, 'onboarding.set_step');
  assert.equal(card.lastManualAction?.reason, 'reason step');
});

test('admin HTTP: user card, manual access with CSRF, "manual access" filter', async () => {
  const h = harness(defaultStore(), new TestClock(), { env: PROD_LIKE_ENV, telegramFetch: fakeTelegram().fetch });
  const bot = await seedBot(h.s, 'botManualHttp');
  await h.login(bot, 109);
  await h.login(bot, 110);
  const CSRF = { 'x-os-admin': '1' };
  const r = await h.request('POST', '/api/admin/setup', { headers: CSRF, body: { setupToken: ADMIN_SETUP_TOKEN, email: 'owner@example.com', password: 'correct horse battery' } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const cookie = (r.headers?.['set-cookie'] ?? '').split(';')[0]!;
  const url = `/api/admin/bots/${bot.botId}/users/109/manual-access`;
  assert.equal((await h.request('POST', url, { headers: { cookie }, body: { grant: true, reason: 'no csrf header' } })).status, 403, 'CSRF header required');
  const g = await h.request('POST', url, { headers: { cookie, ...CSRF }, body: { grant: true, reason: 'technical problem' } });
  assert.equal(g.status, 200, JSON.stringify(g.json));
  assert.equal(g.json.user.accessStatus, 'manual');
  assert.equal(g.json.user.manualAccess.grantedBy, 'owner@example.com');
  assert.equal(g.json.user.manualAccess.grantReason, 'technical problem');
  const list = (await h.request('GET', `/api/admin/users?botId=${bot.botId}&access=manual`, { headers: { cookie } })).json.users;
  assert.deepEqual(list.map((u: { telegramId: number }) => u.telegramId), [109]);
  const all = (await h.request('GET', `/api/admin/users?botId=${bot.botId}`, { headers: { cookie } })).json.users;
  assert.equal(all.length, 2);
  const step = await h.request('POST', `/api/admin/bots/${bot.botId}/users/110/onboarding-step`, { headers: { cookie, ...CSRF }, body: { step: 'trader_id', reason: 'stuck on registration' } });
  assert.equal(step.status, 200);
  assert.equal(step.json.user.accessStatus, 'awaiting_trader_id');
});
