import { AppError } from '../lib/errors.ts';
import { safeEqual, sha256Hex } from '../lib/crypto.ts';
import type { Logger } from '../lib/logger.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import type { BotBundle, BotRepository } from '../domain/bots.ts';
import type { StatsBuffer } from '../domain/observability.ts';

export const SECRET_HEADER = 'x-telegram-bot-api-secret-token';
const DEDUPE_TTL_MS = 3 * 24 * 3600 * 1000;

/** Minimal shape of a Telegram Update we rely on. */
export interface TelegramUpdate {
  update_id: number;
  message?: { chat?: { id: number }; text?: string; from?: { id: number; language_code?: string } };
  [k: string]: unknown;
}

export interface UpdateHandler {
  handle(bundle: BotBundle, update: TelegramUpdate): Promise<void>;
}

/**
 * Stage-1 handler: records activity only. Replies (/start with the Mini App
 * button, "bot temporarily unavailable" for disabled bots) arrive in Stage 3
 * together with the real Telegram connection.
 */
export class RecordingUpdateHandler implements UpdateHandler {
  private readonly stats: StatsBuffer;
  constructor(stats: StatsBuffer) {
    this.stats = stats;
  }
  async handle(bundle: BotBundle, update: TelegramUpdate): Promise<void> {
    this.stats.incr(bundle.bot.id, update.message ? 'tg_messages' : 'tg_updates');
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
