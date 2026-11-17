import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';
import http from 'node:http';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { DEFAULT_THEME, MODULES } from '@open-signal/shared';
import { loadEnv } from '../src/config/env.ts';
import { startServer, clientIp } from '../src/server.ts';
import { FirestoreDocumentStore } from '../src/storage/firestore/store.ts';
import { NoAuthTokenProvider } from '../src/storage/firestore/auth.ts';
import { nullLogger } from '../src/lib/logger.ts';
import { signInitDataForTests } from '../src/telegram/init-data.ts';
import { startFakeFirestore } from './fake-firestore.ts';
import { fakeTelegram } from './fake-telegram.ts';
import { fakeBotToken } from './helpers.ts';

/**
 * Production-mode end-to-end: the real HTTP server (NODE_ENV=production, env
 * exactly as on Render) over a socket, Firestore REST adapter, built web apps,
 * then a full restart on the same database.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Json = Record<string, any>;
const json = async (r: Response): Promise<Json> => (await r.json()) as Json;

const WEB_DIST = fileURLToPath(new URL('../../../dist/web', import.meta.url));
const fake = await startFakeFirestore();
after(() => fake.close());

const { privateKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
const SA = JSON.stringify({
  type: 'service_account',
  project_id: 'open-signal-prod-test',
  client_email: 'svc@open-signal-prod-test.iam.gserviceaccount.com',
  private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString(),
});
const SETUP = randomBytes(32).toString('base64');
const env = loadEnv({
  NODE_ENV: 'production',
  PORT: String(20000 + Math.floor(Math.random() * 20000)),
  HOST: '127.0.0.1',
  RENDER_EXTERNAL_URL: 'https://open-signal.example.test',
  FIREBASE_SERVICE_ACCOUNT: Buffer.from(SA).toString('base64'),
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SESSION_SECRET: randomBytes(32).toString('base64'),
  ADMIN_SETUP_TOKEN: SETUP,
  TELEGRAM_API_BASE: 'https://tg.example.test',
  WEB_DIST_DIR: WEB_DIST,
  LOG_LEVEL: 'error',
});
const tg = fakeTelegram();
const start = () =>
  startServer({
    env,
    logger: nullLogger,
    store: new FirestoreDocumentStore({ projectId: 'open-signal-prod-test', tokens: new NoAuthTokenProvider(), baseUrl: fake.url }),
    tokens: new NoAuthTokenProvider(),
    firestoreAdminBaseUrl: fake.url,
    telegramFetch: tg.fetch,
  });

test('production server: env, static apps, security headers, full flow, restart persistence', async () => {
  assert.ok(existsSync(`${WEB_DIST}/admin/index.html`), 'run "npm run build" first');
  assert.equal(env.STORAGE_DRIVER, 'firestore');
  assert.equal(env.TRUST_PROXY, true);

  let srv = await start();
  after(() => srv.close().catch(() => undefined));
  const base = srv.url;
  const get = (p: string, init?: RequestInit) => fetch(base + p, { redirect: 'manual', ...init });

  // health
  const health = await json(await get('/health'));
  assert.equal(health.status, 'ok');
  assert.equal(health.persistentStorage, true);

  // static apps + headers
  const root = await get('/');
  assert.equal(root.status, 302);
  assert.equal(root.headers.get('location'), '/admin/');
  const admin = await get('/admin/');
  assert.equal(admin.status, 200);
  assert.match(admin.headers.get('content-security-policy')!, /frame-ancestors 'none'/);
  assert.equal(admin.headers.get('x-frame-options'), 'DENY');
  assert.match(admin.headers.get('strict-transport-security')!, /max-age=/);
  const html = await admin.text();
  const asset = /src="(\/admin\/assets\/app-[a-f0-9]+\.js)"/.exec(html)![1]!;
  const js = await get(asset);
  assert.equal(js.status, 200);
  assert.match(js.headers.get('cache-control')!, /immutable/);
  const app = await get('/app/?bot=x');
  assert.match(app.headers.get('content-security-policy')!, /frame-ancestors 'self' https:\/\/web\.telegram\.org/);
  assert.equal(app.headers.get('x-frame-options'), null, 'Telegram Web must be able to embed the Mini App');
  assert.match(await app.text(), /telegram-web-app\.js/);
  // Path traversal attempts never escape dist/web (raw request path, no client-side normalisation).
  for (const raw of ['/admin/..%2f..%2f..%2fpackage.json', '/app/..%2f..%2fapps%2fapi%2fsrc%2fserver.ts']) {
    const status = await new Promise<number>((resolve) => {
      const r = http.request(base + raw, { method: 'GET' }, (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      });
      r.end();
    });
    assert.equal(status, 400, raw);
  }

  // owner setup → bot → Mini App session, all over the socket
  const setup = await get('/api/admin/setup', { method: 'POST', headers: { 'content-type': 'application/json', 'x-os-admin': '1' }, body: JSON.stringify({ setupToken: SETUP, email: 'owner@example.com', password: 'a-strong-password' }) });
  assert.equal(setup.status, 201);
  const cookie = setup.headers.get('set-cookie')!.split(';')[0]!;
  assert.match(setup.headers.get('set-cookie')!, /Secure/);
  const token = fakeBotToken();
  tg.addBot(token, 424242, 'ProdTestBot');
  const created = await get('/api/admin/bots', {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-os-admin': '1', cookie },
    body: JSON.stringify({
      token, name: 'Prod', description: {}, shortDescription: {}, miniAppTitle: 'PROD', defaultLanguage: 'en', theme: DEFAULT_THEME, supportContact: '',
      modules: Object.fromEntries(MODULES.map((m) => [m, true])),
      accountBinding: { traderIdPattern: '^[A-Za-z0-9_-]{3,64}$', gatedModules: ['signals'], partnerLinkTemplate: null, recheckCooldownSec: 30, supportHintAfterHours: 24 },
    }),
  });
  assert.equal(created.status, 201, await created.clone().text());
  const bot = (await json(created))['bot'];
  assert.equal(bot.telegram.webhookUrl, `https://open-signal.example.test/tg/webhook/${bot.botId}`);
  assert.equal(bot.miniAppUrl, `https://open-signal.example.test/app/?bot=${bot.botId}`);
  const initData = signInitDataForTests(token, { auth_date: String(Math.floor(Date.now() / 1000)), user: JSON.stringify({ id: 99, first_name: 'Neo' }) });
  const session = await get(`/api/miniapp/${bot.botId}/session`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-forwarded-for': '203.0.113.5' }, body: JSON.stringify({ initData }) });
  assert.equal(session.status, 200);
  const miniToken = (await json(session))['session'].token;

  // indexes were provisioned in the background through the Admin API
  for (let i = 0; i < 400 && !('total' in (srv.services.indexStatus() as object)); i++) await new Promise((r) => setTimeout(r, 25));
  const ix = srv.services.indexStatus() as { total: number; error: string | null };
  assert.equal(ix.error, null);
  assert.ok(ix.total > 10);

  // ── restart on the same database ──
  await srv.close();
  srv = await start();
  const b2 = srv.url;
  const me = await fetch(`${b2}/api/miniapp/${bot.botId}/me`, { headers: { authorization: `Bearer ${miniToken}` } });
  assert.equal(me.status, 200, 'Mini App session survives a restart');
  assert.equal((await json(me))['user'].telegramId, 99);
  const bots = await fetch(`${b2}/api/admin/bots`, { headers: { cookie } });
  assert.equal(bots.status, 200, 'admin session survives a restart');
  assert.equal((await json(bots))['bots'][0].usersCount, 1);
  const pub = await json(await fetch(`${b2}/api/public/bots/${bot.botId}/config`));
  assert.equal(pub.name, 'Prod');
  await srv.close();
});

test('client IP: X-Forwarded-For is used only when the proxy is trusted', () => {
  const req = { headers: { 'x-forwarded-for': '198.51.100.7, 10.0.0.1' }, socket: { remoteAddress: '10.0.0.2' } } as never;
  assert.equal(clientIp(req, true), '198.51.100.7');
  assert.equal(clientIp(req, false), '10.0.0.2');
});

test('startup fails loudly when Firestore credentials do not work', async () => {
  const badStore = new FirestoreDocumentStore({
    projectId: 'x',
    tokens: new NoAuthTokenProvider(),
    baseUrl: 'http://127.0.0.1:1',
  });
  await assert.rejects(startServer({ env, logger: nullLogger, store: badStore, tokens: null }), /Firestore is not reachable/);
});
