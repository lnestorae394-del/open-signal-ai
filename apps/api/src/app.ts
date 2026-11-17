import { corsOrigins, miniAppUrl, type Env } from './config/env.ts';
import { createSecretBox, parseKey, type KeyringEntry, type SecretBox } from './lib/crypto.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { SessionService } from './auth/session.ts';
import { BindingService } from './binding/service.ts';
import { BotRepository } from './domain/bots.ts';
import { ErrorLog, StatsBuffer } from './domain/observability.ts';
import { UserService } from './domain/users.ts';
import { AdminAuthService } from './admin/auth.ts';
import { BotAdminService } from './admin/bots-admin.ts';
import { AdminInsights } from './admin/insights.ts';
import { createHttpApp, type HttpApp } from './http/pipeline.ts';
import { buildRoutes } from './http/routes.ts';
import { buildAdminRoutes, buildMediaRoute } from './http/admin-routes.ts';
import { LocalDocumentStore } from './storage/local-store.ts';
import { FirestoreDocumentStore } from './storage/firestore/store.ts';
import { ServiceAccountTokenProvider, parseServiceAccount, type TokenProvider } from './storage/firestore/auth.ts';
import type { IndexStatus } from './storage/firestore/indexes.ts';
import type { DocumentStore } from './storage/types.ts';
import { TelegramBotApi } from './telegram/bot-api.ts';
import { TelegramProvisioner } from './telegram/provisioning.ts';
import { BotUpdateHandler, WebhookService, type UpdateHandler } from './telegram/webhook.ts';
import { C } from './storage/collections.ts';
import { OnboardingService } from './binding/onboarding.ts';
import { PlatformSettings } from './platform/settings.ts';
import { SignalService } from './signals/service.ts';
import { TrainingSignalEngine, type SignalEngine } from './signals/engine.ts';
import { AcademyService } from './academy/service.ts';

export interface Services {
  env: Env;
  logger: Logger;
  store: DocumentStore;
  box: SecretBox;
  bots: BotRepository;
  users: UserService;
  /** Platform-wide settings (one signal system for every bot). */
  platform: PlatformSettings;
  signals: SignalService;
  academy: AcademyService;
  onboarding: OnboardingService;
  sessions: SessionService;
  binding: BindingService;
  webhooks: WebhookService;
  stats: StatsBuffer;
  errors: ErrorLog;
  telegram: TelegramBotApi;
  provisioner: TelegramProvisioner;
  adminAuth: AdminAuthService;
  botAdmin: BotAdminService;
  insights: AdminInsights;
  indexStatus(): IndexStatus | { state: 'not_applicable' | 'pending' };
  setIndexStatus(s: IndexStatus): void;
  now: () => Date;
}

export interface BuildOptions {
  env: Env;
  /** Replaces the signal engine (tests, or a future verified analysis engine). */
  signalEngine?: SignalEngine;
  logger?: Logger;
  store?: DocumentStore;
  now?: () => Date;
  updateHandler?: UpdateHandler;
  telegramFetch?: typeof fetch;
}

export interface StoreBundle {
  store: DocumentStore;
  tokens: TokenProvider | null;
  projectId: string | null;
}

/** Production: Firestore (persistent). Development/tests: local JSON file. */
export function createStore(env: Env, logger?: Logger): StoreBundle {
  if (env.STORAGE_DRIVER === 'firestore') {
    const sa = parseServiceAccount(env.FIREBASE_SERVICE_ACCOUNT ?? '');
    const tokens = new ServiceAccountTokenProvider(sa);
    return { store: new FirestoreDocumentStore({ projectId: sa.project_id, tokens, ...(logger ? { logger } : {}) }), tokens, projectId: sa.project_id };
  }
  return { store: new LocalDocumentStore(env.LOCAL_DATA_FILE), tokens: null, projectId: null };
}

export function createSecretBoxFromEnv(env: Env): SecretBox {
  const previous: KeyringEntry[] = [];
  if (env.ENCRYPTION_KEY_PREVIOUS) {
    const idx = env.ENCRYPTION_KEY_PREVIOUS.indexOf(':');
    previous.push({ id: env.ENCRYPTION_KEY_PREVIOUS.slice(0, idx), key: parseKey(env.ENCRYPTION_KEY_PREVIOUS.slice(idx + 1)) });
  }
  return createSecretBox({ id: env.ENCRYPTION_KEY_ID, key: parseKey(env.ENCRYPTION_KEY) }, previous);
}

/** Composition root: one set of services serves every bot (multi-tenant). */
export function buildServices(opts: BuildOptions): Services {
  const env = opts.env;
  const logger = opts.logger ?? createLogger(env.LOG_LEVEL);
  const store = opts.store ?? createStore(env, logger).store;
  const now = opts.now ?? (() => new Date());
  const box = createSecretBoxFromEnv(env);
  const bots = new BotRepository(store, box);
  const stats = new StatsBuffer(store, logger, now);
  const errors = new ErrorLog(store, logger);
  const telegram = new TelegramBotApi(env.TELEGRAM_API_BASE, opts.telegramFetch ?? fetch);
  // Read lazily: the platform settings service is created further down.
  let platformRef: PlatformSettings | null = null;
  const binding = new BindingService({ store, bots, box, logger, stats, errors, now, clicklessRegistration: async () => (platformRef ? (await platformRef.signals()).allowClicklessRegistration : true) });
  const users = new UserService(store);
  const handler =
    opts.updateHandler ??
    new BotUpdateHandler({
      stats,
      api: telegram,
      bots,
      appUrl: (id) => miniAppUrl(env, id),
      savedLanguage: async (botId, tgId) => (await store.get<{ language: string | null }>(C.userSettings, `${botId}_${tgId}`))?.language ?? null,
    });
  const platform = new PlatformSettings({ store, now });
  platformRef = platform;
  // Training engine until a verified market data source and a validated model exist.
  const engine: SignalEngine = opts.signalEngine ?? new TrainingSignalEngine();
  const webhooks = new WebhookService(bots, store, handler, logger);
  const provisioner = new TelegramProvisioner({ api: telegram, store, bots, box, env, logger });
  let indexState: IndexStatus | { state: 'not_applicable' | 'pending' } = { state: store.kind === 'firestore' ? 'pending' : 'not_applicable' };
  return {
    env,
    logger,
    store,
    box,
    bots,
    users,
    platform,
    signals: new SignalService({ store, settings: platform, engine, stats, now }),
    academy: new AcademyService({ store, now }),
    onboarding: new OnboardingService({ store, now }),
    sessions: new SessionService(env.SESSION_SECRET, env.SESSION_TTL_SEC),
    binding,
    webhooks,
    stats,
    errors,
    telegram,
    provisioner,
    adminAuth: new AdminAuthService({ store, setupToken: env.ADMIN_SETUP_TOKEN, sessionTtlSec: env.ADMIN_SESSION_TTL_SEC, now }),
    botAdmin: new BotAdminService({ store, bots, box, api: telegram, provisioner, env, logger, now }),
    insights: new AdminInsights({ store, box, env, now, platform }),
    indexStatus: () => indexState,
    setIndexStatus: (s) => (indexState = s),
    now,
  };
}

export function buildHttpApp(services: Services): HttpApp {
  return createHttpApp({
    routes: [...buildRoutes(services), ...buildAdminRoutes(services), buildMediaRoute(services)],
    logger: services.logger,
    corsOrigins: corsOrigins(services.env),
    errorLog: services.errors,
  });
}
