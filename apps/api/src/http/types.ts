import type { RateLimitBucket } from '../lib/rate-limit.ts';

/** Framework-neutral request. Fastify (production) and tests both produce this shape. */
export interface HttpRequest {
  method: string;
  /** Path + query, e.g. "/postback/src-1?event=reg". */
  url: string;
  /** Lower-cased header names. */
  headers: Record<string, string>;
  ip: string;
  rawBody: string;
  requestId: string;
}

export interface HttpResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface RouteContext {
  req: HttpRequest;
  params: Record<string, string>;
  query: URLSearchParams;
  rawQuery: string;
  /** Parses the JSON body (400 on invalid JSON). */
  json(): unknown;
  bearer(): string | null;
}

export interface Route {
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  /** Path pattern with ":name" params, e.g. "/tg/webhook/:botId". */
  path: string;
  rateLimit?: RateLimitBucket;
  /** Maximum request body in bytes (default 64 KB). */
  maxBody?: number;
  handler(ctx: RouteContext): Promise<HttpResponse>;
}
