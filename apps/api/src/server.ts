import http from 'node:http';
import { randomUUID } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { loadEnv, type Env } from './config/env.ts';
import { buildHttpApp, buildServices, createStore, type Services } from './app.ts';
import { createLogger, type Logger } from './lib/logger.ts';
import { createStaticSite } from './http/static.ts';
import type { HttpApp } from './http/pipeline.ts';
import { FirestoreDocumentStore } from './storage/firestore/store.ts';
import { ensureIndexes } from './storage/firestore/indexes.ts';
import type { TokenProvider } from './storage/firestore/auth.ts';
import type { DocumentStore } from './storage/types.ts';

/** Hard cap on any request body read from the socket (routes enforce smaller limits). */
const MAX_SOCKET_BODY = 1024 * 1024;

export interface StartOptions {
  env: Env;
  logger?: Logger;
  /** Injected only by tests (production builds the store from env). */
  store?: DocumentStore;
  tokens?: TokenProvider | null;
  firestoreAdminBaseUrl?: string;
  telegramFetch?: typeof fetch;
}

export interface RunningServer {
  url: string;
  services: Services;
  close(): Promise<void>;
}

export function clientIp(req: http.IncomingMessage, trustProxy: boolean): string {
  if (trustProxy) {
    const xff = req.headers['x-forwarded-for'];
    const first = (Array.isArray(xff) ? xff[0] : xff)?.split(',')[0]?.trim();
    if (first) return first;
  }
  return req.socket.remoteAddress ?? '';
}

/**
 * Production server: Node's built-in HTTP server, bound to 0.0.0.0:$PORT
 * (Render injects PORT). Serves the API, /admin/ and /app/ on one origin.
 */
export async function startServer(o: StartOptions): Promise<RunningServer> {
  const env = o.env;
  const logger = o.logger ?? createLogger(env.LOG_LEVEL);
  const bundle = o.store ? { store: o.store, tokens: o.tokens ?? null } : createStore(env, logger);
  const services = buildServices({ env, logger, store: bundle.store, ...(o.telegramFetch ? { telegramFetch: o.telegramFetch } : {}) });

  // Fail fast if the database is unreachable or the credentials are wrong.
  if (bundle.store instanceof FirestoreDocumentStore) {
    try {
      await bundle.store.probe();
    } catch (e) {
      throw new Error(`Firestore is not reachable with the provided FIREBASE_SERVICE_ACCOUNT: ${e instanceof Error ? e.message : String(e)}`);
    }
  }

  const app: HttpApp = buildHttpApp(services);
  const site = createStaticSite(env.WEB_DIST_DIR ?? fileURLToPath(new URL('../../../dist/web', import.meta.url)));
  if (!site.available.admin || !site.available.app) logger.warn('web.build_missing', { ...site.available });
  const secure = env.PUBLIC_URL.startsWith('https://');

  const server = http.createServer((req, res) => {
    const pathname = (req.url ?? '/').split('?')[0] ?? '/';
    if (site.handle(req.method ?? 'GET', pathname, res, secure)) return;

    const chunks: Buffer[] = [];
    let size = 0;
    let aborted = false;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_SOCKET_BODY) {
        aborted = true;
        res.writeHead(413, { 'content-type': 'application/json' }).end('{"error":{"code":"PAYLOAD_TOO_LARGE"}}');
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => {
      if (aborted) return;
      const headers: Record<string, string> = {};
      for (const [k, v] of Object.entries(req.headers)) {
        if (typeof v === 'string') headers[k] = v;
        else if (Array.isArray(v)) headers[k] = v.join(', ');
      }
      void app
        .handle({
          method: req.method ?? 'GET',
          url: req.url ?? '/',
          headers,
          ip: clientIp(req, env.TRUST_PROXY),
          rawBody: Buffer.concat(chunks).toString('utf8'),
          requestId: (headers['x-request-id'] ?? randomUUID()).slice(0, 64),
        })
        .then((r) => {
          const outHeaders = { ...(r.headers ?? {}), ...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}) };
          res.writeHead(r.status, outHeaders);
          if (r.body === undefined) return res.end();
          if (Buffer.isBuffer(r.body)) return res.end(r.body);
          return res.end(typeof r.body === 'string' ? r.body : JSON.stringify(r.body));
        })
        .catch((e: unknown) => {
          logger.error('server.unhandled', { err: e });
          if (!res.headersSent) res.writeHead(500, { 'content-type': 'application/json' });
          res.end('{"error":{"code":"INTERNAL"}}');
        });
    });
  });
  server.requestTimeout = 30_000;
  server.headersTimeout = 20_000;
  server.keepAliveTimeout = 65_000; // above typical proxy idle timeouts

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(env.PORT, env.HOST, () => resolve());
  });
  const addr = server.address();
  const port = typeof addr === 'object' && addr ? addr.port : env.PORT;
  services.stats.start();
  logger.info('server.started', { host: env.HOST, port, storage: services.store.kind, publicUrl: env.PUBLIC_URL, env: env.NODE_ENV });

  // Background startup tasks — never block or crash the server.
  void (async () => {
    if (bundle.store instanceof FirestoreDocumentStore && bundle.tokens) {
      services.setIndexStatus(
        await ensureIndexes({
          projectId: bundle.store.projectId,
          tokens: bundle.tokens,
          logger,
          ...(o.firestoreAdminBaseUrl ? { baseUrl: o.firestoreAdminBaseUrl } : {}),
        }),
      );
    }
    const r = await services.provisioner.resyncWebhooks().catch((e: unknown) => {
      logger.error('startup.webhook_resync_failed', { err: e });
      return null;
    });
    if (r) logger.info('startup.webhook_resync', r);
  })();

  return {
    url: `http://127.0.0.1:${port}`,
    services,
    close: async () => {
      // Stop accepting, drop idle keep-alive sockets, give in-flight requests up to 3 s.
      const closed = new Promise<void>((r) => server.close(() => r()));
      server.closeIdleConnections();
      setTimeout(() => server.closeAllConnections(), 3000).unref();
      await closed;
      await services.stats.stop();
      await services.store.close();
    },
  };
}

async function main() {
  const env = loadEnv();
  const logger = createLogger(env.LOG_LEVEL);
  const running = await startServer({ env, logger });
  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    logger.info('server.stopping', { signal });
    const timer = setTimeout(() => process.exit(1), 10_000);
    timer.unref();
    await running.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e: unknown) => {
    // Configuration errors list variable names only — never values.
    process.stderr.write(`\n✖ OPEN SIGNAL AI failed to start\n${e instanceof Error ? e.message : String(e)}\n\n`);
    process.exit(1);
  });
}
