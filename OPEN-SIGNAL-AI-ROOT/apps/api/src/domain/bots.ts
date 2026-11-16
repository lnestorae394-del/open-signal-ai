import { upgradeBotConfig, type PublicBotConfig } from '@open-signal/shared';
import { AppError } from '../lib/errors.ts';
import type { SecretBox } from '../lib/crypto.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import type { BotConfigRecord, BotRecord } from './records.ts';

const pickPublicMarket = (m: BotConfigRecord['markets']['forex']) => ({
  enabled: m.enabled,
  instruments: m.instruments,
  periods: m.periods,
  defaultPeriod: m.defaultPeriod,
  timeframeSec: m.timeframeSec,
  showRsi: m.showRsi,
});

export interface BotBundle {
  bot: BotRecord;
  config: BotConfigRecord;
}

export const tokenAad = (botId: string) => `bot:${botId}:token`;

/**
 * Bot registry with a short in-memory cache: webhooks and Mini App requests
 * for 100 bots read configuration from memory instead of the database.
 * Any write through this repository invalidates the cache entry.
 */
export class BotRepository {
  private readonly cache = new Map<string, { at: number; value: BotBundle | null }>();
  private readonly store: DocumentStore;
  private readonly box: SecretBox;
  private readonly ttlMs: number;

  constructor(store: DocumentStore, box: SecretBox, ttlMs = 30_000) {
    this.store = store;
    this.box = box;
    this.ttlMs = ttlMs;
  }

  async find(botId: string): Promise<BotBundle | null> {
    const hit = this.cache.get(botId);
    if (hit && Date.now() - hit.at < this.ttlMs) return hit.value;
    const [bot, config] = await Promise.all([
      this.store.get<BotRecord>(C.bots, botId),
      this.store.get<BotConfigRecord>(C.botConfigs, botId),
    ]);
    // Older stored configs are upgraded on read (partner link, Telegram texts, Forex/OTC settings).
    const value = bot && config ? { bot, config: upgradeBotConfig(config) } : null;
    this.cache.set(botId, { at: Date.now(), value });
    return value;
  }

  async require(botId: string): Promise<BotBundle> {
    const b = await this.find(botId);
    if (!b) throw new AppError('NOT_FOUND', 'Bot not found');
    return b;
  }

  /** Bot that may serve end users right now. */
  async requireActive(botId: string): Promise<BotBundle> {
    const b = await this.require(botId);
    if (b.bot.status !== 'active') throw new AppError('BOT_DISABLED');
    return b;
  }

  /** Decrypts the BotFather token. Only server-side code that talks to Telegram calls this. */
  decryptToken(bundle: BotBundle): string {
    if (!bundle.bot.tokenEnc) throw new AppError('NOT_IMPLEMENTED', 'Bot has no Telegram token configured');
    return this.box.decrypt(bundle.bot.tokenEnc, tokenAad(bundle.bot.id));
  }

  invalidate(botId: string): void {
    this.cache.delete(botId);
  }

  /** Drops every cached entry (used after a bot is deleted). */
  invalidateAll(): void {
    this.cache.clear();
  }

  /**
   * Status change. Disabling or archiving never deletes users, history or
   * progress — it only changes what users see.
   */
  async setStatus(botId: string, status: BotRecord['status'], now: Date): Promise<void> {
    await this.store.update(C.bots, botId, {
      status,
      updatedAt: now.toISOString(),
      archivedAt: status === 'archived' ? now.toISOString() : null,
    });
    this.invalidate(botId);
  }

  toPublicConfig({ bot, config }: BotBundle): PublicBotConfig {
    return {
      botId: bot.id,
      status: bot.status === 'token_invalid' ? 'disabled' : bot.status,
      name: config.name,
      username: config.username,
      miniAppTitle: config.miniAppTitle,
      defaultLanguage: config.defaultLanguage,
      theme: config.theme,
      logoUrl: config.logoMediaId ? `/media/${config.logoMediaId}` : null,
      supportContact: config.supportContact,
      modules: config.modules,
      bindingEnabled: config.modules.account_binding === true,
      partner: { configured: config.partner.linkTemplate !== null, buttonText: config.partner.buttonText },
      markets: {
        forex: pickPublicMarket(config.markets.forex),
        otc: pickPublicMarket(config.markets.otc),
      },
    };
  }
}
