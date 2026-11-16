import { createReadStream, existsSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';
import type { ServerResponse } from 'node:http';

/**
 * Serves the built Admin panel (/admin/) and Mini App (/app/) from dist/web.
 * Hashed assets are cached for a year; HTML is never cached, so a redeploy is
 * picked up immediately. Each app gets its own Content-Security-Policy.
 */
const TYPES: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.ico': 'image/x-icon',
  '.woff2': 'font/woff2',
  '.json': 'application/json; charset=utf-8',
  '.map': 'application/json; charset=utf-8',
};

const BASE = {
  'x-content-type-options': 'nosniff',
  'referrer-policy': 'strict-origin-when-cross-origin',
  'permissions-policy': 'camera=(), microphone=(), geolocation=()',
};

const CSP_ADMIN = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'none'",
  "base-uri 'none'",
  "form-action 'self'",
].join('; ');

// Telegram Web opens Mini Apps in an iframe; the official script comes from telegram.org.
const CSP_APP = [
  "default-src 'self'",
  "script-src 'self' https://telegram.org",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob: https://t.me https://*.telegram.org",
  "font-src 'self'",
  "connect-src 'self'",
  "frame-ancestors 'self' https://web.telegram.org https://*.telegram.org",
  "base-uri 'none'",
].join('; ');

export interface StaticSite {
  /** Returns true if the request was handled. */
  handle(method: string, pathname: string, res: ServerResponse, secure: boolean): boolean;
  available: { admin: boolean; app: boolean };
}

export function createStaticSite(distDir: string): StaticSite {
  const root = resolve(distDir);
  const apps = { admin: join(root, 'admin'), app: join(root, 'app') } as const;
  const available = { admin: existsSync(join(apps.admin, 'index.html')), app: existsSync(join(apps.app, 'index.html')) };

  const send = (res: ServerResponse, file: string, headers: Record<string, string>, method: string) => {
    const type = TYPES[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { ...headers, 'content-type': type, 'content-length': String(statSync(file).size) });
    if (method === 'HEAD') return void res.end();
    createReadStream(file).pipe(res);
  };

  return {
    available,
    handle(method, pathname, res, secure) {
      if (method !== 'GET' && method !== 'HEAD') return false;
      if (pathname === '/' || pathname === '/admin' || pathname === '/app') {
        res.writeHead(302, { location: pathname === '/app' ? '/app/' : '/admin/', 'cache-control': 'no-store' }).end();
        return true;
      }
      const which = pathname.startsWith('/admin/') ? 'admin' : pathname.startsWith('/app/') ? 'app' : null;
      if (!which) return false;
      const base = apps[which];
      const rel = decodeURIComponent(pathname.slice(which === 'admin' ? 7 : 5));
      const target = normalize(join(base, rel));
      if (target !== base && !target.startsWith(base + sep)) {
        res.writeHead(400).end();
        return true;
      }
      const headers: Record<string, string> = {
        ...BASE,
        'content-security-policy': which === 'admin' ? CSP_ADMIN : CSP_APP,
        ...(which === 'admin' ? { 'x-frame-options': 'DENY' } : {}),
        ...(secure ? { 'strict-transport-security': 'max-age=31536000; includeSubDomains' } : {}),
      };
      const isAsset = rel.startsWith('assets/');
      if (rel && existsSync(target) && statSync(target).isFile()) {
        send(res, target, { ...headers, 'cache-control': isAsset ? 'public, max-age=31536000, immutable' : 'no-cache' }, method);
        return true;
      }
      if (isAsset) {
        res.writeHead(404, { ...headers, 'content-type': 'text/plain' }).end('Not found');
        return true;
      }
      const index = join(base, 'index.html');
      if (!existsSync(index)) {
        res.writeHead(503, { 'content-type': 'text/plain; charset=utf-8' }).end('Web build is missing: run "npm run build".');
        return true;
      }
      send(res, index, { ...headers, 'cache-control': 'no-cache' }, method); // SPA fallback
      return true;
    },
  };
}
