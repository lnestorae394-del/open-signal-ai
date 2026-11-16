import { AppError, isAppError } from '../lib/errors.ts';
import type { Logger } from '../lib/logger.ts';
import { RATE_LIMITS, TokenBucketLimiter } from '../lib/rate-limit.ts';
import type { ErrorLog } from '../domain/observability.ts';
import type { HttpRequest, HttpResponse, Route, RouteContext } from './types.ts';

export const MAX_BODY_BYTES = 64 * 1024;

const SECURITY_HEADERS: Record<string, string> = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'no-referrer',
  'x-frame-options': 'DENY',
  'cross-origin-resource-policy': 'same-site',
  'cache-control': 'no-store',
};

interface CompiledRoute {
  route: Route;
  regex: RegExp;
  keys: string[];
}

function compile(route: Route): CompiledRoute {
  const keys: string[] = [];
  const pattern = route.path.replace(/:([A-Za-z]+)/g, (_m, k: string) => {
    keys.push(k);
    return '([^/]+)';
  });
  return { route, regex: new RegExp(`^${pattern}$`), keys };
}

export interface HttpAppOptions {
  routes: Route[];
  logger: Logger;
  corsOrigins: string[];
  errorLog?: ErrorLog;
  limiter?: TokenBucketLimiter;
}

export interface HttpApp {
  handle(req: HttpRequest): Promise<HttpResponse>;
}

/**
 * The request pipeline shared by every transport:
 * security headers → CORS → body limit → routing → rate limit → handler → error mapping → access log.
 */
export function createHttpApp(opts: HttpAppOptions): HttpApp {
  const compiled = opts.routes.map(compile);
  const limiter = opts.limiter ?? new TokenBucketLimiter();
  const allowed = new Set(opts.corsOrigins);

  return {
    async handle(req) {
      const started = performance.now();
      const url = new URL(req.url, 'http://internal');
      const headers: Record<string, string> = { ...SECURITY_HEADERS };
      const origin = req.headers['origin'];
      if (origin && allowed.has(origin)) {
        headers['access-control-allow-origin'] = origin;
        headers['vary'] = 'Origin';
        headers['access-control-allow-headers'] = 'authorization, content-type';
        headers['access-control-allow-methods'] = 'GET, POST, PUT, DELETE, OPTIONS';
        headers['access-control-max-age'] = '600';
      }

      let res: HttpResponse;
      let botId: string | undefined;
      try {
        if (req.method === 'OPTIONS') {
          res = { status: 204 };
        } else {
          const match = findRoute(compiled, req.method, url.pathname);
          if (!match) throw new AppError('NOT_FOUND', 'route not found');
          if (Buffer.byteLength(req.rawBody) > (match.route.maxBody ?? MAX_BODY_BYTES)) throw new AppError('PAYLOAD_TOO_LARGE');
          botId = match.params['botId'];
          if (match.route.rateLimit) {
            const tenant = match.params['botId'] ?? match.params['sourceId'] ?? '-';
            const r = limiter.take(`${match.route.rateLimit}:${tenant}:${req.ip}`, RATE_LIMITS[match.route.rateLimit]);
            if (!r.allowed) {
              headers['retry-after'] = String(r.retryAfterSec);
              throw new AppError('RATE_LIMITED');
            }
          }
          const ctx: RouteContext = {
            req,
            params: match.params,
            query: url.searchParams,
            rawQuery: url.search.startsWith('?') ? url.search.slice(1) : url.search,
            json: () => {
              if (!req.rawBody) return {};
              try {
                return JSON.parse(req.rawBody) as unknown;
              } catch {
                throw new AppError('BAD_REQUEST', 'invalid JSON body');
              }
            },
            bearer: () => {
              const h = req.headers['authorization'];
              return h?.startsWith('Bearer ') ? h.slice(7).trim() : null;
            },
          };
          res = await match.route.handler(ctx);
        }
      } catch (e) {
        if (isAppError(e)) {
          const fields = e.code === 'VALIDATION_FAILED' ? e.details?.['fields'] : undefined;
          const retryAfterSec = typeof e.details?.['retryAfterSec'] === 'number' ? (e.details['retryAfterSec'] as number) : undefined;
          res = {
            status: e.status,
            body: { error: { code: e.code, ...(e.code === 'VALIDATION_FAILED' ? { message: e.message } : {}), ...(fields ? { fields } : {}), ...(retryAfterSec ? { retryAfterSec } : {}) } },
            ...(retryAfterSec ? { headers: { 'retry-after': String(retryAfterSec) } } : {}),
          };
          if (e.status >= 500) opts.logger.error('request.app_error', { requestId: req.requestId, code: e.code, err: e });
        } else {
          opts.logger.error('request.unhandled', { requestId: req.requestId, path: url.pathname, err: e });
          await opts.errorLog?.record(botId ?? null, 'http', 'INTERNAL', e instanceof Error ? e.message : String(e));
          res = { status: 500, body: { error: { code: 'INTERNAL' } } };
        }
      }

      if (res.body !== undefined && typeof res.body !== 'string') headers['content-type'] = 'application/json; charset=utf-8';
      // Path only: query strings may carry partner secrets and are never logged.
      opts.logger.info('request', {
        requestId: req.requestId,
        method: req.method,
        path: url.pathname,
        status: res.status,
        ms: Math.round(performance.now() - started),
      });
      return { ...res, headers: { ...headers, ...res.headers } };
    },
  };
}

function findRoute(routes: CompiledRoute[], method: string, path: string): { route: Route; params: Record<string, string> } | null {
  for (const c of routes) {
    if (c.route.method !== method) continue;
    const m = c.regex.exec(path);
    if (!m) continue;
    const params: Record<string, string> = {};
    c.keys.forEach((k, i) => (params[k] = decodeURIComponent(m[i + 1]!)));
    return { route: c.route, params };
  }
  return null;
}
