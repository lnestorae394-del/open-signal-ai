import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { bearer, harness, seedBot, TestClock } from './helpers.ts';
import { LocalDocumentStore } from '../src/storage/local-store.ts';
import { C } from '../src/storage/collections.ts';
import { SECRET_HEADER } from '../src/telegram/webhook.ts';
import { signInitDataForTests } from '../src/telegram/init-data.ts';

test('health reports honestly what is NOT connected', async () => {
  const h = harness();
  const r = await h.request('GET', '/health');
  assert.equal(r.status, 200);
  assert.equal(r.json.firebaseConnected, false);
  assert.equal(r.json.telegramConnected, false);
  assert.equal(r.json.marketDataConnected, false);
  assert.equal(r.headers?.['x-content-type-options'], 'nosniff');
});

test('100 bots on one server: each has its own config, users and sessions', async () => {
  const h = harness();
  const bots = [];
  for (let i = 0; i < 100; i++) {
    bots.push(await seedBot(h.s, `bot${String(i).padStart(3, '0')}`, { config: { name: `Bot ${i}`, defaultLanguage: i % 2 ? 'en' : 'uk' } }));
  }
  for (const [i, b] of bots.entries()) {
    const cfg = await h.request('GET', `/api/public/bots/${b.botId}/config`, { ip: `10.0.${i}.1` });
    assert.equal(cfg.json.name, `Bot ${i}`);
    assert.equal(JSON.stringify(cfg.json).includes(b.token), false, 'public config never contains the token');
  }
  // The same Telegram user opens two different bots → two independent profiles.
  const a = await h.login(bots[0]!, 777);
  const b = await h.login(bots[1]!, 777);
  assert.ok(await h.store.get(C.users, 'bot000_777'));
  assert.ok(await h.store.get(C.users, 'bot001_777'));
  // Bot A's session cannot be used on bot B.
  const cross = await h.request('GET', `/api/miniapp/${bots[1]!.botId}/me`, { headers: bearer(a.token) });
  assert.equal(cross.status, 401);
  const own = await h.request('GET', `/api/miniapp/${bots[1]!.botId}/me`, { headers: bearer(b.token) });
  assert.equal(own.status, 200);
});

test('initData signed by bot A is rejected by bot B', async () => {
  const h = harness();
  const a = await seedBot(h.s, 'botAAAA');
  const b = await seedBot(h.s, 'botBBBB');
  const initData = signInitDataForTests(a.token, {
    auth_date: String(Math.floor(h.clock.t / 1000)),
    user: JSON.stringify({ id: 5, first_name: 'X' }),
  });
  const r = await h.request('POST', `/api/miniapp/${b.botId}/session`, { body: { initData } });
  assert.equal(r.status, 401);
  assert.equal(r.json.error.code, 'INIT_DATA_INVALID');
});

test('first launch creates the profile, the next launch returns it (no re-registration)', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botLaunch');
  const first = await h.login(bot, 1001);
  h.clock.advance(3600);
  const second = await h.login(bot, 1001);
  assert.equal(first.body.user.registeredAt, second.body.user.registeredAt);
  const u = await h.store.get<{ launches: number }>(C.users, 'botLaunch_1001');
  assert.equal(u!.launches, 2);
});

test('client cannot choose its Telegram ID: body fields are ignored, only signed initData counts', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botSpoof');
  const r = await h.request('POST', `/api/miniapp/${bot.botId}/session`, { body: { initData: 'user=%7B%22id%22%3A1%7D', telegramId: 1 } });
  assert.equal(r.status, 401);
});

test('disabled bot: data kept, users see BOT_DISABLED, public config says disabled', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botToggle');
  await h.login(bot, 55);
  await h.s.bots.setStatus(bot.botId, 'disabled', h.clock.now());
  const cfg = await h.request('GET', `/api/public/bots/${bot.botId}/config`);
  assert.equal(cfg.json.status, 'disabled');
  const initData = signInitDataForTests(bot.token, { auth_date: String(Math.floor(h.clock.t / 1000)), user: JSON.stringify({ id: 55, first_name: 'A' }) });
  const r = await h.request('POST', `/api/miniapp/${bot.botId}/session`, { body: { initData } });
  assert.equal(r.json.error.code, 'BOT_DISABLED');
  assert.ok(await h.store.get(C.users, 'botToggle_55'), 'user data is not deleted');
  await h.s.bots.setStatus(bot.botId, 'active', h.clock.now());
  await h.login(bot, 55);
});

test('settings: language and favourites are saved per user and validated', async () => {
  const h = harness();
  const bot = await seedBot(h.s, 'botSettings');
  const { token } = await h.login(bot, 9);
  const ok = await h.request('PUT', `/api/miniapp/${bot.botId}/settings`, { headers: bearer(token), body: { language: 'en', favorites: ['EURUSD', 'GBPUSD_OTC'] } });
  assert.equal(ok.status, 200);
  assert.deepEqual(ok.json.settings.favorites, ['EURUSD', 'GBPUSD_OTC']);
  const bad = await h.request('PUT', `/api/miniapp/${bot.botId}/settings`, { headers: bearer(token), body: { favorites: ['FAKE'] } });
  assert.equal(bad.status, 400);
  const me = await h.request('GET', `/api/miniapp/${bot.botId}/me`, { headers: bearer(token) });
  assert.equal(me.json.settings.language, 'en');
});

test('webhook: secret required; a redelivered update is processed once, also concurrently', async () => {
  let processed = 0;
  const h = harness();
  (h.s.webhooks as unknown as { handler: { handle: () => Promise<void> } }).handler = { handle: async () => void processed++ };
  const bot = await seedBot(h.s, 'botHook');
  const url = `/tg/webhook/${bot.botId}`;
  const update = { update_id: 1001, message: { text: '/start' } };

  assert.equal((await h.request('POST', url, { body: update })).status, 401, 'missing secret');
  assert.equal((await h.request('POST', url, { body: update, headers: { [SECRET_HEADER]: 'wrong' } })).status, 401);

  const deliveries = await Promise.all(
    Array.from({ length: 10 }, () => h.request('POST', url, { body: update, headers: { [SECRET_HEADER]: bot.webhookSecret } })),
  );
  assert.ok(deliveries.every((d) => d.status === 200), 'every delivery is acknowledged so Telegram stops retrying');
  assert.equal(deliveries.filter((d) => d.json.duplicate).length, 9);
  assert.equal(processed, 1);

  // same update_id on ANOTHER bot is a different update
  const other = await seedBot(h.s, 'botHook2');
  const r = await h.request('POST', `/tg/webhook/${other.botId}`, { body: update, headers: { [SECRET_HEADER]: other.webhookSecret } });
  assert.equal(r.json.duplicate, undefined);
  assert.equal(processed, 2);
});

test('pipeline: CORS allow-list, rate limiting with Retry-After, unknown route, body limit', async () => {
  const h = harness();
  await seedBot(h.s, 'botLimits');
  const allowed = await h.request('GET', '/health', { headers: { origin: 'https://app.example.test' } });
  assert.equal(allowed.headers?.['access-control-allow-origin'], 'https://app.example.test');
  const denied = await h.request('GET', '/health', { headers: { origin: 'https://evil.example' } });
  assert.equal(denied.headers?.['access-control-allow-origin'], undefined);

  let last;
  for (let i = 0; i < 11; i++) last = await h.request('POST', '/api/miniapp/botLimits/session', { body: { initData: 'x' }, ip: '192.0.2.77' });
  assert.equal(last!.status, 429);
  assert.ok(Number(last!.headers?.['retry-after']) >= 1);

  assert.equal((await h.request('GET', '/nope')).status, 404);
  assert.equal((await h.request('POST', '/tg/webhook/botLimits', { raw: 'x'.repeat(70 * 1024) })).status, 413);
});

test('restart: sessions and user state survive a server restart (persisted store)', async () => {
  const file = join(mkdtempSync(join(tmpdir(), 'os-restart-')), 'store.json');
  const clock = new TestClock();
  const h1 = harness(new LocalDocumentStore(file), clock);
  const bot = await seedBot(h1.s, 'botRestart');
  const { token } = await h1.login(bot, 3030);
  await h1.request('POST', `/api/miniapp/${bot.botId}/binding/trader-id`, { headers: bearer(token), body: { traderId: 'TR-30300' } });
  await h1.s.store.close();

  // "Restart": brand-new services over the same file and the same secrets.
  const h2 = harness(new LocalDocumentStore(file), clock);
  const me = await h2.request('GET', `/api/miniapp/${bot.botId}/me`, { headers: bearer(token) });
  assert.equal(me.status, 200, 'old session still valid');
  assert.equal(me.json.binding.state, 'registration_pending', 'binding state restored');
});
