/** Supported interface languages. Order = order in the language switcher. */
export const LANGUAGES = ['ru', 'uk', 'en'] as const;
export type Language = (typeof LANGUAGES)[number];

/** Modules that can be switched on/off per bot from the admin panel. */
export const MODULES = [
  'signals',
  'pairs',
  'simulator',
  'history',
  'academy',
  'profile',
  'account_binding',
] as const;
export type ModuleId = (typeof MODULES)[number];

/**
 * Modules that must stay available regardless of Account Binding state or
 * any financial event. Enforced in the API (see binding access policy).
 */
export const ALWAYS_OPEN_MODULES: readonly ModuleId[] = ['academy', 'simulator', 'profile'];

/** Lifecycle of a bot. Nothing is ever hard-deleted by status changes. */
export const BOT_STATUSES = ['active', 'disabled', 'archived', 'token_invalid'] as const;
export type BotStatus = (typeof BOT_STATUSES)[number];

/** Account Binding state machine (see docs/account-binding.md). */
export const BINDING_STATES = [
  'telegram_created',
  'waiting_for_trader_id',
  'registration_pending',
  'registration_verified',
  'account_bound',
  'binding_conflict',
  'manual_review',
] as const;
export type BindingState = (typeof BINDING_STATES)[number];

/** Admin roles. Owner sees everything, managers only assigned bots. */
export const ADMIN_ROLES = ['owner', 'manager'] as const;
export type AdminRole = (typeof ADMIN_ROLES)[number];

/** Permissions a manager can be granted per assigned bot. */
export const MANAGER_PERMISSIONS = [
  'bot.appearance.edit',
  'bot.status.toggle',
  'academy.edit',
  'users.view',
  'logs.view',
  'stats.view',
  'binding.manage',
] as const;
export type ManagerPermission = (typeof MANAGER_PERMISSIONS)[number];

/** Data quality markers shown next to every market value. */
export const DATA_STATUSES = [
  'LIVE',
  'DELAYED',
  'STALE',
  'MARKET_CLOSED',
  'UNAVAILABLE',
  'NO_VERIFIED_SOURCE',
] as const;
export type DataStatus = (typeof DATA_STATUSES)[number];

/** Postback event types understood by the platform. */
export const POSTBACK_EVENT_TYPES = ['registration', 'ftd', 'deposit', 'other'] as const;
export type PostbackEventType = (typeof POSTBACK_EVENT_TYPES)[number];

/** Financial events are analytics-only and never change access. */
export const FINANCIAL_EVENT_TYPES: readonly PostbackEventType[] = ['ftd', 'deposit'];

/** Simulator intervals in seconds (Stage 4). */
export const SIMULATION_INTERVALS_SEC = [15, 30, 60, 120, 180, 300, 600, 900, 1800] as const;
