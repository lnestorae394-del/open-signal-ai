import type { BindingState, BotConfig, BotStatus, Lang } from './shared-types.ts';

/** bots/{botId} — operational record. Secrets are stored encrypted only. */
export interface BotRecord {
  [key: string]: unknown;
  id: string;
  status: BotStatus;
  telegramBotId: number | null;
  /** AES-256-GCM ciphertext bound to "bot:<id>:token". */
  tokenEnc: string | null;
  tokenMasked: string | null;
  /** sha256 of the webhook secret_token (fast constant-time comparison on every update). */
  webhookSecretHash: string | null;
  /** The same secret, encrypted (AAD "bot:<id>:webhook"), needed to re-register the webhook after a URL change. */
  webhookSecretEnc?: string | null;
  devOnly: boolean;
  usersCount?: number;
  telegram?: TelegramSyncState;
  createdAt: string;
  updatedAt: string;
  archivedAt: string | null;
}

export interface TelegramSyncState {
  username: string | null;
  webhookUrl: string | null;
  syncedAt: string | null;
  /** Human-readable problems of the last sync (empty = all steps succeeded). */
  issues: string[];
}

/** bot_configs/{botId} — everything editable in the admin panel. */
export interface BotConfigRecord extends BotConfig {
  [key: string]: unknown;
  botId: string;
  updatedAt: string;
}

/** users/{botId}_{telegramId} */
export interface UserRecord {
  [key: string]: unknown;
  botId: string;
  telegramId: number;
  username: string | null;
  firstName: string;
  lastName: string | null;
  languageCode: string | null;
  isPremium: boolean;
  createdAt: string;
  lastSeenAt: string;
  launches: number;
  bindingState: BindingState;
  bindingUpdatedAt: string;
  traderId: string | null;
  /** sha256(traderIdNorm) of a registration confirmed via this user's click_id. */
  verifiedTraderIdHash: string | null;
  mismatchAttempts: number;
  lastRecheckAt: string | null;
}

/** user_settings/{botId}_{telegramId} */
export interface UserSettingsRecord {
  [key: string]: unknown;
  botId: string;
  language: Lang | null;
  favorites: string[];
  analysisMode: 'BASIC' | 'FULL';
  updatedAt: string;
}
