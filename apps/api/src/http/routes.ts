import { traderIdInputSchema } from '@open-signal/shared';
import { AppError } from '../lib/errors.ts';
import type { Services } from '../app.ts';
import { TenantScope } from '../domain/tenant.ts';
import type { UserRecord } from '../domain/records.ts';
import type { BotBundle } from '../domain/bots.ts';
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

/** A failed "Link account" is a business outcome: 409 with a reason, the state is still returned. */
function bindingResponse(r: BindingResult, onboarding: unknown): HttpResponse {
  if (r.error) return { status: 409, body: { error: { code: r.error }, binding: r.view, onboarding } };
  return ok({ binding: r.view, onboarding });
}

const settingsView = (st: { language: unknown; favorites: unknown }) => ({ language: st.language, favorites: st.favorites });

/** What the user sees about themself. The Trader ID is their own, so it is shown in full once linked. */
function profileView(u: UserRecord, bundle: BotBundle) {
  return {
    telegramId: u.telegramId,
    username: u.username,
    firstName: u.firstName,
    registeredAt: u.createdAt,
    languageCode: u.languageCode,
    botName: bundle.config.name,
    traderId: u.bindingState === 'account_bound' ? u.traderId : null,
  };
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
  const onboardingOf = async (scope: TenantScope, bundle: BotBundle, user: UserRecord) =>
    s.onboarding.view(scope, user, bundle.config, (await s.platform.signals()).requireFtd);
  /** Full Mini App state. Onboarding first: it may mark onboarding as completed in the user record. */
  const state = async (scope: TenantScope, bundle: BotBundle, user: UserRecord) => {
    const onboarding = await onboardingOf(scope, bundle, user);
    const fresh = onboarding.status === 'completed' && !user.onboardingCompletedAt ? await s.users.get(scope, user.telegramId) : user;
    const [settings, progress, catalog] = await Promise.all([
      s.users.getSettings(scope, user.telegramId),
      s.academy.progress(scope, fresh),
      s.academy.catalog(true),
    ]);
    const total = catalog.categories.reduce((n, c) => n + c.lessons.length, 0);
    const ids = new Set(catalog.categories.flatMap((c) => c.lessons.map((l) => l.id)));
    return {
      user: profileView(fresh, bundle),
      settings: settingsView(settings),
      binding: s.binding.view(fresh, bundle.config),
      onboarding,
      academy: { done: Object.keys(progress).filter((id) => ids.has(id)).length, total },
    };
  };
  const requireOnboarded = (user: UserRecord) => {
    if (!user.onboardingCompletedAt) throw new AppError('ONBOARDING_REQUIRED');
  };

  return [
    {
      method: 'GET',
      path: '/health',
      // Shallow by design (Render polls it often): no database read per call.
      handler: async () =>
        ok({
          status: 'ok',
          time: s.now().toISOString(),
          storage: s.store.kind,
          persistentStorage: s.store.kind === 'firestore',
          firestoreIndexes: s.indexStatus(),
          marketData: 'not_connected',
          signalEngine: 'training',
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
        const session = s.sessions.issue(scope.botId, user.telegramId, s.now());
        s.stats.incr(scope.botId, 'miniapp_launches');
        if (isNew) s.stats.incr(scope.botId, 'users_new');
        return ok({ session, ...(await state(scope, bundle, user)) });
      },
    },

    {
      method: 'GET',
      path: '/api/miniapp/:botId/me',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { scope, bundle, user } = await authed(ctx);
        return ok(await state(scope, bundle, user));
      },
    },

    {
      method: 'PUT',
      path: '/api/miniapp/:botId/settings',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { scope, user } = await authed(ctx);
        const body = ctx.json() as Record<string, unknown>;
        const next = await s.users.updateSettings(scope, user.telegramId, { language: body['language'], favorites: body['favorites'] }, s.now());
        return ok({ settings: settingsView(next) });
      },
    },

    // ───────── onboarding (mandatory, server-driven) ─────────
    {
      method: 'GET',
      path: '/api/miniapp/:botId/onboarding',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { scope, bundle, user } = await authed(ctx);
        return ok({ onboarding: await onboardingOf(scope, bundle, user), binding: s.binding.view(user, bundle.config) });
      },
    },
    {
      // Step 1: opens THIS bot's partner link with the user's personal click_id.
      method: 'POST',
      path: '/api/miniapp/:botId/onboarding/register',
      rateLimit: 'binding',
      handler: async (ctx) => {
        const { scope, bundle, user } = await authed(ctx);
        const r = await s.binding.startRegistration(scope, bundle.config, user.telegramId);
        const fresh = await s.users.get(scope, user.telegramId);
        return ok({ link: r.partnerLink, onboarding: await onboardingOf(scope, bundle, fresh) });
      },
    },
    {
      // Step 1 → 2: "I have registered".
      method: 'POST',
      path: '/api/miniapp/:botId/onboarding/returned',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { scope, bundle, user } = await authed(ctx);
        await s.onboarding.markReturned(scope, user);
        const fresh = await s.users.get(scope, user.telegramId);
        return ok({ onboarding: await onboardingOf(scope, bundle, fresh) });
      },
    },
    {
      // "Try again" after a failed check: back to step 1, everything else is kept.
      method: 'POST',
      path: '/api/miniapp/:botId/onboarding/restart',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { scope, bundle, user } = await authed(ctx);
        await s.binding.restartOnboarding(scope, user.telegramId);
        const fresh = await s.users.get(scope, user.telegramId);
        return ok({ onboarding: await onboardingOf(scope, bundle, fresh) });
      },
    },
    {
      // Step 2: "Link account" — verified against the registration postback and the user's click_id.
      method: 'POST',
      path: '/api/miniapp/:botId/binding/trader-id',
      rateLimit: 'binding',
      handler: async (ctx) => {
        const { scope, bundle, user } = await authed(ctx);
        const parsed = traderIdInputSchema.safeParse(ctx.json());
        if (!parsed.success) throw new AppError('TRADER_ID_INVALID');
        const r = await s.binding.submitTraderId(scope, bundle.config, user.telegramId, parsed.data.traderId);
        const fresh = await s.users.get(scope, user.telegramId);
        return bindingResponse(r, await onboardingOf(scope, bundle, fresh));
      },
    },

    // ───────── signals (one system for every bot) ─────────
    {
      method: 'GET',
      path: '/api/miniapp/:botId/signals/config',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        await authed(ctx);
        return ok(await s.signals.config());
      },
    },
    {
      method: 'POST',
      path: '/api/miniapp/:botId/signals',
      rateLimit: 'miniapp', // per-user cooldown and daily limit are enforced by SignalService
      handler: async (ctx) => {
        const { scope, user } = await authed(ctx);
        return ok({ signal: await s.signals.issue(scope, user, ctx.json() as Record<string, unknown>) }, 201);
      },
    },
    {
      method: 'POST',
      path: '/api/miniapp/:botId/signals/:signalId/open',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { scope, user } = await authed(ctx);
        return ok({ signal: await s.signals.open(scope, user, ctx.params['signalId'] ?? '') });
      },
    },
    {
      method: 'GET',
      path: '/api/miniapp/:botId/signals',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { scope, user } = await authed(ctx);
        return ok({ signals: await s.signals.list(scope, user, Number(ctx.query.get('limit') ?? 20)) });
      },
    },

    // ───────── academy (shared by every bot, progress per user) ─────────
    {
      method: 'GET',
      path: '/api/miniapp/:botId/academy',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { scope, user } = await authed(ctx);
        requireOnboarded(user);
        const [catalog, progress] = await Promise.all([s.academy.catalog(true), s.academy.progress(scope, user)]);
        return ok({ catalog, progress });
      },
    },
    {
      method: 'GET',
      path: '/api/miniapp/:botId/academy/lessons/:lessonId',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { user } = await authed(ctx);
        requireOnboarded(user);
        return ok({ lesson: await s.academy.lesson(ctx.params['lessonId'] ?? '', true) });
      },
    },
    {
      method: 'PUT',
      path: '/api/miniapp/:botId/academy/lessons/:lessonId/progress',
      rateLimit: 'miniapp',
      handler: async (ctx) => {
        const { scope, user } = await authed(ctx);
        requireOnboarded(user);
        const done = (ctx.json() as { done?: unknown }).done === true;
        return ok({ progress: await s.academy.setCompleted(scope, user, ctx.params['lessonId'] ?? '', done) });
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
