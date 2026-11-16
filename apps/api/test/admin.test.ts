import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME, MODULES } from '@open-signal/shared';
import { ADMIN_SETUP_TOKEN, PROD_LIKE_ENV, TestClock, defaultStore, harness, fakeBotToken, type Harness } from './helpers.ts';
import { fakeTelegram } from './fake-telegram.ts';
import { signInitDataForTests } from '../src/telegram/init-data.ts';
import { C } from '../src/storage/collections.ts';

const CSRF = { 'x-os-admin': '1' };
const PASSWORD = 'correct horse battery';

function setup() {
  const tg = fakeTelegram();
  const h = harness(defaultStore(), new TestClock(), { env: PROD_LIKE_ENV, telegramFetch: tg.fetch });
  return { h, tg };
}

function cookieFrom(res: { headers?: Record<string, string> }): string {
  const sc = res.headers?.['set-cookie'] ?? '';
  return sc.split(';')[0]!;
}

async function owner(h: Harness): Promise<string> {
  const r = await h.request('POST', '/api/admin/setup', { headers: CSRF, body: { setupToken: ADMIN_SETUP_TOKEN, email: 'Owner@Example.com', password: PASSWORD } });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return cookieFrom(r);
}

const botBody = (token: string, name = 'Aurora Signals') => ({
  token,
  name,
  description: { ru: 'Аналитика и обучение', en: 'Analytics and learning' },
  shortDescription: {},
  miniAppTitle: 'AURORA',
  defaultLanguage: 'ru',
  theme: DEFAULT_THEME,
  supportContact: '@aurora_help',
  modules: Object.fromEntries(MODULES.map((m) => [m, true])),
  accountBinding: { traderIdPattern: '^[A-Za-z0-9_-]{3,64}$', gatedModules: ['signals', 'academy'], partnerLinkTemplate: null, recheckCooldownSec: 30, supportHintAfterHours: 24 },
});

test('setup: one-time owner creation with the setup token; cookie is HttpOnly, Secure, SameSite=Strict', async () => {
  const { h } = setup();
  assert.equal((await h.request('GET', '/api/admin/setup')).json.needsSetup, true);
  const bad = await h.request('POST', '/api/admin/setup', { headers: CSRF, body: { setupToken: 'wrong', email: 'a@b.co', password: PASSWORD } });
  assert.equal(bad.status, 401);
  const noCsrf = await h.request('POST', '/api/admin/setup', { body: { setupToken: ADMIN_SETUP_TOKEN, email: 'a@b.co', password: PASSWORD } });
  assert.equal(noCsrf.status, 403);
  const weak = await h.request('POST', '/api/admin/setup', { headers: CSRF, body: { setupToken: ADMIN_SETUP_TOKEN, email: 'a@b.co', password: 'short' } });
  assert.equal(weak.status, 400);
  const r = await h.request('POST', '/api/admin/setup', { headers: CSRF, body: { setupToken: ADMIN_SETUP_TOKEN, email: 'owner@example.com', password: PASSWORD } });
  assert.equal(r.status, 201);
  assert.match(r.headers!['set-cookie']!, /HttpOnly; SameSite=Strict; Max-Age=\d+; Secure/);
  const again = await h.request('POST', '/api/admin/setup', { headers: CSRF, body: { setupToken: ADMIN_SETUP_TOKEN, email: 'x@example.com', password: PASSWORD } });
  assert.equal(again.json.error.code, 'SETUP_ALREADY_DONE');
  assert.equal((await h.request('GET', '/api/admin/setup')).json.needsSetup, false);
  const me = await h.request('GET', '/api/admin/me', { headers: { cookie: cookieFrom(r) } });
  assert.equal(me.json.me.role, 'owner');
  assert.equal((await h.request('GET', '/api/admin/me')).status, 401, 'no cookie → 401');
});

test('login: wrong password rejected, lockout after repeated failures, logout revokes the session', async () => {
  const { h } = setup();
  await owner(h);
  const wrong = await h.request('POST', '/api/admin/login', { headers: CSRF, body: { email: 'owner@example.com', password: 'nope-nope-nope' } });
  assert.equal(wrong.json.error.code, 'INVALID_CREDENTIALS');
  const unknown = await h.request('POST', '/api/admin/login', { headers: CSRF, body: { email: 'ghost@example.com', password: PASSWORD } });
  assert.equal(unknown.json.error.code, 'INVALID_CREDENTIALS', 'same answer for unknown accounts');
  const ok = await h.request('POST', '/api/admin/login', { headers: CSRF, body: { email: 'OWNER@example.com', password: PASSWORD } });
  assert.equal(ok.status, 200);
  const cookie = cookieFrom(ok);
  await h.request('POST', '/api/admin/logout', { headers: { ...CSRF, cookie } });
  assert.equal((await h.request('GET', '/api/admin/me', { headers: { cookie } })).status, 401);
  for (let i = 0; i < 8; i++) {
    await h.s.adminAuth.login('owner@example.com', 'bad-password-x', `10.9.9.${i}`).catch(() => undefined);
  }
  await assert.rejects(h.s.adminAuth.login('owner@example.com', PASSWORD, '10.0.0.1'), (e: { code: string }) => e.code === 'ACCOUNT_LOCKED');
});

test('create bot: token verified, encrypted, webhook + profile + menu button pushed to Telegram', async () => {
  const { h, tg } = setup();
  const cookie = await owner(h);
  const token = fakeBotToken();
  tg.addBot(token, 7001, 'AuroraSignalsBot');

  const invalid = await h.request('POST', '/api/admin/bots', { headers: { ...CSRF, cookie }, body: botBody(fakeBotToken()) });
  assert.equal(invalid.json.error.code, 'TELEGRAM_TOKEN_INVALID');
  const badForm = await h.request('POST', '/api/admin/bots', { headers: { ...CSRF, cookie }, body: { ...botBody(token), name: '' } });
  assert.equal(badForm.json.error.code, 'VALIDATION_FAILED');
  assert.ok(badForm.json.error.fields.name);

  const r = await h.request('POST', '/api/admin/bots', { headers: { ...CSRF, cookie }, body: botBody(token) });
  assert.equal(r.status, 201, JSON.stringify(r.json));
  const bot = r.json.bot;
  assert.equal(bot.username, 'AuroraSignalsBot', 'username is taken from Telegram');
  assert.equal(bot.telegram.issues.length, 0, JSON.stringify(bot.telegram.issues));
  assert.equal(bot.telegram.webhookUrl, `https://os.example.test/tg/webhook/${bot.botId}`);
  assert.equal(bot.miniAppUrl, `https://os.example.test/app/?bot=${bot.botId}`);
  assert.ok(!JSON.stringify(r.json).includes(token.split(':')[1]!), 'token never returned');

  const stored = await h.store.get<{ tokenEnc: string; webhookSecretHash: string }>(C.bots, bot.botId);
  assert.ok(!JSON.stringify(stored).includes(token.split(':')[1]!), 'token stored encrypted only');

  const hook = tg.callsOf('setWebhook')[0]!;
  assert.equal(hook.body['url'], bot.telegram.webhookUrl);
  const menu = tg.callsOf('setChatMenuButton')[0]!;
  assert.deepEqual((menu.body['menu_button'] as { web_app: unknown }).web_app, { url: bot.miniAppUrl });
  assert.ok(tg.callsOf('setMyName').length >= 1);
  assert.equal(tg.callsOf('setMyDescription').filter((c) => c.body['language_code'] === 'en').length, 1);

  // Academy can never be gated, even if the form asks for it.
  const cfg = await h.store.get<{ accountBinding: { gatedModules: string[] } }>(C.botConfigs, bot.botId);
  assert.deepEqual(cfg!.accountBinding.gatedModules, ['signals']);

  const dup = await h.request('POST', '/api/admin/bots', { headers: { ...CSRF, cookie }, body: botBody(token, 'Again') });
  assert.equal(dup.json.error.code, 'BOT_ALREADY_CONNECTED');

  // The webhook secret registered at Telegram is accepted; /start gets a Mini App button.
  const secret = String(hook.body['secret_token']);
  const update = { update_id: 1, message: { chat: { id: 555, type: 'private' }, text: '/start', from: { id: 555, language_code: 'en' } } };
  const wh = await h.request('POST', `/tg/webhook/${bot.botId}`, { body: update, headers: { 'x-telegram-bot-api-secret-token': secret } });
  assert.equal(wh.status, 200);
  const reply = tg.callsOf('sendMessage').at(-1)!;
  assert.equal(reply.body['chat_id'], 555);
  assert.match(String(reply.body['text']), /Аврора|Aurora|AURORA|Добро/);
  const button = (reply.body['reply_markup'] as { inline_keyboard: { web_app: { url: string } }[][] }).inline_keyboard[0]![0]!;
  assert.equal(button.web_app.url, bot.miniAppUrl);

  // Disabled bot answers "temporarily unavailable" and data stays.
  await h.request('POST', `/api/admin/bots/${bot.botId}/status`, { headers: { ...CSRF, cookie }, body: { status: 'disabled' } });
  await h.request('POST', `/tg/webhook/${bot.botId}`, { body: { ...update, update_id: 2 }, headers: { 'x-telegram-bot-api-secret-token': secret } });
  assert.match(String(tg.callsOf('sendMessage').at(-1)!.body['text']), /недоступен/);
});

test('Mini App works end-to-end for an admin-created bot; users are counted and listed', async () => {
  const { h, tg } = setup();
  const cookie = await owner(h);
  const token = fakeBotToken();
  tg.addBot(token, 7002, 'NovaBot');
  const { json } = await h.request('POST', '/api/admin/bots', { headers: { ...CSRF, cookie }, body: botBody(token, 'Nova') });
  const botId = json.bot.botId;
  for (const id of [11, 12]) {
    const initData = signInitDataForTests(token, { auth_date: String(Math.floor(h.clock.t / 1000)), user: JSON.stringify({ id, first_name: `U${id}` }) });
    const s = await h.request('POST', `/api/miniapp/${botId}/session`, { body: { initData }, ip: `1.1.1.${id}` });
    assert.equal(s.status, 200, JSON.stringify(s.json));
  }
  const users = await h.request('GET', `/api/admin/bots/${botId}/users`, { headers: { cookie } });
  assert.equal(users.json.users.length, 2);
  const list = await h.request('GET', '/api/admin/bots', { headers: { cookie } });
  assert.equal(list.json.bots[0].usersCount, 2);
  await h.s.stats.flush();
  const overview = await h.request('GET', '/api/admin/overview', { headers: { cookie } });
  assert.equal(overview.json.users, 2);
  assert.equal(overview.json.days.at(-1).metrics.miniapp_launches, 2);
});

test('managers: invite link, per-bot permissions, no access to other bots or owner actions', async () => {
  const { h, tg } = setup();
  const cookie = await owner(h);
  const t1 = fakeBotToken();
  const t2 = fakeBotToken();
  tg.addBot(t1, 8001, 'OneBot');
  tg.addBot(t2, 8002, 'TwoBot');
  const b1 = (await h.request('POST', '/api/admin/bots', { headers: { ...CSRF, cookie }, body: botBody(t1, 'One') })).json.bot.botId;
  await h.request('POST', '/api/admin/bots', { headers: { ...CSRF, cookie }, body: botBody(t2, 'Two') });

  const inv = await h.request('POST', '/api/admin/managers', { headers: { ...CSRF, cookie }, body: { email: 'm@example.com', botPermissions: { [b1]: ['users.view', 'logs.view', 'nonsense'] } } });
  assert.equal(inv.status, 201);
  const inviteToken = inv.json.inviteUrl.split('/invite/')[1];
  const acc = await h.request('POST', '/api/admin/invite/accept', { headers: CSRF, body: { token: inviteToken, password: 'manager-password-1' } });
  assert.equal(acc.status, 200);
  const mCookie = cookieFrom(acc);
  const reuse = await h.request('POST', '/api/admin/invite/accept', { headers: CSRF, body: { token: inviteToken, password: 'manager-password-2' } });
  assert.equal(reuse.status, 401, 'invite is single-use');

  const bots = await h.request('GET', '/api/admin/bots', { headers: { cookie: mCookie } });
  assert.deepEqual(bots.json.bots.map((b: { botId: string }) => b.botId), [b1]);
  assert.equal((await h.request('GET', `/api/admin/bots/${b1}/users`, { headers: { cookie: mCookie } })).status, 200);
  assert.equal((await h.request('PUT', `/api/admin/bots/${b1}/config`, { headers: { ...CSRF, cookie: mCookie }, body: {} })).status, 403);
  assert.equal((await h.request('POST', '/api/admin/bots', { headers: { ...CSRF, cookie: mCookie }, body: botBody(fakeBotToken()) })).status, 403);
  assert.equal((await h.request('GET', '/api/admin/managers', { headers: { cookie: mCookie } })).status, 403);
  const managers = await h.request('GET', '/api/admin/managers', { headers: { cookie } });
  assert.deepEqual(managers.json.managers[0].botPermissions, { [b1]: ['users.view', 'logs.view'] });
  assert.ok(!JSON.stringify(managers.json).includes('scrypt'), 'password hashes never leave the server');
});

test('config update re-syncs Telegram; media: logo served publicly, avatar pushed to Telegram, wrong types rejected', async () => {
  const { h, tg } = setup();
  const cookie = await owner(h);
  const token = fakeBotToken();
  tg.addBot(token, 9001, 'MediaBot');
  const botId = (await h.request('POST', '/api/admin/bots', { headers: { ...CSRF, cookie }, body: botBody(token, 'Media') })).json.bot.botId;
  const before = tg.callsOf('setMyName').length;
  const { token: _t, ...edit } = botBody(token, 'Media Renamed');
  const upd = await h.request('PUT', `/api/admin/bots/${botId}/config`, { headers: { ...CSRF, cookie }, body: { ...edit, theme: { ...DEFAULT_THEME, primary: '#3D7BFF' } } });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  assert.equal(tg.callsOf('setMyName').length, before + 1);
  const pub = await h.request('GET', `/api/public/bots/${botId}/config`);
  assert.equal(pub.json.theme.primary, '#3D7BFF');
  assert.equal(pub.json.name, 'Media Renamed');

  const png = Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), Buffer.alloc(32)]);
  const logo = await h.request('POST', `/api/admin/bots/${botId}/media`, { headers: { ...CSRF, cookie }, body: { kind: 'logo', mime: 'image/png', data: png.toString('base64') } });
  assert.equal(logo.status, 200, JSON.stringify(logo.json));
  const served = await h.request('GET', logo.json.bot.logoUrl);
  assert.equal(served.headers!['content-type'], 'image/png');
  assert.ok(Buffer.isBuffer(served.body) && (served.body as Buffer).equals(png));

  const jpeg = Buffer.concat([Buffer.from([0xff, 0xd8, 0xff, 0xe0]), Buffer.alloc(32)]);
  const avatar = await h.request('POST', `/api/admin/bots/${botId}/media`, { headers: { ...CSRF, cookie }, body: { kind: 'avatar', mime: 'image/jpeg', data: jpeg.toString('base64') } });
  assert.equal(avatar.status, 200);
  assert.equal(tg.callsOf('setMyProfilePhoto').length, 1);
  assert.match(String(tg.callsOf('setMyProfilePhoto')[0]!.body['photo']), /attach:\/\/avatar/);
  const fake = await h.request('POST', `/api/admin/bots/${botId}/media`, { headers: { ...CSRF, cookie }, body: { kind: 'logo', mime: 'image/png', data: Buffer.from('<svg onload=alert(1)>').toString('base64') } });
  assert.equal(fake.status, 400);
});

test('global postback source: one per platform, secret shown once, Pocket Partners events in the history, errors listed, audited admin bind', async () => {
  const { h, tg } = setup();
  const cookie = await owner(h);
  const token = fakeBotToken();
  tg.addBot(token, 9101, 'SrcBot');
  const botId = (await h.request('POST', '/api/admin/bots', { headers: { ...CSRF, cookie }, body: botBody(token, 'Src') })).json.bot.botId;
  await h.request('PUT', `/api/admin/bots/${botId}/partner`, { headers: { ...CSRF, cookie }, body: { linkTemplate: 'https://partner.example.test/r?click_id={click_id}', buttonText: {}, partnerId: null } });
  const body = {
    name: 'Pocket Partners', authMethod: 'secret_query', authName: 'key',
    mapping: { eventType: 'event', traderId: 'trader_id', clickId: 'click_id', amount: 'sumdep', eventId: '', occurredAt: '', currency: '' },
    eventTypeMap: { reg: 'registration', ftd: 'ftd', dep: 'redeposit' },
  };
  const created = await h.request('POST', '/api/admin/postback/sources', { headers: { ...CSRF, cookie }, body });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const { secret, source } = created.json;
  assert.equal(source.scope, 'global');
  assert.equal(source.postbackUrl, `https://os.example.test/postback/${source.id}`);
  assert.equal((await h.request('POST', '/api/admin/postback/sources', { headers: { ...CSRF, cookie }, body })).status, 400, 'only one global source');
  const listed = await h.request('GET', '/api/admin/postback/sources', { headers: { cookie } });
  assert.ok(!JSON.stringify(listed.json).includes(secret), 'secret is not shown again');

  const login = async (id: number) => {
    const initData = signInitDataForTests(token, { auth_date: String(Math.floor(h.clock.t / 1000)), user: JSON.stringify({ id, first_name: 'x' }) });
    return (await h.request('POST', `/api/miniapp/${botId}/session`, { body: { initData }, ip: `2.2.2.${id}` })).json.session.token as string;
  };
  const t21 = await login(21);
  const link = (await h.request('POST', `/api/miniapp/${botId}/onboarding/register`, { headers: { authorization: `Bearer ${t21}` } })).json.link as string;
  const click = new URL(link).searchParams.get('click_id')!;
  assert.equal((await h.request('GET', `/postback/${source.id}?key=${secret}&event=reg&click_id=${click}&trader_id=777001`)).status, 200);
  assert.equal((await h.request('GET', `/postback/${source.id}?key=${secret}&event=reg&click_id=unknownclickid00000000&trader_id=777002`)).status, 400);

  const events = (await h.request('GET', '/api/admin/postback/events', { headers: { cookie } })).json.events;
  assert.equal(events.length, 1);
  assert.equal(events[0].eventType, 'registration');
  assert.equal(events[0].clickTelegramId, 21);
  assert.equal(events[0].global, true);
  const errors = (await h.request('GET', '/api/admin/postback/errors', { headers: { cookie } })).json.items;
  assert.ok(errors.some((e: { code: string; global: boolean }) => e.code === 'UNKNOWN_CLICK' && e.global));

  // A user without click_id proof can be linked only by an administrator, with a reason (audited).
  await login(22);
  const noReason = await h.request('POST', `/api/admin/bots/${botId}/binding/bind`, { headers: { ...CSRF, cookie }, body: { telegramId: 22, traderId: '777009', reason: '' } });
  assert.equal(noReason.status, 400);
  const bind = await h.request('POST', `/api/admin/bots/${botId}/binding/bind`, { headers: { ...CSRF, cookie }, body: { telegramId: 22, traderId: '777009', reason: 'checked with the partner manager' } });
  assert.equal(bind.json.state, 'account_bound');
  const audit = await h.request('GET', `/api/admin/bots/${botId}/logs?type=audit`, { headers: { cookie } });
  assert.ok(audit.json.items.some((a: { action: string }) => a.action === 'binding.admin_bind'));
});
