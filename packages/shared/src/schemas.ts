import { z } from 'zod';
import {
  ADMIN_ROLES,
  BINDING_STATES,
  BOT_STATUSES,
  LANGUAGES,
  CHART_TIMEFRAMES_SEC,
  MANAGER_PERMISSIONS,
  MARKET_MODES,
  MODULES,
  POSTBACK_EVENT_TYPES,
  SIM_VOLATILITY,
  SIMULATION_INTERVALS_SEC,
} from './constants.ts';
import { FOREX_INSTRUMENTS, OTC_INSTRUMENTS } from './instruments.ts';

// ───────────────────────── primitives ─────────────────────────

export const languageSchema = z.enum(LANGUAGES);
export const moduleIdSchema = z.enum(MODULES);
export const botStatusSchema = z.enum(BOT_STATUSES);
export const bindingStateSchema = z.enum(BINDING_STATES);

/** #RRGGBB only — predictable for CSS variables and contrast checks. */
export const hexColorSchema = z
  .string()
  .regex(/^#[0-9a-fA-F]{6}$/, 'Expected a colour in #RRGGBB format');

/** Text stored per language. Missing languages are allowed (shown as untranslated in admin). */
export const localizedTextSchema = (max: number) =>
  z.object({
    ru: z.string().max(max).optional(),
    uk: z.string().max(max).optional(),
    en: z.string().max(max).optional(),
  });

/** Telegram bot username: 5–32 chars, letters/digits/underscore, must end with "bot". */
export const botUsernameSchema = z
  .string()
  .regex(/^[A-Za-z][A-Za-z0-9_]{3,30}[Bb][Oo][Tt]$/, 'Invalid Telegram bot username');

/** BotFather token shape: "<digits>:<35 url-safe chars>". Real validity is checked with getMe. */
export const botTokenSchema = z
  .string()
  .trim()
  .regex(/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/, 'Invalid BotFather token format');

// ───────────────────────── theme ─────────────────────────

export const themeSchema = z.object({
  primary: hexColorSchema,
  secondary: hexColorSchema,
  accent: hexColorSchema,
  background: hexColorSchema,
  surface: hexColorSchema,
  card: hexColorSchema,
  text: hexColorSchema,
  textMuted: hexColorSchema,
  buttonFrom: hexColorSchema,
  buttonTo: hexColorSchema,
});
export type Theme = z.infer<typeof themeSchema>;

export const DEFAULT_THEME: Theme = {
  primary: '#FF2D46',
  secondary: '#FF6A3D',
  accent: '#FFC24B',
  background: '#000000',
  surface: '#0B0B0D',
  card: '#131316',
  text: '#F2EFEA',
  textMuted: '#8C8A93',
  buttonFrom: '#FF2D46',
  buttonTo: '#FF6A3D',
};

// ───────────────────────── bot configuration ─────────────────────────

export const botModulesSchema = z.record(moduleIdSchema, z.boolean());

export const accountBindingSettingsSchema = z.object({
  /** Trader ID format accepted by this bot's partner program. */
  traderIdPattern: z.string().max(200).default('^[A-Za-z0-9_-]{3,64}$'),
  /** Modules that require account_bound. Never may include ALWAYS_OPEN_MODULES (enforced in API). */
  gatedModules: z.array(moduleIdSchema).default(['signals']),
  recheckCooldownSec: z.number().int().min(10).max(3600).default(30),
  supportHintAfterHours: z.number().int().min(1).max(168).default(24),
});
export type AccountBindingSettings = z.infer<typeof accountBindingSettingsSchema>;
const ACCOUNT_BINDING_DEFAULTS: AccountBindingSettings = { traderIdPattern: '^[A-Za-z0-9_-]{3,64}$', gatedModules: ['signals'], recheckCooldownSec: 30, supportHintAfterHours: 24 };

// ───────────────────────── partner link ─────────────────────────

/** Placeholders replaced in a partner link for every click. */
export const PARTNER_LINK_PLACEHOLDERS = ['{click_id}', '{bot_id}', '{partner_id}'] as const;

export const partnerLinkSchema = z
  .string()
  .trim()
  .max(1000)
  .refine((v) => {
    try {
      const u = new URL(v.replaceAll('{', '').replaceAll('}', ''));
      return u.protocol === 'https:' && u.hostname.includes('.');
    } catch {
      return false;
    }
  }, 'Partner link must be an https:// address');

export const partnerSettingsSchema = z.object({
  /** Registration link of THIS bot's partner program. null = not configured. */
  linkTemplate: partnerLinkSchema.nullable(),
  /** Label of the registration button in the Mini App, per language. */
  buttonText: localizedTextSchema(40),
  /** Optional partner/affiliate id stored with every click and available as {partner_id}. */
  partnerId: z.string().trim().max(64).regex(/^[A-Za-z0-9_.:-]*$/).nullable(),
});
export type PartnerSettings = z.infer<typeof partnerSettingsSchema>;

// ───────────────────────── Telegram bot presentation ─────────────────────────

export const telegramSettingsSchema = z.object({
  /** Text of the chat Menu Button that opens the Mini App (Telegram limit is short). */
  menuButtonText: z.string().trim().min(1).max(32),
  /** Reply to /start, per language. Empty = built-in greeting. */
  welcomeText: localizedTextSchema(1000),
});
export type TelegramSettings = z.infer<typeof telegramSettingsSchema>;

// ───────────────────────── markets (Forex / OTC) ─────────────────────────

const intervalSchema = z.number().int().refine((v) => (SIMULATION_INTERVALS_SEC as readonly number[]).includes(v), 'Unsupported period');

export const marketSettingsSchema = z
  .object({
    enabled: z.boolean(),
    /** Instrument ids shown in this mode, in display order. */
    instruments: z.array(z.string().max(32)).min(1).max(60),
    /** Expiry periods offered for demo signals, seconds. */
    periods: z.array(intervalSchema).min(1).max(SIMULATION_INTERVALS_SEC.length),
    defaultPeriod: intervalSchema,
    /** Candle size of the chart, seconds. */
    timeframeSec: z.number().int().refine((v) => (CHART_TIMEFRAMES_SEC as readonly number[]).includes(v), 'Unsupported timeframe'),
    volatility: z.enum(SIM_VOLATILITY),
    showRsi: z.boolean(),
    rsiPeriod: z.number().int().min(5).max(30),
    /** Minimum pause between two demo signals of one user, seconds. */
    signalCooldownSec: z.number().int().min(0).max(600),
    maxSignalsPerDay: z.number().int().min(1).max(500),
  })
  .refine((m) => m.periods.includes(m.defaultPeriod), { message: 'Default period must be one of the periods', path: ['defaultPeriod'] });
export type MarketSettings = z.infer<typeof marketSettingsSchema>;

export const marketsSchema = z.object({ forex: marketSettingsSchema, otc: marketSettingsSchema });
export type MarketsSettings = z.infer<typeof marketsSchema>;
export const marketModeSchema = z.enum(MARKET_MODES);

export const DEFAULT_MARKET_SETTINGS: { forex: MarketSettings; otc: MarketSettings } = {
  forex: {
    enabled: true,
    instruments: FOREX_INSTRUMENTS.map((i) => i.id),
    periods: [60, 120, 300],
    defaultPeriod: 60,
    timeframeSec: 60,
    volatility: 'normal',
    showRsi: true,
    rsiPeriod: 14,
    signalCooldownSec: 30,
    maxSignalsPerDay: 50,
  },
  otc: {
    enabled: true,
    instruments: OTC_INSTRUMENTS.map((i) => i.id),
    periods: [30, 60, 120],
    defaultPeriod: 60,
    timeframeSec: 15,
    volatility: 'normal',
    showRsi: true,
    rsiPeriod: 14,
    signalCooldownSec: 30,
    maxSignalsPerDay: 50,
  },
};

export const DEFAULT_TELEGRAM_SETTINGS: TelegramSettings = { menuButtonText: 'OPEN SIGNAL AI', welcomeText: {} };
export const DEFAULT_PARTNER_SETTINGS: PartnerSettings = { linkTemplate: null, buttonText: {}, partnerId: null };

export const botConfigSchema = z.object({
  name: z.string().min(1).max(64),
  username: botUsernameSchema,
  description: localizedTextSchema(512),
  shortDescription: localizedTextSchema(120),
  miniAppTitle: z.string().min(1).max(64),
  defaultLanguage: languageSchema,
  theme: themeSchema,
  avatarMediaId: z.string().max(128).nullable(),
  logoMediaId: z.string().max(128).nullable(),
  supportContact: z.string().max(128),
  modules: botModulesSchema,
  accountBinding: accountBindingSettingsSchema,
  partner: partnerSettingsSchema,
  telegram: telegramSettingsSchema,
  /** @deprecated Former per-bot simulator settings. Not used; kept so existing documents lose nothing on save. */
  markets: marketsSchema.optional(),
});
export type BotConfig = z.infer<typeof botConfigSchema>;

/**
 * Brings a stored configuration written by an older version up to the current
 * shape (data migration on read — nothing in the database is rewritten until
 * the next save). Safe to call on an already current config.
 */
export function upgradeBotConfig<T extends Record<string, unknown>>(raw: T): T & BotConfig {
  const r = raw as Record<string, unknown> & Partial<BotConfig>;
  const binding = { ...(r.accountBinding ?? {}) } as Record<string, unknown>;
  const legacyLink = typeof binding['partnerLinkTemplate'] === 'string' ? (binding['partnerLinkTemplate'] as string) : null;
  delete binding['partnerLinkTemplate'];
  return {
    ...raw,
    accountBinding: { ...ACCOUNT_BINDING_DEFAULTS, ...binding } as AccountBindingSettings,
    partner: { ...DEFAULT_PARTNER_SETTINGS, ...(legacyLink ? { linkTemplate: legacyLink } : {}), ...(r.partner ?? {}) },
    telegram: { ...DEFAULT_TELEGRAM_SETTINGS, ...(r.telegram ?? {}) },
  } as T & BotConfig;
}

/** Fills {click_id}, {bot_id}, {partner_id} in a partner link. */
export function renderPartnerLink(template: string, v: { clickId: string; botId: string; partnerId: string | null }): string {
  return template
    .replaceAll('{click_id}', encodeURIComponent(v.clickId))
    .replaceAll('{bot_id}', encodeURIComponent(v.botId))
    .replaceAll('{partner_id}', encodeURIComponent(v.partnerId ?? ''));
}

/** Editable part of a bot's configuration (username comes from Telegram, media from uploads). */
export const botConfigEditSchema = botConfigSchema.omit({ avatarMediaId: true, logoMediaId: true, username: true });
export type BotConfigEdit = z.infer<typeof botConfigEditSchema>;

/** What the admin form submits when creating a bot (token is write-only; username is read from Telegram). */
export const botCreateInputSchema = botConfigEditSchema.extend({ token: botTokenSchema });
export type BotCreateInput = z.infer<typeof botCreateInputSchema>;

/** Public (unauthenticated) configuration the Mini App loads at start. Never contains secrets. */
export const publicBotConfigSchema = z.object({
  botId: z.string(),
  status: botStatusSchema,
  name: z.string(),
  username: z.string(),
  miniAppTitle: z.string(),
  defaultLanguage: languageSchema,
  theme: themeSchema,
  logoUrl: z.string().nullable(),
  supportContact: z.string(),
  modules: botModulesSchema,
  partner: z.object({ configured: z.boolean(), buttonText: localizedTextSchema(40) }),
});
export type PublicBotConfig = z.infer<typeof publicBotConfigSchema>;

// ───────────────────────── account binding & postback ─────────────────────────

export const traderIdInputSchema = z.object({
  traderId: z.string().trim().min(1).max(64),
});

export const postbackAuthSchema = z.discriminatedUnion('method', [
  z.object({
    method: z.literal('hmac_sha256'),
    /** Header that carries the hex signature of the raw request (body for POST, query string for GET). */
    signatureHeader: z.string().min(1).max(64).default('x-signature'),
    secretEnc: z.string().min(1),
  }),
  z.object({
    method: z.literal('shared_secret'),
    /** Where the secret is sent by the partner: header name or query parameter name. */
    location: z.enum(['header', 'query']),
    name: z.string().min(1).max(64),
    secretEnc: z.string().min(1),
  }),
]);

export const postbackMappingSchema = z.object({
  eventId: z.string().max(64).nullable().default(null),
  eventType: z.string().max(64),
  traderId: z.string().max(64),
  clickId: z.string().max(64).nullable().default(null),
  occurredAt: z.string().max(64).nullable().default(null),
  /** Deposit amount and currency parameters (FTD / redeposit). */
  amount: z.string().max(64).nullable().default(null),
  currency: z.string().max(64).nullable().default(null),
  /** Partner/affiliate id parameter, stored with the event. */
  partnerId: z.string().max(64).nullable().default(null),
});

export const partnerSourceSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{3,40}$/),
  botId: z.string().min(1),
  name: z.string().min(1).max(80),
  enabled: z.boolean(),
  auth: postbackAuthSchema,
  /** Optional extra protection on top of auth. Empty = not enforced. */
  ipAllowlist: z.array(z.string().ip()).default([]),
  mapping: postbackMappingSchema,
  /** Partner's raw event names → platform event types. */
  eventTypeMap: z.record(z.string(), z.enum(POSTBACK_EVENT_TYPES)),
});
export type PartnerSource = z.infer<typeof partnerSourceSchema>;

// ───────────────────────── admins ─────────────────────────

export const adminUserSchema = z.object({
  uid: z.string(),
  email: z.string().email(),
  role: z.enum(ADMIN_ROLES),
  active: z.boolean(),
  /** Per bot permissions for managers. Owner ignores this map. */
  botPermissions: z.record(z.string(), z.array(z.enum(MANAGER_PERMISSIONS))),
});
export type AdminUser = z.infer<typeof adminUserSchema>;
