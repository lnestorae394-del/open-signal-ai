import { z } from 'zod';
import {
  ADMIN_ROLES,
  BINDING_STATES,
  BOT_STATUSES,
  LANGUAGES,
  MANAGER_PERMISSIONS,
  MODULES,
  POSTBACK_EVENT_TYPES,
} from './constants.ts';

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
  /** Optional partner link template; "{click_id}" is replaced with the user's click id. */
  partnerLinkTemplate: z.string().url().max(500).nullable().default(null),
  recheckCooldownSec: z.number().int().min(10).max(3600).default(30),
  supportHintAfterHours: z.number().int().min(1).max(168).default(24),
});
export type AccountBindingSettings = z.infer<typeof accountBindingSettingsSchema>;

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
});
export type BotConfig = z.infer<typeof botConfigSchema>;

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
