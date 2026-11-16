import { AppError } from '../lib/errors.ts';
import { safeEqual, sha256Hex } from '../lib/crypto.ts';
import type { Logger } from '../lib/logger.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import type { BotBundle, BotRepository } from '../domain/bots.ts';
import type { StatsBuffer } from '../domain/observability.ts';
import { createTranslator, resolveLanguage } from '@open-signal/i18n';
import type { TelegramBotApi } from './bot-api.ts';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const DEDUPE_TTL_MS = 3 * 24 * 3600 * 1000;

/** Minimal shape of a Telegram Update we rely on. */
export interface TelegramUpdate {
  update_id: number;
  message?: { chat?: { id: number; type?: string }; text?: string; from?: { id: number; language_code?: string } };
  [k: string]: unknown;
}

export interface UpdateHandler {
  handle(bundle: BotBundle, update: TelegramUpdate): Promise<void>;
}

/**
 * Replies to users in Telegram:
 *  - /start (and any other text) → localized greeting with a button that opens this bot's Mini App;
 *  - disabled bot → "temporarily unavailable" (data is kept).
 * Every update is also counted in per-bot daily activity stats.
 */
export class BotUpdateHandler implements UpdateHandler {
  private readonly stats: StatsBuffer;
  private readonly api: TelegramBotApi;
  private readonly bots: BotRepository;
  private readonly appUrl: (botId: string) => string;
  private readonly savedLanguage: (botId: string, telegramId: number) => Promise<string | null>;

  constructor(deps: {
    stats: StatsBuffer;
    api: TelegramBotApi;
    bots: BotRepository;
    appUrl: (botId: string) => string;
    /** Language the user picked in the Mini App, if any. */
    savedLanguage?: (botId: string, telegramId: number) => Promise<string | null>;
  }) {
    this.stats = deps.stats;
    this.api = deps.api;
    this.bots = deps.bots;
    this.appUrl = deps.appUrl;
    this.savedLanguage = deps.savedLanguage ?? (async () => null);
  }

  async handle(bundle: BotBundle, update: TelegramUpdate): Promise<void> {
    this.stats.incr(bundle.bot.id, update.message ? 'tg_messages' : 'tg_updates');
    const msg = update.message;
    const chatId = msg?.chat?.id;
    if (!msg || chatId === undefined || msg.chat?.type !== 'private') return;
    const saved = msg.from?.id ? await this.savedLanguage(bundle.bot.id, msg.from.id).catch(() => null) : null;
    const lang = resolveLanguage(saved, bundle.config.defaultLanguage, msg.from?.language_code);
    const t = createTranslator(lang);
    const token = this.bots.decryptToken(bundle);
    if (bundle.bot.status !== 'active') {
      await this.api.sendMessage(token, chatId, t('bot.disabled'));
      return;
    }
    if (msg.text?.startsWith('/start')) this.stats.incr(bundle.bot.id, 'tg_start');
    const custom = bundle.config.telegram.welcomeText[lang]?.trim();
    await this.api.sendMessage(token, chatId, custom || t('bot.welcome', { name: bundle.config.name }), [
      [{ text: t('bot.open'), web_app: { url: this.appUrl(bundle.bot.id) } }],
    ]);
  }
}

export interface WebhookResult {
  status: number;
  body: { ok: boolean; duplicate?: boolean };
}

/**
 * Webhook entry for ALL bots: /tg/webhook/:botId.
 * 1. secret_token header must match (constant-time, stored as hash only);
 * 2. update_id is recorded with `create` → a redelivered update is acknowledged
 *    with 200 but never processed twice (also under concurrent delivery);
 * 3. the update is dispatched to the handler.
 */
export class WebhookService {
  private readonly bots: BotRepository;
  private readonly store: DocumentStore;
  private readonly handler: UpdateHandler;
  private readonly logger: Logger;

  constructor(bots: BotRepository, store: DocumentStore, handler: UpdateHandler, logger: Logger) {
    this.bots = bots;
    this.store = store;
    this.handler = handler;
    this.logger = logger;
  }

  async receive(botId: string, secretHeader: string | undefined, rawBody: string, now = new Date()): Promise<WebhookResult> {
    const bundle = await this.bots.find(botId);
    if (!bundle) throw new AppError('NOT_FOUND');
    const expected = bundle.bot.webhookSecretHash;
    if (!expected || !secretHeader || !safeEqual(sha256Hex(secretHeader), expected)) {
      throw new AppError('UNAUTHORIZED', 'webhook secret mismatch');
    }

    let update: TelegramUpdate;
    try {
      update = JSON.parse(rawBody) as TelegramUpdate;
    } catch {
      throw new AppError('BAD_REQUEST', 'invalid JSON');
    }
    if (!Number.isSafeInteger(update?.update_id)) throw new AppError('BAD_REQUEST', 'update_id missing');

    try {
      await this.store.create(C.webhookUpdates, `${botId}_${update.update_id}`, {
        botId,
        updateId: update.update_id,
        receivedAt: now.toISOString(),
        expireAt: new Date(now.getTime() + DEDUPE_TTL_MS).toISOString(),
      });
    } catch (e) {
      if (e instanceof AppError && e.code === 'ALREADY_EXISTS') return { status: 200, body: { ok: true, duplicate: true } };
      throw e;
    }

    try {
      await this.handler.handle(bundle, update);
    } catch (e) {
      // Acknowledge anyway: Telegram retries non-2xx responses, which would replay a failing update forever.
      this.logger.error('webhook.handler_failed', { botId, updateId: update.update_id, err: e });
    }
    return { status: 200, body: { ok: true } };
  }
}
