import { traderIdInputSchema } from '@open-signal/shared';
import { AppError } from '../lib/errors.ts';
import type { Services } from '../app.ts';
import { TenantScope } from '../domain/tenant.ts';
import { accessMap } from '../binding/access.ts';
import { validateInitData } from '../telegram/init-data.ts';
import { SECRET_HEADER } from '../telegram/webhook.ts';
import type { BindingResult } from '../binding/service.ts';
import type { HttpResponse, Route, RouteContext } from './types.ts';

const ok = (body: unknown, status = 200): HttpResponse => ({ status, body });

function scopeOf(ctx: RouteContext): TenantScope {
  try {
    return new TenantScope(ctx.params['botId'] ?? '');
  } catch {
    throw new AppError('NOT_FOUND');
  }
}

function bindingResponse(r: BindingResult): HttpResponse {
  if (r.error) {
    const status = r.error === 'RECHECK_TOO_SOON' ? 429 : 409;
    return {
      status,
      body: { error: { code: r.error, retryAfterSec: r.retryAfterSec }, binding: r.view },
      ...(r.retryAfterSec ? { headers: { 'retry-after': String(r.retryAfterSec) } } : {}),
    };
  }
  return ok({ binding: r.view });
}

export function buildRoutes(s: Services): Route[] {
  /** Resolves the active bot + verified session for Mini App routes. */
  const authed = async (ctx: RouteContext) => {
    const scope = scopeOf(ctx);
    const bundle = await s.bots.requireActive(scope.botId);
    const session = s.sessions.verify(ctx.bearer(), scope.botId, s.now());
    const user = await s.users.get(scope, session.tgId);
    return { scope, bundle, user };
  };

  return [
    {
      method: 'GET',
      path: '/health',
      handler: async () =>
        ok({
          status: 'ok',
          time: s.now().toISOString(),
          storage: s.store.kind,
          firebaseConnected: false,
          telegramConnected: false,
          marketDataConnected: false,
        }),
    },

    {
      method: 'GET',
      path: '/api/public/bots/:botId/config',
      rateLimit: 'public',
      handler: async (ctx) => {
        const scope = scopeOf(ctx);
        const bundle = await s.bots.require(scope.botId);
        return ok(s.bots.toPublicConfig(bundle));
      },
    },

    {
      // Telegram-only sign-in: initData → verified Telegram ID → profile (created on first launch) → session.
      method: 'POST',
      path: '/api/miniapp/:botId/session',
      rateLimit: 'session',
      handler: async (ctx) => {
        const scope = scopeOf(ctx);
        const bundle = await s.bots.requireActive(scope.botId);
        const body = ctx.json() as { initData?: unknown };
        if (typeof body.initData !== 'string') throw new AppError('INIT_DATA_INVALID');
        const token = s.bots.decryptToken(bundle);
        const verified = validateInitData(body.initData, token, { maxAgeSec: s.env.INIT_DATA_MAX_AGE_SEC, now: s.now() });
        const { user: created, created: isNew } = await s.users.upsertFromTelegram(scope, verified.user, s.now());
        const user = await s.binding.ensureInitialState(scope, bundle.config, created);
        const settings = await s.users.getSettings(scope, user.telegramId);
        const session = s.sessions.issue(scope.botId, user.telegramId, s.now());
        s.stats.incr(scope.botId, 'miniapp_launches');
        if (isNew) s.stats.incr(scope.botId, 'users_new');
        return ok({
          session,
          user: profileView(user),
          settings: { language: settings.language, favorites: settings.favorites, analysisMode: settings.analysisMode },
          binding: s.binding.view(user, bundle.config),
          access: accessMap(bundle.config, user.bindingState),
        });
      },
    },

    {
      method: 'GET',
      path: '/api/miniapp/:botId/me',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { bundle, user, scope } = await authed(ctx);
        const settings = await s.users.getSettings(scope, user.telegramId);
        return ok({
          user: profileView(user),
          settings: { language: settings.language, favorites: settings.favorites, analysisMode: settings.analysisMode },
          binding: s.binding.view(user, bundle.config),
          access: accessMap(bundle.config, user.bindingState),
        });
      },
    },

    {
      method: 'PUT',
      path: '/api/miniapp/:botId/settings',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { scope, user } = await authed(ctx);
        const body = ctx.json() as Record<string, unknown>;
        const next = await s.users.updateSettings(scope, user.telegramId, body, s.now());
        return ok({ settings: { language: next.language, favorites: next.favorites, analysisMode: next.analysisMode } });
      },
    },

    {
      method: 'POST',
      path: '/api/miniapp/:botId/binding/click',
      rateLimit: 'binding',
      handler: async (ctx) => {
        const { scope, bundle, user } = await authed(ctx);
        return ok(await s.binding.issueClickId(scope, bundle.config, user.telegramId));
      },
    },

    {
      method: 'POST',
      path: '/api/miniapp/:botId/binding/trader-id',
      rateLimit: 'binding',
      handler: async (ctx) => {
        const { scope, bundle, user } = await authed(ctx);
        const parsed = traderIdInputSchema.safeParse(ctx.json());
        if (!parsed.success) throw new AppError('TRADER_ID_INVALID');
        return bindingResponse(await s.binding.submitTraderId(scope, bundle.config, user.telegramId, parsed.data.traderId));
      },
    },

    {
      method: 'POST',
      path: '/api/miniapp/:botId/binding/recheck',
      rateLimit: 'binding',
      handler: async (ctx) => {
        const { scope, bundle, user } = await authed(ctx);
        return bindingResponse(await s.binding.recheck(scope, bundle.config, user.telegramId));
      },
    },

    {
      method: 'POST',
      path: '/tg/webhook/:botId',
      rateLimit: 'webhook',
      handler: async (ctx) => {
        const scope = scopeOf(ctx);
        const r = await s.webhooks.receive(scope.botId, ctx.req.headers[SECRET_HEADER], ctx.req.rawBody, s.now());
        return ok(r.body, r.status);
      },
    },

    ...(['GET', 'POST'] as const).map(
      (method): Route => ({
        method,
        path: '/postback/:sourceId',
        rateLimit: 'postback',
        handler: async (ctx) => {
          const r = await s.binding.processPostback(ctx.params['sourceId'] ?? '', {
            method,
            rawQuery: ctx.rawQuery,
            headers: ctx.req.headers,
            rawBody: ctx.req.rawBody,
            ip: ctx.req.ip,
          });
          return ok(r.body, r.status);
        },
      }),
    ),
  ];
}

function profileView(u: { telegramId: number; username: string | null; firstName: string; createdAt: string; languageCode: string | null }) {
  return { telegramId: u.telegramId, username: u.username, firstName: u.firstName, registeredAt: u.createdAt, languageCode: u.languageCode };
}
