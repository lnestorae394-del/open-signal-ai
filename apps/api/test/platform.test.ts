import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_THEME, MODULES, upgradeBotConfig } from '@open-signal/shared';
import {
  ADMIN_SETUP_TOKEN,
  PROD_LIKE_ENV,
  TestClock,
  bearer,
  defaultStore,
  fakeBotToken,
  harness,
  seedBot,
  seedGlobalSource,
  type Harness,
} from './helpers.ts';
import { fakeTelegram } from './fake-telegram.ts';
import { C } from '../src/storage/collections.ts';
import { checkPartnerLink } from '../src/admin/partner-link.ts';

const CSRF = { 'x-os-admin': '1' };
const PASSWORD = 'correct horse battery';

async function adminSetup() {
  const tg = fakeTelegram();
  const h = harness(defaultStore(), new TestClock(), { env: PROD_LIKE_ENV, telegramFetch: tg.fetch });
  const r = await h.request('POST', '/api/admin/setup', { headers: CSRF, body: { setupToken: ADMIN_SETUP_TOKEN, email: 'owner@example.com', password: PASSWORD } });
  assert.equal(r.status, 201);
  const cookie = r.headers!['set-cookie']!.split(';')[0]!;
  const admin = (method: string, path: string, body?: unknown) => h.request(method, `/api/admin${path}`, { headers: { ...CSRF, cookie }, ...(body === undefined ? {} : { body }) });
  return { h, tg, admin };
}

const botBody = (token: string, name: string, extra: Record<string, unknown> = {}) => ({
  token,
  name,
  description: { ru: 'Описание', en: 'Description' },
  shortDescription: {},
  miniAppTitle: name.toUpperCase(),
  defaultLanguage: 'ru',
  theme: DEFAULT_THEME,
  supportContact: '@help',
  modules: Object.fromEntries(MODULES.map((m) => [m, true])),
  accountBinding: { traderIdPattern: '^[A-Za-z0-9_-]{3,64}$', gatedModules: ['signals'], recheckCooldownSec: 30, supportHintAfterHours: 24 },
  ...extra,
});

async function connectBot(h: Harness, tg: ReturnType<typeof fakeTelegram>, admin: Awaited<ReturnType<typeof adminSetup>>['admin'], id: number, username: string) {
  const token = fakeBotToken();
  tg.addBot(token, id, username);
  const r = await admin('POST', '/bots', botBody(token, username.replace(/Bot$/, '')));
  assert.equal(r.status, 201, JSON.stringify(r.json));
  return { botId: r.json.bot.botId as string, token };
}

const PUBLIC_RESOLVE = async () => ['93.184.216.34'];

// ───────────────────────── partner links ─────────────────────────

test('partner links: every bot has its own link, used by its Mini App with click_id, bot_id and partner_id', async () => {
  const { h, tg, admin } = await adminSetup();
  const a = await connectBot(h, tg, admin, 7001, 'AlphaBot');
  const b = await connectBot(h, tg, admin, 7002, 'BetaBot');

  assert.equal((await h.request('GET', `/api/public/bots/${a.botId}/config`)).json.partner.configured, false, 'status: not configured');
  const sa = await admin('PUT', `/bots/${a.botId}/partner`, { linkTemplate: 'https://broker-a.example.com/reg?sub={click_id}&b={bot_id}&p={partner_id}', buttonText: { ru: 'Открыть счёт' }, partnerId: 'aff-17' });
  assert.equal(sa.status, 200, JSON.stringify(sa.json));
  await admin('PUT', `/bots/${b.botId}/partner`, { linkTemplate: 'https://broker-b.example.com/join/{click_id}', buttonText: {}, partnerId: '' });
  const bad = await admin('PUT', `/bots/${b.botId}/partner`, { linkTemplate: 'http://insecure.example.com/?s={click_id}' });
  assert.equal(bad.json.error.code, 'VALIDATION_FAILED', 'only https links are accepted');

  const pubA = (await h.request('GET', `/api/public/bots/${a.botId}/config`)).json;
  assert.deepEqual(pubA.partner, { configured: true, buttonText: { ru: 'Открыть счёт' } });
  assert.equal(JSON.stringify(pubA).includes('broker-a'), false, 'the raw link is never public');

  const ua = await h.login({ botId: a.botId, token: a.token, webhookSecret: '' }, 501);
  const ub = await h.login({ botId: b.botId, token: b.token, webhookSecret: '' }, 501);
  const ra = await h.request('POST', `/api/miniapp/${a.botId}/onboarding/register`, { headers: bearer(ua.token) });
  const rb = await h.request('POST', `/api/miniapp/${b.botId}/onboarding/register`, { headers: bearer(ub.token) });
  assert.equal(ra.status, 200, JSON.stringify(ra.json));
  const linkA = new URL(ra.json.link);
  assert.equal(linkA.host, 'broker-a.example.com');
  assert.match(linkA.searchParams.get('sub')!, /^[0-9a-f]{32}$/, '128-bit click_id, lowercase hex');
  assert.equal(linkA.searchParams.get('b'), a.botId);
  assert.equal(linkA.searchParams.get('p'), 'aff-17');
  assert.match(rb.json.link, /^https:\/\/broker-b\.example\.com\/join\/[0-9a-f]{32}$/);
  assert.notEqual(linkA.searchParams.get('sub'), rb.json.link.split('/').pop(), 'same Telegram user, different bots → different click ids');

  const click = await h.store.get<{ botId: string; partnerId: string; clicks: number; userDocId: string }>(C.clickTokens, linkA.searchParams.get('sub')!);
  assert.equal(click!.botId, a.botId);
  assert.equal(click!.partnerId, 'aff-17');
  assert.equal(click!.clicks, 1);
  assert.equal(click!.userDocId, `${a.botId}_501`);

  // Changing the link: new clicks use the new link, the user's click_id and data stay.
  await admin('PUT', `/bots/${a.botId}/partner`, { linkTemplate: 'https://broker-a2.example.com/r/{click_id}', buttonText: {}, partnerId: 'aff-17' });
  const ra2 = await h.request('POST', `/api/miniapp/${a.botId}/onboarding/register`, { headers: bearer(ua.token) });
  assert.equal(ra2.json.link, `https://broker-a2.example.com/r/${linkA.searchParams.get('sub')}`);
  assert.equal((await h.store.get<{ clicks: number }>(C.clickTokens, linkA.searchParams.get('sub')!))!.clicks, 2);
});

test('partner link: Mini App gets a clear error when the link is not configured', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botNoLink', { config: { partner: { linkTemplate: null, buttonText: {}, partnerId: null } } });
  const { token } = await h.login(bot, 9);
  const r = await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/register`, { headers: bearer(token) });
  assert.equal(r.json.error.code, 'PARTNER_LINK_MISSING');
});

test('partner link check: format, https, {click_id}, private hosts never requested, real request result', async () => {
  const fetched: string[] = [];
  const fetchImpl = (async (u: string) => {
    fetched.push(String(u));
    return new Response('', { status: 302, headers: { location: 'https://broker.example.com/landing' } });
  }) as unknown as typeof fetch;
  const v = { botId: 'b1', partnerId: null };
  assert.deepEqual((await checkPartnerLink('not a link', v, { fetchImpl })).problems, ['format']);
  assert.equal((await checkPartnerLink('http://x.example.com/?s={click_id}', v, { fetchImpl })).valid, false);
  const noClick = await checkPartnerLink('https://broker.example.com/reg', v, { fetchImpl, resolve: PUBLIC_RESOLVE });
  assert.ok(noClick.problems.includes('no_click_id'));
  const before = fetched.length;
  const priv = await checkPartnerLink('https://intranet.example.com/?s={click_id}', v, { fetchImpl, resolve: async () => ['10.0.0.5'] });
  assert.ok(priv.problems.includes('private_host'));
  assert.equal(fetched.length, before, 'private host was not requested');
  const ok = await checkPartnerLink('https://broker.example.com/reg?s={click_id}', v, { fetchImpl, resolve: PUBLIC_RESOLVE });
  assert.equal(ok.httpStatus, 302);
  assert.equal(ok.redirectTo, 'https://broker.example.com/landing');
  assert.match(ok.sample!, /s=TEST_CLICK_ID_/);
  // The mock answers 302 to the same landing every time → loop → the chain is cut at 8 steps.
  assert.ok(ok.problems.includes('too_many_redirects'));
  assert.equal(ok.chain.length, 8);
});

test('partner link check follows the whole redirect chain and shows where click_id is still in the address', async () => {
  const v = { botId: 'b1', partnerId: 'p7' };
  const routes: Record<string, Response | (() => Response)> = {};
  const fetchImpl = (async (u: string) => {
    const url = new URL(u);
    const r = routes[url.origin + url.pathname];
    if (!r) return new Response('', { status: 404 });
    return typeof r === 'function' ? r() : r;
  }) as unknown as typeof fetch;
  const redirect = (to: string) => () => new Response('', { status: 302, headers: { location: to } });
  // tracker keeps the click in the address through two hops, the broker landing drops it
  routes['https://track.example.com/go'] = redirect('https://track.example.com/r?sub_id=TEST_CLICK_ID_0000000000000000&token=secret123');
  routes['https://track.example.com/r'] = redirect('/landing?a=AFF&sub_id=TEST_CLICK_ID_0000000000000000');
  routes['https://track.example.com/landing'] = redirect('https://broker.example.com/');
  routes['https://broker.example.com/'] = () => new Response('ok', { status: 200 });
  const c = await checkPartnerLink('https://track.example.com/go?sub_id={click_id}&p={partner_id}', v, { fetchImpl, resolve: PUBLIC_RESOLVE });
  assert.equal(c.reachable, true);
  assert.deepEqual(c.chain.map((h) => h.status), [302, 302, 302, 200]);
  assert.deepEqual(c.chain.map((h) => h.clickIdInUrl), [true, true, true, false]);
  assert.equal(c.clickIdInFinalUrl, false);
  assert.ok(c.problems.includes('click_id_not_in_final_url'));
  assert.ok(!c.chain.some((h) => h.url.includes('secret123')), 'other query values are hidden in the admin');
  assert.ok(c.chain[1]!.url.includes('sub_id=TEST_CLICK_ID_0000000000000000'));

  // A redirect to a private address is never requested.
  const asked: string[] = [];
  const f2 = (async (u: string) => {
    asked.push(u);
    return new Response('', { status: 302, headers: { location: 'https://internal.example.com/x' } });
  }) as unknown as typeof fetch;
  const p = await checkPartnerLink('https://track.example.com/go?s={click_id}', v, {
    fetchImpl: f2,
    resolve: async (host) => (host === 'internal.example.com' ? ['10.1.2.3'] : ['93.184.216.34']),
  });
  assert.ok(p.problems.includes('private_host'));
  assert.equal(asked.length, 1);

  // click_id kept until the end
  routes['https://track.example.com/keep'] = redirect('https://broker.example.com/?sub_id=TEST_CLICK_ID_0000000000000000');
  routes['https://broker.example.com/'] = () => new Response('ok', { status: 200 });
  const k = await checkPartnerLink('https://track.example.com/keep?sub_id={click_id}', v, { fetchImpl, resolve: PUBLIC_RESOLVE });
  assert.equal(k.clickIdInFinalUrl, true);
  assert.ok(!k.problems.includes('click_id_not_in_final_url'));
});

test('legacy config (partner link inside accountBinding) is upgraded on read', () => {
  const up = upgradeBotConfig({ name: 'x', accountBinding: { traderIdPattern: 'x', gatedModules: [], partnerLinkTemplate: 'https://old.example.com/?s={click_id}', recheckCooldownSec: 30, supportHintAfterHours: 24 } });
  assert.equal(up.partner.linkTemplate, 'https://old.example.com/?s={click_id}');
  assert.equal('partnerLinkTemplate' in up.accountBinding, false);
  assert.equal(up.telegram.menuButtonText, 'OPEN SIGNAL AI');
  // Former simulator settings stay in the document untouched (no data loss on save).
  const kept = upgradeBotConfig({ name: 'x', markets: { forex: { enabled: true } } } as never);
  assert.deepEqual((kept as { markets?: unknown }).markets, { forex: { enabled: true } });
});

// ───────────────────────── Telegram buttons ─────────────────────────

test('Telegram: menu button "OPEN SIGNAL AI" with the https Mini App URL; each step confirmed only by Telegram', async () => {
  const { h, tg, admin } = await adminSetup();
  const a = await connectBot(h, tg, admin, 7101, 'GammaBot');
  const menu = tg.callsOf('setChatMenuButton').at(-1)!;
  assert.deepEqual(menu.body['menu_button'], { type: 'web_app', text: 'OPEN SIGNAL AI', web_app: { url: `https://os.example.test/app/?bot=${a.botId}` } });
  const detail = (await admin('GET', `/bots/${a.botId}`)).json.bot;
  assert.ok(detail.telegram.steps.every((s: { ok: boolean }) => s.ok), JSON.stringify(detail.telegram.steps));
  assert.ok(detail.telegram.steps.some((s: { name: string }) => s.name === 'setWebhook'));

  // Telegram refuses → the step is NOT marked as done and the admin sees the reason.
  tg.fail('setChatMenuButton', 'Bad Request: text is too long');
  const upd = await admin('PUT', `/bots/${a.botId}/telegram`, { menuButtonText: 'Открыть сигналы', welcomeText: { ru: 'Привет! Откройте приложение кнопкой ниже.' } });
  assert.equal(upd.status, 200, JSON.stringify(upd.json));
  const step = upd.json.bot.telegram.steps.find((s: { name: string }) => s.name === 'setChatMenuButton');
  assert.equal(step.ok, false);
  assert.match(step.error, /text is too long/);
  assert.ok(upd.json.bot.telegram.issues.length > 0);
  tg.fail('setChatMenuButton', null);
  const fixed = (await admin('POST', `/bots/${a.botId}/telegram-sync`)).json.telegram;
  assert.equal(fixed.steps.find((s: { name: string }) => s.name === 'setChatMenuButton').ok, true);
  assert.equal((tg.callsOf('setChatMenuButton').at(-1)!.body['menu_button'] as { text: string }).text, 'Открыть сигналы');

  // Live webhook status from Telegram
  const wh = (await admin('GET', `/bots/${a.botId}/webhook`)).json.webhook;
  assert.equal(wh.matches, true);
  assert.equal(wh.url, `https://os.example.test/tg/webhook/${a.botId}`);
});

test('Telegram: invalid token is a clear error and creates nothing', async () => {
  const { h, admin } = await adminSetup();
  const r = await admin('POST', '/bots', botBody(fakeBotToken(), 'Ghost'));
  assert.equal(r.json.error.code, 'TELEGRAM_TOKEN_INVALID');
  assert.equal((await h.store.query(C.bots, {})).length, 0);
});

test('Telegram: /start greets in the language the user chose in the Mini App, with the custom welcome text', async () => {
  const tg = fakeTelegram();
  const h = harness(defaultStore(), new TestClock(), { telegramFetch: tg.fetch });
  const bot = await seedBot(h.s, 'botHello', { config: { telegram: { menuButtonText: 'OPEN SIGNAL AI', welcomeText: { en: 'Welcome aboard!' } } } });
  tg.addBot(bot.token, 1, 'HelloBot');
  const { token } = await h.login(bot, 42); // Telegram language uk
  await h.request('PUT', `/api/miniapp/${bot.botId}/settings`, { headers: bearer(token), body: { language: 'en' } });
  const update = { update_id: 10, message: { chat: { id: 42, type: 'private' }, text: '/start', from: { id: 42, language_code: 'uk' } } };
  const r = await h.request('POST', `/tg/webhook/${bot.botId}`, { headers: { 'x-telegram-bot-api-secret-token': bot.webhookSecret }, body: update });
  assert.equal(r.status, 200);
  const sent = tg.callsOf('sendMessage').at(-1)!;
  assert.equal(sent.body['text'], 'Welcome aboard!');
  const kb = (sent.body['reply_markup'] as { inline_keyboard: { text: string; web_app: { url: string } }[][] }).inline_keyboard[0]![0]!;
  assert.equal(kb.text, 'Open the app');
  // A user who has not chosen a language gets the bot's default language (same rule as the Mini App);
  // without a custom text for it → the built-in greeting in that language.
  const update2 = { update_id: 11, message: { chat: { id: 43, type: 'private' }, text: '/start', from: { id: 43, language_code: 'uk' } } };
  await h.request('POST', `/tg/webhook/${bot.botId}`, { headers: { 'x-telegram-bot-api-secret-token': bot.webhookSecret }, body: update2 });
  assert.match(String(tg.callsOf('sendMessage').at(-1)!.body['text']), /^Добро пожаловать в /);
});

// ───────────────────────── onboarding (end to end) ─────────────────────────

const ppGet = (h: Harness, src: { sourceId: string; secret: string }, p: Record<string, string>) =>
  h.request('GET', `/postback/${src.sourceId}?${new URLSearchParams({ key: src.secret, ...p })}`);

/** Steps 1–3 as the Mini App does them; returns the session and the click_id. */
async function onboard(h: Harness, bot: { botId: string; token: string; webhookSecret: string }, src: { sourceId: string; secret: string }, tgId: number, tid: string, ftd: string | null) {
  const { token } = await h.login(bot, tgId);
  const reg = await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/register`, { headers: bearer(token) });
  const click = new URL(reg.json.link).searchParams.get('sub')!;
  await ppGet(h, src, { event: 'reg', click_id: click, trader_id: tid });
  await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/returned`, { headers: bearer(token) });
  await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(token), body: { traderId: tid } });
  if (ftd) await ppGet(h, src, { event: 'ftd', click_id: click, trader_id: tid, sumdep: ftd });
  return { token: (await h.login(bot, tgId)).token, click };
}

test('onboarding: every relaunch opens the stored step; no step can be skipped; completed after a confirmed FTD', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botOnb');
  const src = await seedGlobalSource(h.s);
  const status = async () => (await h.login(bot, 77)).body.onboarding.status;
  assert.equal(await status(), 'registration', 'new user');
  let { token } = await h.login(bot, 77);
  const reg = await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/register`, { headers: bearer(token) });
  const click = new URL(reg.json.link).searchParams.get('sub')!;
  assert.equal(await status(), 'registration_started', 'relaunch → continue registration');
  ({ token } = await h.login(bot, 77));
  await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/returned`, { headers: bearer(token) });
  assert.equal(await status(), 'trader_id');
  await ppGet(h, src, { event: 'reg', click_id: click, trader_id: '50077777' });
  ({ token } = await h.login(bot, 77));
  await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(token), body: { traderId: '50077777' } });
  assert.equal(await status(), 'deposit', 'Trader ID verified → deposit step');
  await ppGet(h, src, { event: 'ftd', click_id: click, trader_id: '50077777', sumdep: '10' });
  assert.equal(await status(), 'completed', '$10 is enough');
  const u = await h.store.get<{ onboardingCompletedAt: string | null }>(C.users, `${bot.botId}_77`);
  assert.ok(u!.onboardingCompletedAt);
});

test('onboarding: with "require FTD" switched off, a verified Trader ID opens the app', async () => {
  const { h, tg, admin } = await adminSetup();
  const a = await connectBot(h, tg, admin, 7101, 'AlphaBot');
  await admin('PUT', `/bots/${a.botId}/partner`, { linkTemplate: 'https://partner.example.test/r?sub={click_id}', buttonText: {}, partnerId: null });
  const s = await h.request('GET', '/api/admin/settings/signals', { headers: { cookie: '' } });
  assert.equal(s.status, 401);
  const cur = (await admin('GET', '/settings/signals')).json.settings;
  assert.equal(cur.requireFtd, true, 'safe default');
  assert.equal((await admin('PUT', '/settings/signals', { ...cur, requireFtd: false })).status, 200);
  const src = await seedGlobalSource(h.s);
  const bot = { botId: a.botId, token: a.token, webhookSecret: '' };
  await onboard(h, bot, src, 5, '50055555', null);
  assert.equal((await h.login(bot, 5)).body.onboarding.status, 'completed');
});

// ───────────────────────── signals (one system for every bot) ─────────────────────────

test('signals: settings shared by all bots; BUY/SELL marked as training; open → countdown from server time; cooldown and daily limit', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botSig');
  const src = await seedGlobalSource(h.s);
  const { token } = await onboard(h, bot, src, 31, '50031000', '25');
  const auth = { headers: bearer(token) };
  const cfg = (await h.request('GET', `/api/miniapp/${bot.botId}/signals/config`, auth)).json;
  assert.equal(cfg.engine, 'training');
  assert.deepEqual(cfg.periods, [15, 30, 60, 120, 180, 300, 600, 900, 1800]);
  assert.deepEqual(cfg.categories.map((c: { id: string }) => c.id), ['forex', 'otc']);
  assert.ok(cfg.categories[1].instruments.every((i: string) => i.endsWith('_OTC')));

  const bad = await h.request('POST', `/api/miniapp/${bot.botId}/signals`, { ...auth, body: { instrumentId: 'BTCUSD', periodSec: 60 } });
  assert.equal(bad.status, 400);
  assert.equal((await h.request('POST', `/api/miniapp/${bot.botId}/signals`, { ...auth, body: { instrumentId: 'EURUSD', periodSec: 45 } })).status, 400);

  const r = await h.request('POST', `/api/miniapp/${bot.botId}/signals`, { ...auth, body: { instrumentId: 'EURUSD', periodSec: 60 } });
  assert.equal(r.status, 201);
  const sig = r.json.signal;
  assert.ok(['buy', 'sell'].includes(sig.direction));
  assert.equal(sig.engine, 'training');
  assert.equal(sig.status, 'issued');
  assert.equal(sig.openedAt, null);
  assert.equal(JSON.stringify(r.json).includes('price'), false, 'no prices at all');

  const again = await h.request('POST', `/api/miniapp/${bot.botId}/signals`, { ...auth, body: { instrumentId: 'EURUSD', periodSec: 60 } });
  assert.equal(again.status, 429);
  assert.equal(again.json.error.code, 'SIGNAL_COOLDOWN');

  h.clock.advance(5);
  const opened = (await h.request('POST', `/api/miniapp/${bot.botId}/signals/${sig.id}/open`, auth)).json.signal;
  assert.equal(opened.status, 'open');
  assert.equal(Date.parse(opened.expiresAt) - Date.parse(opened.openedAt), 60_000);
  h.clock.advance(10);
  const twice = (await h.request('POST', `/api/miniapp/${bot.botId}/signals/${sig.id}/open`, auth)).json.signal;
  assert.equal(twice.openedAt, opened.openedAt, '"I opened the trade" is fixed once');
  h.clock.advance(60);
  const list = (await h.request('GET', `/api/miniapp/${bot.botId}/signals?limit=5`, auth)).json.signals;
  assert.equal(list[0].status, 'completed');

  // Another user (and another bot) cannot open this signal.
  const other = await onboard(h, bot, src, 32, '50032000', '25');
  assert.equal((await h.request('POST', `/api/miniapp/${bot.botId}/signals/${sig.id}/open`, { headers: bearer(other.token) })).status, 404);

  // Daily limit from the shared settings.
  await h.s.store.set(C.platformSettings, 'signals', { ...(await h.s.platform.signals()), cooldownSec: 0, maxPerDay: 2 });
  h.clock.advance(20);
  const fresh = await h.login(bot, 31);
  const send = () => h.request('POST', `/api/miniapp/${bot.botId}/signals`, { headers: bearer(fresh.token), body: { instrumentId: 'EURUSD_OTC', periodSec: 15 } });
  assert.equal((await send()).status, 201);
  assert.equal((await send()).json.error.code, 'SIGNAL_LIMIT');
});

test('Forex signals are blocked while the market is closed; OTC remains available', async () => {
  const h = harness(defaultStore(), new TestClock('2026-11-21T12:00:00.000Z')); // Saturday, 14:00 UTC+2
  const bot = await seedBot(h.s, 'botForexHours');
  const src = await seedGlobalSource(h.s);
  const { token } = await onboard(h, bot, src, 87, '50087000', '25');
  const auth = { headers: bearer(token) };

  const cfg = (await h.request('GET', `/api/miniapp/${bot.botId}/signals/config`, auth)).json;
  assert.equal(cfg.forexTimezone, 'UTC+2');
  assert.equal(cfg.forexSessions.EURUSD.open, false);
  assert.equal(cfg.forexSessions.EURUSD.nextChangeAt, '2026-11-23T00:00:00.000Z');

  const forex = await h.request('POST', `/api/miniapp/${bot.botId}/signals`, {
    ...auth, body: { instrumentId: 'EURUSD', periodSec: 60 },
  });
  assert.equal(forex.status, 409);
  assert.equal(forex.json.error.code, 'FOREX_MARKET_CLOSED');

  const otc = await h.request('POST', `/api/miniapp/${bot.botId}/signals`, {
    ...auth, body: { instrumentId: 'EURUSD_OTC', periodSec: 60 },
  });
  assert.equal(otc.status, 201);
});

// ───────────────────────── academy (shared by every bot) ─────────────────────────

test('academy: one catalogue for all bots (starter course until edited), progress per user in the database', async () => {
  const { h, tg, admin } = await adminSetup();
  const a = await connectBot(h, tg, admin, 7201, 'BetaBot');
  const b = await connectBot(h, tg, admin, 7202, 'GammaBot');
  for (const x of [a, b]) await admin('PUT', `/bots/${x.botId}/partner`, { linkTemplate: 'https://partner.example.test/r?sub={click_id}', buttonText: {}, partnerId: null });
  const src = await seedGlobalSource(h.s);
  const botA = { botId: a.botId, token: a.token, webhookSecret: '' };
  const botB = { botId: b.botId, token: b.token, webhookSecret: '' };
  const ua = await onboard(h, botA, src, 41, '50041000', '15');
  const ub = await onboard(h, botB, src, 41, '50041001', '15');

  const ca = (await h.request('GET', `/api/miniapp/${a.botId}/academy`, { headers: bearer(ua.token) })).json;
  const cb = (await h.request('GET', `/api/miniapp/${b.botId}/academy`, { headers: bearer(ub.token) })).json;
  assert.equal(ca.catalog.builtIn, true);
  assert.deepEqual(ca.catalog, cb.catalog, 'the same academy in every bot');
  assert.equal(ca.catalog.categories.flatMap((c: { lessons: unknown[] }) => c.lessons).length, 10);
  const lesson = (await h.request('GET', `/api/miniapp/${a.botId}/academy/lessons/l2`, { headers: bearer(ua.token) })).json.lesson;
  for (const l of ['ru', 'uk', 'en']) assert.ok(lesson.body[l].length > 100, `lesson text in ${l}`);

  await h.request('PUT', `/api/miniapp/${a.botId}/academy/lessons/l1/progress`, { headers: bearer(ua.token), body: { done: true } });
  const again = await h.login(botA, 41);
  assert.deepEqual(again.body.academy, { done: 1, total: 10 }, 'progress survives a new session');
  assert.deepEqual((await h.login(botB, 41)).body.academy, { done: 0, total: 10 }, 'progress is per user (per bot)');

  // Admin: copy the starter course, then edit; drafts are hidden from users.
  assert.equal((await admin('POST', '/academy/import')).json.catalog.builtIn, false);
  const created = await admin('POST', '/academy/lessons', {
    categoryId: 'basics', title: { ru: 'Черновик', uk: 'Чернетка', en: 'Draft' }, summary: {}, body: { ru: 'Текст', uk: 'Текст', en: 'Text' },
    videoUrl: 'https://youtu.be/dQw4w9WgXcQ', pdfUrl: 'https://example.com/a.pdf', durationMin: 3, order: 999, published: false,
  });
  assert.equal(created.status, 201, JSON.stringify(created.json));
  const bad = await admin('POST', '/academy/lessons', { categoryId: 'basics', title: {}, summary: {}, body: {}, videoUrl: 'http://insecure.example.com/v.mp4', pdfUrl: null, durationMin: 1, order: 1, published: true });
  assert.equal(bad.json.error.code, 'VALIDATION_FAILED');
  const after = (await h.request('GET', `/api/miniapp/${a.botId}/academy`, { headers: bearer(again.token) })).json;
  assert.equal(after.catalog.categories.flatMap((c: { lessons: unknown[] }) => c.lessons).length, 10, 'draft not shown');
  assert.equal((await h.request('GET', `/api/miniapp/${a.botId}/academy/lessons/${created.json.id}`, { headers: bearer(again.token) })).status, 404);
  assert.equal(after.progress['l1'] !== undefined, true, 'progress kept after the copy (same lesson ids)');
  assert.equal((await admin('DELETE', '/academy/categories/basics')).json.error.code, 'VALIDATION_FAILED', 'non-empty category cannot be deleted');
});

// ───────────────────────── admin: users, permissions, delete ─────────────────────────

test('admin users: all bots in one list with Telegram ID, bot, Trader ID, onboarding, verification and deposit', async () => {
  const { h, tg, admin } = await adminSetup();
  const a = await connectBot(h, tg, admin, 7301, 'EpsBot');
  const b = await connectBot(h, tg, admin, 7302, 'ZetaBot');
  await h.login({ botId: a.botId, token: a.token, webhookSecret: '' }, 1);
  h.clock.advance(1);
  await h.login({ botId: b.botId, token: b.token, webhookSecret: '' }, 2);
  const all = (await admin('GET', '/users')).json.users;
  assert.equal(all.length, 2);
  assert.deepEqual(all.map((u: { botName: string }) => u.botName), ['Zeta', 'Eps']);
  assert.equal(all[0].onboardingStatus, 'registration');
  assert.equal(all[0].verification, 'not_submitted');
  const only = (await admin('GET', `/users?botId=${a.botId}`)).json.users;
  assert.deepEqual(only.map((u: { telegramId: number }) => u.telegramId), [1]);
});

test('admin permissions: a manager cannot change the partner link or the shared signal settings', async () => {
  const { h, tg, admin } = await adminSetup();
  const a = await connectBot(h, tg, admin, 7401, 'EtaBot');
  const inv = await admin('POST', '/managers', { email: 'm@example.com', botPermissions: { [a.botId]: ['bot.appearance.edit', 'users.view'] } });
  const token = new URL(inv.json.inviteUrl).hash.split('/').pop()!;
  const acc = await h.request('POST', '/api/admin/invite/accept', { headers: CSRF, body: { token, password: PASSWORD } });
  const mc = acc.headers!['set-cookie']!.split(';')[0]!;
  const asManager = (method: string, path: string, body?: unknown) => h.request(method, `/api/admin${path}`, { headers: { ...CSRF, cookie: mc }, ...(body === undefined ? {} : { body }) });
  assert.equal((await asManager('PUT', `/bots/${a.botId}/partner`, { linkTemplate: 'https://evil.example.com/{click_id}' })).status, 403);
  assert.equal((await asManager('PUT', '/settings/signals', { periods: [60] })).status, 403);
  assert.equal((await asManager('POST', '/academy/import')).status, 403);
  assert.equal((await asManager('GET', '/postback/sources')).status, 403);
  // The general settings form cannot change the partner link either.
  const cur = (await asManager('GET', `/bots/${a.botId}`)).json.bot.config;
  await asManager('PUT', `/bots/${a.botId}/config`, { ...cur, partner: { linkTemplate: 'https://evil.example.com/{click_id}', buttonText: {}, partnerId: null } });
  assert.equal((await admin('GET', `/bots/${a.botId}`)).json.bot.config.partner.linkTemplate, null);
  assert.equal((await asManager('DELETE', `/bots/${a.botId}`, { confirm: 'EtaBot' })).status, 403, 'only the owner deletes bots');
});

test('delete bot: owner confirms with the username; bot data removed, other bots untouched, Telegram detached', async () => {
  const { h, tg, admin } = await adminSetup();
  const a = await connectBot(h, tg, admin, 7501, 'ThetaBot');
  const b = await connectBot(h, tg, admin, 7502, 'IotaBot');
  const ua = await h.login({ botId: a.botId, token: a.token, webhookSecret: '' }, 1);
  await h.login({ botId: b.botId, token: b.token, webhookSecret: '' }, 1);
  await h.s.store.create(C.signals, 'sig1', { botId: a.botId, userDocId: `${a.botId}_1`, instrumentId: 'EURUSD_OTC', category: 'otc', periodSec: 60, direction: 'buy', engine: 'training', createdAt: h.clock.now().toISOString(), openedAt: null, expiresAt: null });
  void ua;

  assert.equal((await admin('DELETE', `/bots/${a.botId}`, { confirm: 'wrong' })).json.error.code, 'CONFIRMATION_MISMATCH');
  const del = await admin('DELETE', `/bots/${a.botId}`, { confirm: '@ThetaBot' });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(del.json.removed[C.users], 1);
  assert.equal(del.json.removed[C.signals], 1);
  assert.equal((await admin('GET', `/bots/${a.botId}`)).status, 404);
  assert.equal(await h.store.get(C.users, `${a.botId}_1`), null);
  assert.ok(await h.store.get(C.users, `${b.botId}_1`), 'other bot untouched');
  assert.equal(tg.callsOf('deleteWebhook').length, 1);
  assert.equal((await h.request('POST', `/api/miniapp/${a.botId}/session`, { body: { initData: 'x' } })).status, 404);
  const audit = await h.store.query<{ action: string }>(C.auditLogs, { where: [{ field: 'action', op: '==', value: 'bot.deleted' }] });
  assert.equal(audit.length, 1, 'deletion is kept in the audit log');
  // The same Telegram bot can be connected again later.
  tg.addBot(a.token, 7501, 'ThetaBot');
  assert.equal((await admin('POST', '/bots', botBody(a.token, 'Theta again'))).status, 201);
});

test('settings persist on the server: language and favorites survive a new session on another device', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botPersist');
  const first = await h.login(bot, 21);
  await h.request('PUT', `/api/miniapp/${bot.botId}/settings`, { headers: bearer(first.token), body: { language: 'en', favorites: ['EURUSD', 'GBPJPY_OTC'] } });
  const second = await h.login(bot, 21);
  assert.deepEqual(second.body.settings, { language: 'en', favorites: ['EURUSD', 'GBPJPY_OTC'] });
  assert.equal((await h.request('PUT', `/api/miniapp/${bot.botId}/settings`, { headers: bearer(first.token), body: { favorites: ['NOPE'] } })).status, 400);
});
