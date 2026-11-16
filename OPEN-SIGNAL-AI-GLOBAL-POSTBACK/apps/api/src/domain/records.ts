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
  /** Each Telegram API call of the last sync; ok=true only when Telegram answered ok:true. */
  steps?: TelegramSyncStep[];
}

export interface TelegramSyncStep {
  name: string;
  ok: boolean;
  error: string | null;
}

/** Deposit summary of a user, maintained ONLY from verified postback events. */
export interface DepositSummary {
  status: 'none' | 'ftd' | 'redeposit';
  ftdAmount: number | null;
  ftdCurrency: string | null;
  ftdAt: string | null;
  depositsCount: number;
  lastDepositAt: string | null;
  updatedAt: string;
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
  /** Masked Trader ID the user submitted and that is still awaiting confirmation. */
  submittedTraderIdMasked?: string | null;
  /** Onboarding step 1: the user opened this bot's partner link. */
  registrationStartedAt?: string | null;
  /** Onboarding step 2 reached: the user said they registered and opened Trader ID input. */
  traderIdSubmitStartedAt?: string | null;
  /** First time onboarding reached "completed" (verified registration). */
  onboardingCompletedAt?: string | null;
  deposit?: DepositSummary | null;
}

/** user_settings/{botId}_{telegramId} */
export interface UserSettingsRecord {
  [key: string]: unknown;
  botId: string;
  language: Lang | null;
  favorites: string[];
  analysisMode: 'BASIC' | 'FULL';
  /** Last selected market mode in the Mini App. */
  marketMode?: 'forex' | 'otc';
  updatedAt: string;
}
