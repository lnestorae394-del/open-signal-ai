import { loadEnv } from './config/env.ts';
import { buildHttpApp, buildServices } from './app.ts';
import { startFastify } from './http/fastify-adapter.ts';

/**
 * Entry point: `node src/server.ts` (Node ≥ 22.18 runs TypeScript natively by
 * stripping types; no build step).
 */
async function main() {
  const env = loadEnv();
  const services = buildServices({ env });
  services.stats.start();
  const app = buildHttpApp(services);
  const server = await startFastify(app, { host: env.HOST, port: env.PORT, trustProxy: env.TRUST_PROXY });
  services.logger.info('server.started', {
    port: env.PORT,
    storage: services.store.kind,
    env: env.NODE_ENV,
  });

  let stopping = false;
  const shutdown = async (signal: string) => {
    if (stopping) return;
    stopping = true;
    services.logger.info('server.stopping', { signal });
    await server.close();
    await services.stats.stop();
    await services.store.close();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));
}

main().catch((e: unknown) => {
  // Configuration errors list variable names only — never values.
  process.stderr.write(`${e instanceof Error ? e.message : String(e)}\n`);
  process.exit(1);
});
