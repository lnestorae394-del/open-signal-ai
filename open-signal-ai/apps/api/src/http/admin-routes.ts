import { AppError } from '../lib/errors.ts';
import type { Services } from '../app.ts';
import { TenantScope } from '../domain/tenant.ts';
import { ADMIN_COOKIE, type AdminActor } from '../admin/auth.ts';
import { C } from '../storage/collections.ts';
import type { HttpResponse, Route, RouteContext } from './types.ts';

const ok = (body: unknown, status = 200): HttpResponse => ({ status, body });

export function readCookie(header: string | undefined, name: string): string | null {
  if (!header) return null;
  for (const part of header.split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
  return null;
}

function sessionCookie(s: Services, token: string | null): string {
  const secure = s.env.PUBLIC_URL.startsWith('https://') ? '; Secure' : '';
  if (!token) return `${ADMIN_COOKIE}=; Path=/; HttpOnly; SameSite=Strict; Max-Age=0${secure}`;
  return `${ADMIN_COOKIE}=${token}; Path=/; HttpOnly; SameSite=Strict; Max-Age=${s.env.ADMIN_SESSION_TTL_SEC}${secure}`;
}

function botParam(ctx: RouteContext): string {
  try {
    return new TenantScope(ctx.params['botId'] ?? '').botId;
  } catch {
    throw new AppError('NOT_FOUND');
  }
}

/**
 * Admin API. Authentication: HttpOnly SameSite=Strict session cookie.
 * CSRF: every state-changing request must carry the custom header
 * "x-os-admin: 1", which cross-site pages cannot send without a CORS preflight.
 */
export function buildAdminRoutes(s: Services): Route[] {
  const actorOf = async (ctx: RouteContext): Promise<AdminActor> => {
    if (ctx.req.method !== 'GET' && ctx.req.headers['x-os-admin'] !== '1') throw new AppError('FORBIDDEN', 'missing CSRF header');
    return s.adminAuth.authenticate(readCookie(ctx.req.headers['cookie'], ADMIN_COOKIE));
  };
  const csrf = (ctx: RouteContext) => {
    if (ctx.req.headers['x-os-admin'] !== '1') throw new AppError('FORBIDDEN', 'missing CSRF header');
  };
  const r = (method: Route['method'], path: string, handler: Route['handler'], extra: Partial<Route> = {}): Route => ({
    method,
    path: `/api/admin${path}`,
    rateLimit: 'admin',
    handler,
    ...extra,
  });

  return [
    r('GET', '/setup', async () => ok({ needsSetup: await s.adminAuth.needsSetup() })),
    r('POST', '/setup', async (ctx) => {
      csrf(ctx);
      const res = await s.adminAuth.setupOwner(ctx.json() as Record<string, unknown> as never, ctx.req.ip);
      return { status: 201, body: { me: res.actor }, headers: { 'set-cookie': sessionCookie(s, res.token) } };
    }, { rateLimit: 'login' }),
    r('POST', '/login', async (ctx) => {
      csrf(ctx);
      const b = ctx.json() as { email?: unknown; password?: unknown };
      const res = await s.adminAuth.login(b.email, b.password, ctx.req.ip);
      return { status: 200, body: { me: res.actor }, headers: { 'set-cookie': sessionCookie(s, res.token) } };
    }, { rateLimit: 'login' }),
    r('POST', '/invite/accept', async (ctx) => {
      csrf(ctx);
      const res = await s.adminAuth.acceptInvite(ctx.json() as never, ctx.req.ip);
      return { status: 200, body: { me: res.actor }, headers: { 'set-cookie': sessionCookie(s, res.token) } };
    }, { rateLimit: 'login' }),
    r('POST', '/logout', async (ctx) => {
      csrf(ctx);
      await s.adminAuth.logout(readCookie(ctx.req.headers['cookie'], ADMIN_COOKIE));
      return { status: 200, body: { ok: true }, headers: { 'set-cookie': sessionCookie(s, null) } };
    }),
    r('GET', '/me', async (ctx) => ok({ me: await actorOf(ctx) })),
    r('POST', '/password', async (ctx) => {
      const actor = await actorOf(ctx);
      const b = ctx.json() as { current?: unknown; next?: unknown };
      await s.adminAuth.changePassword(actor, b.current, b.next);
      return ok({ ok: true });
    }, { rateLimit: 'login' }),

    r('GET', '/overview', async (ctx) => ok(await s.insights.overview(await actorOf(ctx), s.indexStatus()))),

    // ── bots ──
    r('GET', '/bots', async (ctx) => ok({ bots: await s.botAdmin.list(await actorOf(ctx)) })),
    r('POST', '/bots', async (ctx) => ok({ bot: await s.botAdmin.create(await actorOf(ctx), ctx.json()) }, 201)),
    r('GET', '/bots/:botId', async (ctx) => ok({ bot: await s.botAdmin.get(await actorOf(ctx), botParam(ctx)) })),
    r('PUT', '/bots/:botId/config', async (ctx) => ok({ bot: await s.botAdmin.updateConfig(await actorOf(ctx), botParam(ctx), ctx.json()) })),
    r('POST', '/bots/:botId/status', async (ctx) => {
      const b = ctx.json() as { status?: unknown };
      return ok({ bot: await s.botAdmin.setStatus(await actorOf(ctx), botParam(ctx), b.status) });
    }),
    r('POST', '/bots/:botId/token', async (ctx) => {
      const b = ctx.json() as { token?: unknown };
      return ok({ bot: await s.botAdmin.rotateToken(await actorOf(ctx), botParam(ctx), b.token) });
    }),
    r('POST', '/bots/:botId/telegram-sync', async (ctx) => ok({ telegram: await s.botAdmin.resync(await actorOf(ctx), botParam(ctx)) })),
    r('PUT', '/bots/:botId/partner', async (ctx) => ok({ bot: await s.botAdmin.updatePartner(await actorOf(ctx), botParam(ctx), ctx.json()) })),
    r('POST', '/bots/:botId/partner/check', async (ctx) => ok({ check: await s.botAdmin.checkPartner(await actorOf(ctx), botParam(ctx), ctx.json()) })),
    r('PUT', '/bots/:botId/markets/:mode', async (ctx) => ok({ bot: await s.botAdmin.updateMarket(await actorOf(ctx), botParam(ctx), ctx.params['mode'], ctx.json()) })),
    r('PUT', '/bots/:botId/telegram', async (ctx) => ok({ bot: await s.botAdmin.updateTelegram(await actorOf(ctx), botParam(ctx), ctx.json()) })),
    r('GET', '/bots/:botId/webhook', async (ctx) => ok({ webhook: await s.botAdmin.webhookInfo(await actorOf(ctx), botParam(ctx)) })),
    r('DELETE', '/bots/:botId', async (ctx) => ok(await s.botAdmin.remove(await actorOf(ctx), botParam(ctx), ctx.json()))),
    r('GET', '/users', async (ctx) =>
      ok(await s.insights.allUsers(await actorOf(ctx), { botId: ctx.query.get('botId'), state: ctx.query.get('state'), before: ctx.query.get('before') }))),
    r('GET', '/system', async (ctx) => ok({ system: s.insights.system(await actorOf(ctx), s.indexStatus()) })),
    r('POST', '/bots/:botId/media', async (ctx) => ok({ bot: await s.botAdmin.uploadMedia(await actorOf(ctx), botParam(ctx), ctx.json()) }), { maxBody: 800 * 1024 }),

    // ── per-bot data ──
    r('GET', '/bots/:botId/users', async (ctx) =>
      ok(await s.insights.users(await actorOf(ctx), botParam(ctx), { state: ctx.query.get('state'), before: ctx.query.get('before') }))),
    r('GET', '/bots/:botId/stats', async (ctx) => ok({ days: await s.insights.stats(await actorOf(ctx), botParam(ctx), Number(ctx.query.get('days') ?? 14)) })),
    r('GET', '/bots/:botId/logs', async (ctx) => ok({ items: await s.insights.logs(await actorOf(ctx), botParam(ctx), ctx.query.get('type') ?? 'errors') })),
    r('GET', '/bots/:botId/review', async (ctx) => ok({ items: await s.insights.reviewQueue(await actorOf(ctx), botParam(ctx)) })),
    r('POST', '/bots/:botId/binding/bind', async (ctx) => {
      const actor = await actorOf(ctx);
      const b = ctx.json() as { telegramId?: unknown; traderId?: unknown; reason?: unknown; releaseFromOther?: unknown };
      const user = await s.binding.adminBind(actor, new TenantScope(botParam(ctx)), {
        telegramId: Number(b.telegramId),
        traderId: String(b.traderId ?? ''),
        reason: String(b.reason ?? ''),
        releaseFromOther: b.releaseFromOther === true,
      });
      return ok({ state: user.bindingState });
    }),
    r('POST', '/bots/:botId/binding/reset', async (ctx) => {
      const actor = await actorOf(ctx);
      const b = ctx.json() as { telegramId?: unknown; reason?: unknown };
      const user = await s.binding.adminReturnToInput(actor, new TenantScope(botParam(ctx)), { telegramId: Number(b.telegramId), reason: String(b.reason ?? '') });
      return ok({ state: user.bindingState });
    }),
    r('GET', '/bots/:botId/sources', async (ctx) => ok({ sources: await s.insights.listSources(await actorOf(ctx), botParam(ctx)) })),
    r('POST', '/bots/:botId/sources', async (ctx) => ok(await s.insights.createSource(await actorOf(ctx), botParam(ctx), ctx.json()), 201)),
    r('PUT', '/bots/:botId/sources/:sourceId', async (ctx) =>
      ok(await s.insights.updateSource(await actorOf(ctx), botParam(ctx), ctx.params['sourceId'] ?? '', ctx.json()))),

    // ── managers (owner) ──
    r('GET', '/managers', async (ctx) => ok({ managers: await s.adminAuth.listManagers(await actorOf(ctx)) })),
    r('POST', '/managers', async (ctx) => {
      const res = await s.adminAuth.createManager(await actorOf(ctx), ctx.json() as never);
      return ok({ uid: res.uid, inviteUrl: `${s.env.PUBLIC_URL}/admin/#/invite/${res.inviteToken}` }, 201);
    }),
    r('PUT', '/managers/:uid', async (ctx) => {
      await s.adminAuth.updateManager(await actorOf(ctx), ctx.params['uid'] ?? '', ctx.json() as never);
      return ok({ ok: true });
    }),
    r('POST', '/managers/:uid/invite', async (ctx) => {
      const token = await s.adminAuth.reissueInvite(await actorOf(ctx), ctx.params['uid'] ?? '');
      return ok({ inviteUrl: `${s.env.PUBLIC_URL}/admin/#/invite/${token}` });
    }),
  ];
}

/** Public media (bot logos / avatars uploaded in the admin panel). */
export function buildMediaRoute(s: Services): Route {
  return {
    method: 'GET',
    path: '/media/:mediaId',
    rateLimit: 'media',
    handler: async (ctx) => {
      const id = ctx.params['mediaId'] ?? '';
      if (!/^m[A-Za-z0-9]{8,40}$/.test(id)) throw new AppError('NOT_FOUND');
      const m = await s.store.get<{ mime: string; data: string }>(C.media, id);
      if (!m) throw new AppError('NOT_FOUND');
      return {
        status: 200,
        body: Buffer.from(m.data, 'base64'),
        headers: { 'content-type': m.mime, 'cache-control': 'public, max-age=86400, immutable', 'content-security-policy': "default-src 'none'" },
      };
    },
  };
}
