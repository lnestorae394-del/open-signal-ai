import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_MARKET_SETTINGS, DEFAULT_THEME, MODULES, upgradeBotConfig } from '@open-signal/shared';
import {
  ADMIN_SETUP_TOKEN,
  PROD_LIKE_ENV,
  TestClock,
  bearer,
  defaultStore,
  fakeBotToken,
  harness,
  seedBot,
  seedSource,
  type Harness,
} from './helpers.ts';
import { fakeTelegram } from './fake-telegram.ts';
import { C } from '../src/storage/collections.ts';
import { SimulationSource } from '../src/market/simulator.ts';
import { checkPartnerLink } from '../src/admin/partner-link.ts';
import { marketContext } from '../src/market/signals.ts';

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
  assert.match(linkA.searchParams.get('sub')!, /^[A-Za-z0-9_-]{22}$/, '128-bit click_id');
  assert.equal(linkA.searchParams.get('b'), a.botId);
  assert.equal(linkA.searchParams.get('p'), 'aff-17');
  assert.match(rb.json.link, /^https:\/\/broker-b\.example\.com\/join\/[A-Za-z0-9_-]{22}$/);
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
  const priv = await checkPartnerLink('https://intranet.example.com/?s={click_id}', v, { fetchImpl, resolve: async () => ['10.0.0.5'] });
  assert.ok(priv.problems.includes('private_host'));
  assert.equal(fetched.length, 1, 'private host was not requested');
  const ok = await checkPartnerLink('https://broker.example.com/reg?s={click_id}', v, { fetchImpl, resolve: PUBLIC_RESOLVE });
  assert.equal(ok.reachable, true);
  assert.equal(ok.httpStatus, 302);
  assert.equal(ok.redirectTo, 'https://broker.example.com/landing');
  assert.match(ok.sample!, /s=TEST_CLICK_ID_/);
});

test('legacy config (partner link inside accountBinding) is upgraded on read', () => {
  const up = upgradeBotConfig({ name: 'x', accountBinding: { traderIdPattern: 'x', gatedModules: [], partnerLinkTemplate: 'https://old.example.com/?s={click_id}', recheckCooldownSec: 30, supportHintAfterHours: 24 } });
  assert.equal(up.partner.linkTemplate, 'https://old.example.com/?s={click_id}');
  assert.equal('partnerLinkTemplate' in up.accountBinding, false);
  assert.equal(up.telegram.menuButtonText, 'OPEN SIGNAL AI');
  assert.deepEqual(up.markets.forex, DEFAULT_MARKET_SETTINGS.forex);
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

// ───────────────────────── onboarding + persistence ─────────────────────────

test('onboarding: registration → started → Trader ID → waiting → confirmed; every relaunch opens the right step', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botOnb');
  const src = await seedSource(h.s, bot.botId, 'partner-onb');
  const status = async () => (await h.login(bot, 77)).body.onboarding.status;

  assert.equal(await status(), 'registration', 'new user');
  let { token } = await h.login(bot, 77);
  await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/register`, { headers: bearer(token) });
  assert.equal(await status(), 'registration_started', 'relaunch → continue registration');
  ({ token } = await h.login(bot, 77));
  await h.request('POST', `/api/miniapp/${bot.botId}/onboarding/returned`, { headers: bearer(token) });
  assert.equal(await status(), 'trader_id');
  ({ token } = await h.login(bot, 77));
  const sub = await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(token), body: { traderId: 'TR-777' } });
  assert.equal(sub.json.binding.state, 'registration_pending');
  const waiting = (await h.login(bot, 77)).body.onboarding;
  assert.equal(waiting.status, 'pending_review', 'no fake confirmation while the partner has not confirmed');
  assert.equal(waiting.verification, 'pending');
  assert.match(waiting.traderIdMasked, /777$/, 'the submitted Trader ID is shown back, masked');
  assert.equal(waiting.traderIdMasked.includes('TR-777'), false);
  assert.equal(waiting.deposit.status, 'unknown');

  h.clock.advance(600);
  await h.request('GET', `/postback/${src.sourceId}?${new URLSearchParams({ token: src.secret, event: 'reg', trader_id: 'TR-777', event_id: 'r1' })}`);
  const done = (await h.login(bot, 77)).body.onboarding;
  assert.equal(done.status, 'completed');
  assert.equal(done.verification, 'confirmed');
  assert.equal(done.deposit.status, 'none', 'source connected, no deposit events yet');
  // Later launches go straight to the main app — the state lives in the database, not on the device.
  assert.equal(await status(), 'completed');
  const user = await h.store.get<{ registrationStartedAt: string; bindingState: string }>(C.users, `${bot.botId}_77`);
  assert.equal(user!.bindingState, 'account_bound');
  assert.ok(user!.registrationStartedAt);
});

test('onboarding: deposit status only from postback events (FTD with amount, $10 mark, redeposit)', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botDep');
  const src = await seedSource(h.s, bot.botId, 'partner-dep');
  const pb = (p: Record<string, string>) => h.request('GET', `/postback/${src.sourceId}?${new URLSearchParams({ token: src.secret, ...p })}`);
  await pb({ event: 'reg', trader_id: 'D100', event_id: 'r1' });
  const { token } = await h.login(bot, 5);
  await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(token), body: { traderId: 'D100' } });

  await pb({ event: 'ftd', trader_id: 'D100', event_id: 'f1', amount: '25.50', currency: 'usd', ts: '2026-11-18T13:00:00Z' });
  await pb({ event: 'ftd', trader_id: 'D100', event_id: 'f1', amount: '25.50', currency: 'usd', ts: '2026-11-18T13:00:00Z' }); // duplicate delivery
  let d = (await h.request('GET', `/api/miniapp/${bot.botId}/onboarding`, { headers: bearer(token) })).json.onboarding.deposit;
  assert.equal(d.status, 'ftd');
  assert.equal(d.ftdAmount, 25.5);
  assert.equal(d.ftdCurrency, 'USD');
  assert.equal(d.ftdAt, '2026-11-18T13:00:00.000Z');
  assert.equal(d.ftdThresholdMet, true);
  assert.equal(d.depositsCount, 1, 'duplicate delivery counted once');

  await pb({ event: 'dep', trader_id: 'D100', event_id: 'd2', amount: '40', currency: 'USD', ts: '2026-11-19T09:00:00Z' });
  d = (await h.request('GET', `/api/miniapp/${bot.botId}/onboarding`, { headers: bearer(token) })).json.onboarding.deposit;
  assert.equal(d.status, 'redeposit');
  assert.equal(d.depositsCount, 2);
  assert.equal(d.ftdAmount, 25.5);
  // Financial events never change access or binding state.
  assert.equal((await h.store.get<{ bindingState: string; deposit: { status: string } }>(C.users, `${bot.botId}_5`))!.deposit.status, 'redeposit');

  // Somebody else's deposits are never shown to a user who only typed that Trader ID.
  const other = await h.login(bot, 6);
  await h.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(other.token), body: { traderId: 'D100' } });
  const od = (await h.request('GET', `/api/miniapp/${bot.botId}/onboarding`, { headers: bearer(other.token) })).json.onboarding;
  assert.equal(od.deposit.status, 'unknown');
  assert.equal(od.deposit.ftdAmount, null);
});

test('onboarding: bot without account binding goes straight to the app; Academy and demo never need a deposit', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botOpen', { config: { modules: { ...Object.fromEntries(MODULES.map((m) => [m, true])), account_binding: false } as never } });
  const { body, token } = await h.login(bot, 1);
  assert.equal(body.onboarding.status, 'completed');
  const bot2 = await seedBot(h.s, 'botGated');
  const u2 = await h.login(bot2, 2);
  assert.equal(u2.body.onboarding.status, 'registration');
  assert.equal(u2.body.access.academy, true);
  assert.equal(u2.body.access.simulator, true);
  const sig = await h.request('POST', `/api/miniapp/${bot2.botId}/market/forex/signals`, { headers: bearer(u2.token), body: { instrumentId: 'EURUSD', periodSec: 60 } });
  assert.equal(sig.status, 201, 'demo signals on simulated data are open without registration');
  void token;
});

// ───────────────────────── simulators ─────────────────────────

test('simulator: deterministic, independent per mode and per bot, valid candles, never claims real data', () => {
  const sim = new SimulationSource();
  const now = new Date('2026-11-18T12:00:00Z');
  const fx = marketContext('botA', 'forex', DEFAULT_MARKET_SETTINGS.forex);
  const otc = marketContext('botA', 'otc', DEFAULT_MARKET_SETTINGS.otc);
  const fxB = marketContext('botB', 'forex', DEFAULT_MARKET_SETTINGS.forex);
  const q1 = sim.quote(fx, 'EURUSD', now);
  assert.deepEqual(sim.quote(fx, 'EURUSD', now), q1, 'same input → same synthetic price (restarts, several instances)');
  assert.notEqual(sim.quote(fxB, 'EURUSD', now).price, q1.price, 'another bot has its own series');
  assert.notEqual(sim.quote(otc, 'EURUSD_OTC', now).price, q1.price, 'OTC is a separate simulator');
  assert.ok(q1.price > 0.9 && q1.price < 1.3);
  assert.equal(sim.status(fx, now).status, 'SIMULATED');
  assert.equal(sim.simulated, true);
  assert.throws(() => sim.quote(fx, 'EURUSD_OTC', now), /not available/, 'OTC instrument is not part of Forex');

  const candles = sim.candles(fx, 'EURUSD', 60, 30, now);
  assert.equal(candles.length, 30);
  for (const c of candles) {
    assert.ok(c.high >= Math.max(c.open, c.close) && c.low <= Math.min(c.open, c.close));
    assert.equal(c.time % 60000, 0);
  }
  const moves = new Set(candles.map((c) => c.close));
  assert.ok(moves.size > 20, 'prices actually move');

  // Forex simulation pauses while the real Forex market is closed (weekend); OTC keeps running.
  const sat1 = new Date('2026-11-21T10:00:00Z');
  const sat2 = new Date('2026-11-21T15:00:00Z');
  assert.equal(sim.status(fx, sat1).marketOpen, false);
  assert.equal(sim.quote(fx, 'EURUSD', sat1).price, sim.quote(fx, 'EURUSD', sat2).price);
  assert.notEqual(sim.quote(otc, 'EURUSD_OTC', sat1).price, sim.quote(otc, 'EURUSD_OTC', sat2).price);
});

test('demo signals: created on synthetic data, cooldown, daily limit, resolved after expiry, history and stats per mode', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botSig', {
    config: { markets: { ...DEFAULT_MARKET_SETTINGS, otc: { ...DEFAULT_MARKET_SETTINGS.otc, maxSignalsPerDay: 3, signalCooldownSec: 10 } } },
  });
  const { token } = await h.login(bot, 11);
  const post = (mode: string, body: unknown) => h.request('POST', `/api/miniapp/${bot.botId}/market/${mode}/signals`, { headers: bearer(token), body });

  const ov = (await h.request('GET', `/api/miniapp/${bot.botId}/market/otc/overview`, { headers: bearer(token) })).json;
  assert.equal(ov.status, 'SIMULATED');
  assert.equal(ov.source.simulated, true);
  assert.equal(ov.quotes.length, 21);
  const ch = (await h.request('GET', `/api/miniapp/${bot.botId}/market/otc/candles?instrument=GBPUSD_OTC&count=40`, { headers: bearer(token) })).json;
  assert.equal(ch.candles.length, 40);
  assert.equal(ch.rsi.length, 40);
  assert.ok(ch.rsi.every((v: number | null) => v === null || (v >= 0 && v <= 100)));

  const s1 = await post('otc', { instrumentId: 'EURUSD_OTC', periodSec: 60 });
  assert.equal(s1.status, 201, JSON.stringify(s1.json));
  assert.equal(s1.json.signal.simulated, true);
  assert.equal(s1.json.signal.outcome, 'open');
  assert.ok(['up', 'down'].includes(s1.json.signal.direction));
  const tooSoon = await post('otc', { instrumentId: 'EURUSD_OTC', periodSec: 60 });
  assert.equal(tooSoon.status, 429);
  assert.equal(tooSoon.json.error.retryAfterSec, 10);
  assert.equal((await post('otc', { instrumentId: 'EURUSD_OTC', periodSec: 45 })).status, 400, 'period not offered');
  h.clock.advance(11);
  assert.equal((await post('otc', { instrumentId: 'AUDJPY_OTC', periodSec: 30 })).status, 201);
  h.clock.advance(11);
  assert.equal((await post('otc', { instrumentId: 'AUDJPY_OTC', periodSec: 30 })).status, 201);
  h.clock.advance(11);
  assert.equal((await post('otc', { instrumentId: 'AUDJPY_OTC', periodSec: 30 })).json.error.code, 'SIGNAL_LIMIT');

  let hist = (await h.request('GET', `/api/miniapp/${bot.botId}/signals?mode=otc`, { headers: bearer(token) })).json;
  assert.equal(hist.stats.total, 3);
  h.clock.advance(120);
  hist = (await h.request('GET', `/api/miniapp/${bot.botId}/signals?mode=otc`, { headers: bearer(token) })).json;
  assert.equal(hist.stats.open, 0, 'expired signals are resolved');
  assert.equal(hist.stats.win + hist.stats.loss + hist.stats.draw, 3);
  const first = hist.signals.at(-1);
  const sim = new SimulationSource();
  const exit = sim.priceAt((await h.store.get<{ sim: never }>(C.simulationHistory, first.id))!.sim, new Date(first.expiresAt));
  assert.equal(first.exitPrice, exit, 'outcome is reproducible from stored simulation parameters');
  assert.equal((await h.request('GET', `/api/miniapp/${bot.botId}/signals?mode=forex`, { headers: bearer(token) })).json.stats.total, 0, 'Forex history is separate');

  // Another bot's user never sees these signals
  const bot2 = await seedBot(h.s, 'botSig2');
  const u2 = await h.login(bot2, 11);
  assert.equal((await h.request('GET', `/api/miniapp/${bot2.botId}/signals?mode=otc`, { headers: bearer(u2.token) })).json.stats.total, 0);
});

test('demo signals: Forex closed on the weekend → no new signals, OTC continues', async () => {
  const h = harness(defaultStore(), new TestClock('2026-11-21T12:00:00.000Z'));
  const bot = await seedBot(h.s, 'botWeekend');
  const { token } = await h.login(bot, 3);
  const fx = await h.request('POST', `/api/miniapp/${bot.botId}/market/forex/signals`, { headers: bearer(token), body: { instrumentId: 'EURUSD', periodSec: 60 } });
  assert.equal(fx.json.error.code, 'MARKET_CLOSED');
  const otc = await h.request('POST', `/api/miniapp/${bot.botId}/market/otc/signals`, { headers: bearer(token), body: { instrumentId: 'EURUSD_OTC', periodSec: 60 } });
  assert.equal(otc.status, 201);
});

test('markets in admin: per-bot Forex/OTC settings validated and applied; disabled mode is closed in the Mini App', async () => {
  const { h, tg, admin } = await adminSetup();
  const a = await connectBot(h, tg, admin, 7201, 'DeltaBot');
  const next = { ...DEFAULT_MARKET_SETTINGS.otc, instruments: ['EURUSD_OTC', 'GBPUSD_OTC'], periods: [30, 60], defaultPeriod: 30, volatility: 'high' };
  const ok = await admin('PUT', `/bots/${a.botId}/markets/otc`, next);
  assert.equal(ok.status, 200, JSON.stringify(ok.json));
  assert.deepEqual(ok.json.bot.config.markets.otc.instruments, ['EURUSD_OTC', 'GBPUSD_OTC']);
  assert.equal((await admin('PUT', `/bots/${a.botId}/markets/otc`, { ...next, instruments: ['EURUSD'] })).json.error.code, 'VALIDATION_FAILED', 'a Forex pair is not an OTC instrument');
  assert.equal((await admin('PUT', `/bots/${a.botId}/markets/otc`, { ...next, defaultPeriod: 300 })).json.error.code, 'VALIDATION_FAILED');
  await admin('PUT', `/bots/${a.botId}/markets/forex`, { ...DEFAULT_MARKET_SETTINGS.forex, enabled: false });
  const pub = (await h.request('GET', `/api/public/bots/${a.botId}/config`)).json;
  assert.equal(pub.markets.forex.enabled, false);
  assert.deepEqual(pub.markets.otc.periods, [30, 60]);
  const u = await h.login({ botId: a.botId, token: a.token, webhookSecret: '' }, 9);
  assert.equal((await h.request('GET', `/api/miniapp/${a.botId}/market/forex/overview`, { headers: bearer(u.token) })).json.error.code, 'MARKET_DISABLED');
  assert.equal((await h.request('GET', `/api/miniapp/${a.botId}/market/otc/overview`, { headers: bearer(u.token) })).json.quotes.length, 2);
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

test('admin permissions: a manager cannot change the partner link or markets without those rights', async () => {
  const { h, tg, admin } = await adminSetup();
  const a = await connectBot(h, tg, admin, 7401, 'EtaBot');
  const inv = await admin('POST', '/managers', { email: 'm@example.com', botPermissions: { [a.botId]: ['bot.appearance.edit', 'users.view'] } });
  const token = new URL(inv.json.inviteUrl).hash.split('/').pop()!;
  const acc = await h.request('POST', '/api/admin/invite/accept', { headers: CSRF, body: { token, password: PASSWORD } });
  const mc = acc.headers!['set-cookie']!.split(';')[0]!;
  const asManager = (method: string, path: string, body?: unknown) => h.request(method, `/api/admin${path}`, { headers: { ...CSRF, cookie: mc }, ...(body === undefined ? {} : { body }) });
  assert.equal((await asManager('PUT', `/bots/${a.botId}/partner`, { linkTemplate: 'https://evil.example.com/{click_id}' })).status, 403);
  assert.equal((await asManager('PUT', `/bots/${a.botId}/markets/forex`, DEFAULT_MARKET_SETTINGS.forex)).status, 403);
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
  await h.request('POST', `/api/miniapp/${a.botId}/market/otc/signals`, { headers: bearer(ua.token), body: { instrumentId: 'EURUSD_OTC', periodSec: 60 } });

  assert.equal((await admin('DELETE', `/bots/${a.botId}`, { confirm: 'wrong' })).json.error.code, 'CONFIRMATION_MISMATCH');
  const del = await admin('DELETE', `/bots/${a.botId}`, { confirm: '@ThetaBot' });
  assert.equal(del.status, 200, JSON.stringify(del.json));
  assert.equal(del.json.removed[C.users], 1);
  assert.equal(del.json.removed[C.simulationHistory], 1);
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

test('settings persist on the server: language, favorites and Forex/OTC mode survive a new session on another device', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botPersist');
  const first = await h.login(bot, 21);
  await h.request('PUT', `/api/miniapp/${bot.botId}/settings`, { headers: bearer(first.token), body: { language: 'en', favorites: ['EURUSD', 'GBPJPY_OTC'], marketMode: 'otc' } });
  const second = await h.login(bot, 21);
  assert.deepEqual(second.body.settings, { language: 'en', favorites: ['EURUSD', 'GBPJPY_OTC'], analysisMode: 'BASIC', marketMode: 'otc' });
  assert.equal((await h.request('PUT', `/api/miniapp/${bot.botId}/settings`, { headers: bearer(first.token), body: { marketMode: 'crypto' } })).status, 400);
});
