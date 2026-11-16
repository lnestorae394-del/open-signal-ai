import { corsOrigins, type Env } from './config/env.ts';
import { createSecretBox, parseKey, type KeyringEntry, type SecretBox } from './lib/crypto.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { SessionService } from './auth/session.ts';
import { BindingService } from './binding/service.ts';
import { BotRepository } from './domain/bots.ts';
import { ErrorLog, StatsBuffer } from './domain/observability.ts';
import { UserService } from './domain/users.ts';
import { createHttpApp, type HttpApp } from './http/pipeline.ts';
import { buildRoutes } from './http/routes.ts';
import { createFirestoreStore } from './storage/firestore-store.ts';
import { LocalDocumentStore } from './storage/local-store.ts';
import type { DocumentStore } from './storage/types.ts';
import { RecordingUpdateHandler, WebhookService, type UpdateHandler } from './telegram/webhook.ts';

export interface Services {
  env: Env;
  logger: Logger;
  store: DocumentStore;
  box: SecretBox;
  bots: BotRepository;
  users: UserService;
  sessions: SessionService;
  binding: BindingService;
  webhooks: WebhookService;
  stats: StatsBuffer;
  errors: ErrorLog;
  now: () => Date;
}

export interface BuildOptions {
  env: Env;
  logger?: Logger;
  store?: DocumentStore;
  now?: () => Date;
  updateHandler?: UpdateHandler;
}

export function createStore(env: Env): DocumentStore {
  if (env.STORAGE_DRIVER === 'firestore') return createFirestoreStore(env.FIREBASE_PROJECT_ID ?? '');
  return new LocalDocumentStore(env.LOCAL_DATA_FILE);
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
  const store = opts.store ?? createStore(env);
  const now = opts.now ?? (() => new Date());
  const box = createSecretBoxFromEnv(env);
  const bots = new BotRepository(store, box);
  const stats = new StatsBuffer(store, logger);
  const errors = new ErrorLog(store, logger);
  const binding = new BindingService({ store, bots, box, logger, stats, errors, now });
  const webhooks = new WebhookService(bots, store, opts.updateHandler ?? new RecordingUpdateHandler(stats), logger);
  return {
    env,
    logger,
    store,
    box,
    bots,
    users: new UserService(store),
    sessions: new SessionService(env.SESSION_SECRET, env.SESSION_TTL_SEC),
    binding,
    webhooks,
    stats,
    errors,
    now,
  };
}

export function buildHttpApp(services: Services): HttpApp {
  return createHttpApp({
    routes: buildRoutes(services),
    logger: services.logger,
    corsOrigins: corsOrigins(services.env),
    errorLog: services.errors,
  });
}
