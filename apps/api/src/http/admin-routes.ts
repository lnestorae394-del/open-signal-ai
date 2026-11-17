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
    r('PUT', '/bots/:botId/telegram', async (ctx) => ok({ bot: await s.botAdmin.updateTelegram(await actorOf(ctx), botParam(ctx), ctx.json()) })),
    r('GET', '/bots/:botId/webhook', async (ctx) => ok({ webhook: await s.botAdmin.webhookInfo(await actorOf(ctx), botParam(ctx)) })),
    r('DELETE', '/bots/:botId', async (ctx) => ok(await s.botAdmin.remove(await actorOf(ctx), botParam(ctx), ctx.json()))),
    r('GET', '/users', async (ctx) =>
      ok(await s.insights.allUsers(await actorOf(ctx), { botId: ctx.query.get('botId'), state: ctx.query.get('state'), access: ctx.query.get('access'), before: ctx.query.get('before') }))),
    r('GET', '/system', async (ctx) => ok({ system: s.insights.system(await actorOf(ctx), s.indexStatus()) })),
    r('POST', '/bots/:botId/media', async (ctx) => ok({ bot: await s.botAdmin.uploadMedia(await actorOf(ctx), botParam(ctx), ctx.json()) }), { maxBody: 800 * 1024 }),

    // ── per-bot data ──
    r('GET', '/bots/:botId/users', async (ctx) =>
      ok(await s.insights.users(await actorOf(ctx), botParam(ctx), { state: ctx.query.get('state'), access: ctx.query.get('access'), before: ctx.query.get('before') }))),
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
    // ── one user: card + manual actions (each: binding.manage, reason, transaction, audit) ──
    r('GET', '/bots/:botId/users/:telegramId', async (ctx) =>
      ok({ user: await s.insights.userCard(await actorOf(ctx), botParam(ctx), Number(ctx.params['telegramId'])) })),
    r('POST', '/bots/:botId/users/:telegramId/manual-access', async (ctx) => {
      const actor = await actorOf(ctx);
      const b = ctx.json() as { grant?: unknown; reason?: unknown };
      if (typeof b.grant !== 'boolean') throw new AppError('VALIDATION_FAILED', 'grant must be true or false');
      await s.binding.adminSetManualAccess(actor, new TenantScope(botParam(ctx)), { telegramId: Number(ctx.params['telegramId']), grant: b.grant, reason: String(b.reason ?? '') });
      return ok({ user: await s.insights.userCard(actor, botParam(ctx), Number(ctx.params['telegramId'])) });
    }),
    r('POST', '/bots/:botId/users/:telegramId/onboarding-step', async (ctx) => {
      const actor = await actorOf(ctx);
      const b = ctx.json() as { step?: unknown; reason?: unknown };
      await s.binding.adminSetOnboardingStep(actor, new TenantScope(botParam(ctx)), {
        telegramId: Number(ctx.params['telegramId']), step: String(b.step ?? '') as 'registration' | 'trader_id', reason: String(b.reason ?? ''),
      });
      return ok({ user: await s.insights.userCard(actor, botParam(ctx), Number(ctx.params['telegramId'])) });
    }),
    r('POST', '/bots/:botId/users/:telegramId/deposit-recheck', async (ctx) => {
      const actor = await actorOf(ctx);
      const b = ctx.json() as { reason?: unknown };
      await s.binding.adminRecheckDeposit(actor, new TenantScope(botParam(ctx)), { telegramId: Number(ctx.params['telegramId']), reason: String(b.reason ?? '') });
      return ok({ user: await s.insights.userCard(actor, botParam(ctx), Number(ctx.params['telegramId'])) });
    }),
    // ───────── global postback: source, history, integration errors ─────────
    r('GET', '/postback/sources', async (ctx) => ok({ sources: await s.insights.allSources(await actorOf(ctx)) })),
    r('POST', '/postback/sources', async (ctx) =>
      ok(await s.insights.createSource(await actorOf(ctx), '*', { ...(ctx.json() as Record<string, unknown>), global: true }), 201)),
    r('PUT', '/postback/sources/:sourceId', async (ctx) => ok(await s.insights.updateSourceById(await actorOf(ctx), ctx.params['sourceId'] ?? '', ctx.json()))),
    r('GET', '/postback/events', async (ctx) =>
      ok(await s.insights.postbackEvents(await actorOf(ctx), { botId: ctx.query.get('botId'), type: ctx.query.get('type'), before: ctx.query.get('before') }))),
    r('GET', '/postback/errors', async (ctx) => ok({ items: await s.insights.integrationErrors(await actorOf(ctx)) })),
    r('POST', '/postback/events/:eventId/excluded', async (ctx) => {
      const actor = await actorOf(ctx);
      const id = ctx.params['eventId'] ?? '';
      if (!/^[A-Za-z0-9_-]{3,120}$/.test(id)) throw new AppError('NOT_FOUND');
      const b = ctx.json() as { excluded?: unknown; reason?: unknown };
      return ok(await s.binding.adminSetEventExcluded(actor, id, { excluded: b.excluded === true, reason: String(b.reason ?? '') }));
    }),

    // ───────── shared signal settings ─────────
    r('GET', '/settings/signals', async (ctx) => {
      await actorOf(ctx);
      return ok({ settings: await s.platform.signals(), engine: 'training' });
    }),
    r('PUT', '/settings/signals', async (ctx) => ok({ settings: await s.platform.updateSignals(await actorOf(ctx), ctx.json()) })),

    // ───────── shared academy ─────────
    r('GET', '/academy', async (ctx) => {
      await actorOf(ctx);
      return ok({ catalog: await s.academy.catalog(false) });
    }),
    r('GET', '/academy/lessons/:lessonId', async (ctx) => {
      await actorOf(ctx);
      return ok({ lesson: await s.academy.lesson(ctx.params['lessonId'] ?? '', false) });
    }),
    r('POST', '/academy/import', async (ctx) => {
      await s.academy.importBuiltIn(await actorOf(ctx));
      return ok({ catalog: await s.academy.catalog(false) });
    }),
    r('POST', '/academy/categories', async (ctx) => ok({ id: await s.academy.saveCategory(await actorOf(ctx), null, ctx.json()) }, 201)),
    r('PUT', '/academy/categories/:id', async (ctx) => ok({ id: await s.academy.saveCategory(await actorOf(ctx), ctx.params['id'] ?? '', ctx.json()) })),
    r('DELETE', '/academy/categories/:id', async (ctx) => {
      await s.academy.deleteCategory(await actorOf(ctx), ctx.params['id'] ?? '');
      return ok({ ok: true });
    }),
    r('POST', '/academy/lessons', async (ctx) => ok({ id: await s.academy.saveLesson(await actorOf(ctx), null, ctx.json()) }, 201)),
    r('PUT', '/academy/lessons/:id', async (ctx) => ok({ id: await s.academy.saveLesson(await actorOf(ctx), ctx.params['id'] ?? '', ctx.json()) })),
    r('DELETE', '/academy/lessons/:id', async (ctx) => {
      await s.academy.deleteLesson(await actorOf(ctx), ctx.params['id'] ?? '');
      return ok({ ok: true });
    }),
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
