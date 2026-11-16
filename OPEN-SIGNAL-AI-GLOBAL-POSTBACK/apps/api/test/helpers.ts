import { randomBytes } from 'node:crypto';
import { DEFAULT_MARKET_SETTINGS, DEFAULT_PARTNER_SETTINGS, DEFAULT_TELEGRAM_SETTINGS, DEFAULT_THEME, MODULES, type BotConfig, type PartnerSource } from '@open-signal/shared';
import { envSchema, type Env } from '../src/config/env.ts';
import { buildHttpApp, buildServices, type Services } from '../src/app.ts';
import { nullLogger } from '../src/lib/logger.ts';
import { maskBotToken, sha256Hex } from '../src/lib/crypto.ts';
import { tokenAad } from '../src/domain/bots.ts';
import { secretAad } from '../src/binding/postback.ts';
import { C } from '../src/storage/collections.ts';
import { LocalDocumentStore } from '../src/storage/local-store.ts';
import type { DocumentStore } from '../src/storage/types.ts';
import { FirestoreDocumentStore } from '../src/storage/firestore/store.ts';
import { NoAuthTokenProvider } from '../src/storage/firestore/auth.ts';
import { startFakeFirestore, type FakeFirestore } from './fake-firestore.ts';
import type { HttpApp } from '../src/http/pipeline.ts';
import type { HttpResponse } from '../src/http/types.ts';
import { signInitDataForTests } from '../src/telegram/init-data.ts';

// Test-only values generated per run. No real secrets anywhere.
export const TEST_ENV: Env = envSchema.parse({
  NODE_ENV: 'test',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SESSION_SECRET: randomBytes(32).toString('hex'),
  CORS_ORIGINS: 'https://admin.example.test,https://app.example.test',
});

export class TestClock {
  t: number;
  constructor(iso = '2026-11-18T12:00:00.000Z') {
    this.t = Date.parse(iso);
  }
  now = () => new Date(this.t);
  advance(sec: number) {
    this.t += sec * 1000;
  }
}

export function fakeBotToken(): string {
  return `${100000 + Math.floor(Math.random() * 899999)}:${randomBytes(26).toString('base64url').slice(0, 35)}`;
}

export function botConfig(overrides: Partial<BotConfig> = {}): BotConfig {
  const modules = Object.fromEntries(MODULES.map((m) => [m, true])) as BotConfig['modules'];
  return {
    name: 'Test Bot',
    username: 'OpenSignalTestBot',
    description: { ru: 'Описание' },
    shortDescription: {},
    miniAppTitle: 'Open Signal',
    defaultLanguage: 'ru',
    theme: DEFAULT_THEME,
    avatarMediaId: null,
    logoMediaId: null,
    supportContact: '@support_test',
    modules,
    partner: { ...DEFAULT_PARTNER_SETTINGS, linkTemplate: 'https://partner.example.test/r?sub={click_id}' },
    telegram: DEFAULT_TELEGRAM_SETTINGS,
    markets: DEFAULT_MARKET_SETTINGS,
    accountBinding: {
      traderIdPattern: '^[A-Za-z0-9_-]{3,64}$',
      gatedModules: ['signals'],
      recheckCooldownSec: 30,
      supportHintAfterHours: 24,
    },
    ...overrides,
  };
}

export interface TestBot {
  botId: string;
  token: string;
  webhookSecret: string;
}

export async function seedBot(s: Services, botId: string, opts: { status?: string; config?: Partial<BotConfig> } = {}): Promise<TestBot> {
  const token = fakeBotToken();
  const webhookSecret = randomBytes(24).toString('base64url');
  const now = s.now().toISOString();
  await s.store.create(C.bots, botId, {
    id: botId,
    status: opts.status ?? 'active',
    telegramBotId: Number(token.split(':')[0]),
    tokenEnc: s.box.encrypt(token, tokenAad(botId)),
    tokenMasked: maskBotToken(token),
    webhookSecretHash: sha256Hex(webhookSecret),
    devOnly: true,
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
  });
  await s.store.create(C.botConfigs, botId, { ...botConfig(opts.config), botId, updatedAt: now });
  s.bots.invalidate(botId);
  return { botId, token, webhookSecret };
}

export async function seedSource(
  s: Services,
  botId: string,
  sourceId: string,
  auth: 'shared_secret' | 'hmac_sha256' = 'shared_secret',
): Promise<{ sourceId: string; secret: string }> {
  const secret = randomBytes(24).toString('hex');
  const secretEnc = s.box.encrypt(secret, secretAad(sourceId));
  const source: PartnerSource = {
    id: sourceId,
    botId,
    name: 'Test partner',
    enabled: true,
    auth:
      auth === 'shared_secret'
        ? { method: 'shared_secret', location: 'query', name: 'token', secretEnc }
        : { method: 'hmac_sha256', signatureHeader: 'x-signature', secretEnc },
    ipAllowlist: [],
    mapping: { eventId: 'event_id', eventType: 'event', traderId: 'trader_id', clickId: 'sub_id', occurredAt: 'ts', amount: 'amount', currency: 'currency', partnerId: null },
    eventTypeMap: { reg: 'registration', ftd: 'ftd', dep: 'deposit' },
  };
  await s.store.create(C.partnerSources, sourceId, source as unknown as Record<string, unknown>);
  return { sourceId, secret };
}

/**
 * OS_TEST_STORE=firestore runs the whole suite through the Firestore REST adapter
 * against the Firestore REST test double instead of the local adapter.
 */
let fake: FakeFirestore | null = null;
if (process.env['OS_TEST_STORE'] === 'firestore') {
  fake = await startFakeFirestore();
  process.on('exit', () => void fake?.close());
}

export function defaultStore(): DocumentStore {
  if (fake) {
    // a fresh project per harness keeps tests isolated
    return new FirestoreDocumentStore({ projectId: `p${randomBytes(4).toString('hex')}`, tokens: new NoAuthTokenProvider(), baseUrl: fake.url });
  }
  return new LocalDocumentStore(null);
}

export interface Harness {
  s: Services;
  app: HttpApp;
  clock: TestClock;
  store: DocumentStore;
  request(method: string, url: string, opts?: { body?: unknown; headers?: Record<string, string>; ip?: string; raw?: string }): Promise<HttpResponse & { json: any }>;
  login(bot: TestBot, tgId: number, extra?: Record<string, unknown>): Promise<{ token: string; body: any }>;
}

export const ADMIN_SETUP_TOKEN = randomBytes(24).toString('base64url');
export const PROD_LIKE_ENV: Env = envSchema.parse({
  NODE_ENV: 'test',
  ENCRYPTION_KEY: randomBytes(32).toString('base64'),
  SESSION_SECRET: randomBytes(32).toString('hex'),
  ADMIN_SETUP_TOKEN,
  PUBLIC_URL: 'https://os.example.test',
  TELEGRAM_API_BASE: 'https://tg.example.test',
});

export function harness(
  store: DocumentStore = defaultStore(),
  clock = new TestClock(),
  opts: { env?: Env; telegramFetch?: typeof fetch } = {},
): Harness {
  const s = buildServices({ env: opts.env ?? TEST_ENV, logger: nullLogger, store, now: clock.now, ...(opts.telegramFetch ? { telegramFetch: opts.telegramFetch } : {}) });
  const app = buildHttpApp(s);
  let n = 0;
  const h: Harness = {
    s,
    app,
    clock,
    store,
    async request(method, url, opts = {}) {
      const raw = opts.raw ?? (opts.body === undefined ? '' : JSON.stringify(opts.body));
      const res = await app.handle({
        method,
        url,
        headers: { 'content-type': 'application/json', ...(opts.headers ?? {}) },
        ip: opts.ip ?? '203.0.113.10',
        rawBody: raw,
        requestId: `t-${++n}`,
      });
      return { ...res, json: res.body as any };
    },
    async login(bot, tgId, extra = {}) {
      const initData = signInitDataForTests(bot.token, {
        auth_date: String(Math.floor(clock.t / 1000)),
        query_id: `Q${tgId}`,
        user: JSON.stringify({ id: tgId, first_name: `User${tgId}`, username: `u${tgId}`, language_code: 'uk', ...extra }),
      });
      const res = await h.request('POST', `/api/miniapp/${bot.botId}/session`, { body: { initData }, ip: `198.51.100.${tgId % 250}` });
      if (res.status !== 200) throw new Error(`login failed: ${res.status} ${JSON.stringify(res.body)}`);
      return { token: res.json.session.token as string, body: res.json };
    },
  };
  return h;
}

export const bearer = (token: string) => ({ authorization: `Bearer ${token}` });
