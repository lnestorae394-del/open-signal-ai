import { LANGUAGES, type BotConfig } from '@open-signal/shared';
import { miniAppUrl, webhookUrl, type Env } from '../config/env.ts';
import type { SecretBox } from '../lib/crypto.ts';
import type { Logger } from '../lib/logger.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import type { BotRepository } from '../domain/bots.ts';
import type { BotRecord, TelegramSyncState, TelegramSyncStep } from '../domain/records.ts';
import { TelegramApiError, type TelegramBotApi } from './bot-api.ts';

export const webhookAad = (botId: string) => `bot:${botId}:webhook`;

/**
 * Pushes a bot's configuration to Telegram: webhook (with secret_token),
 * localized name / description / short description, and the menu button
 * that opens this bot's Mini App. Every step is attempted; failures are
 * collected as issues (shown in the admin panel) instead of aborting the rest.
 */
export class TelegramProvisioner {
  private readonly api: TelegramBotApi;
  private readonly store: DocumentStore;
  private readonly bots: BotRepository;
  private readonly box: SecretBox;
  private readonly env: Env;
  private readonly logger: Logger;

  constructor(deps: { api: TelegramBotApi; store: DocumentStore; bots: BotRepository; box: SecretBox; env: Env; logger: Logger }) {
    this.api = deps.api;
    this.store = deps.store;
    this.bots = deps.bots;
    this.box = deps.box;
    this.env = deps.env;
    this.logger = deps.logger;
  }

  async sync(botId: string, parts: { webhook?: boolean; profile?: boolean } = { webhook: true, profile: true }): Promise<TelegramSyncState> {
    const bundle = await this.bots.require(botId);
    const token = this.bots.decryptToken(bundle);
    const issues: string[] = [];
    const steps: TelegramSyncStep[] = [];
    // A step counts as done only when Telegram itself answered ok:true (bot-api throws otherwise).
    const step = async (label: string, fn: () => Promise<unknown>) => {
      try {
        await fn();
        steps.push({ name: label, ok: true, error: null });
      } catch (e) {
        const msg = e instanceof TelegramApiError ? e.message : e instanceof Error ? e.message : String(e);
        issues.push(`${label}: ${msg}`);
        steps.push({ name: label, ok: false, error: msg });
      }
    };

    let username = bundle.bot.telegram?.username ?? null;
    await step('getMe', async () => {
      username = (await this.api.getMe(token)).username;
    });

    const hookUrl = webhookUrl(this.env, botId);
    let registeredUrl = bundle.bot.telegram?.webhookUrl ?? null;
    if (parts.webhook !== false) {
      if (!this.env.PUBLIC_URL.startsWith('https://')) {
        const msg = `Telegram requires an https URL (current public URL: ${this.env.PUBLIC_URL})`;
        issues.push(`setWebhook: ${msg}`);
        steps.push({ name: 'setWebhook', ok: false, error: msg });
      } else {
        const secret = this.webhookSecret(bundle.bot);
        await step('setWebhook', async () => {
          await this.api.setWebhook(token, hookUrl, secret);
          registeredUrl = hookUrl;
        });
      }
    }

    if (parts.profile !== false) {
      await this.syncProfile(token, bundle.config, step);
      const appUrl = miniAppUrl(this.env, botId);
      if (!appUrl.startsWith('https://')) {
        const msg = 'Mini App URL must be https';
        issues.push(`setChatMenuButton: ${msg}`);
        steps.push({ name: 'setChatMenuButton', ok: false, error: msg });
      } else {
        await step('setChatMenuButton', () => this.api.setMenuButtonWebApp(token, bundle.config.telegram.menuButtonText.slice(0, 32), appUrl));
      }
    }

    const state: TelegramSyncState = {
      username,
      webhookUrl: registeredUrl,
      syncedAt: new Date().toISOString(),
      issues,
      steps,
    };
    await this.store.update(C.bots, botId, { telegram: state, updatedAt: state.syncedAt });
    this.bots.invalidate(botId);
    if (issues.length) this.logger.warn('telegram.sync_issues', { botId, issues });
    return state;
  }

  private async syncProfile(token: string, config: BotConfig, step: (l: string, fn: () => Promise<unknown>) => Promise<void>) {
    // Default (no language_code) = bot default language; then each language that has its own text.
    await step('setMyName', () => this.api.setMyName(token, config.name.slice(0, 64)));
    const defDesc = config.description[config.defaultLanguage];
    if (defDesc) await step('setMyDescription', () => this.api.setMyDescription(token, defDesc.slice(0, 512)));
    const defShort = config.shortDescription[config.defaultLanguage];
    if (defShort) await step('setMyShortDescription', () => this.api.setMyShortDescription(token, defShort.slice(0, 120)));
    for (const lang of LANGUAGES) {
      const d = config.description[lang];
      if (d) await step(`setMyDescription(${lang})`, () => this.api.setMyDescription(token, d.slice(0, 512), lang));
      const sd = config.shortDescription[lang];
      if (sd) await step(`setMyShortDescription(${lang})`, () => this.api.setMyShortDescription(token, sd.slice(0, 120), lang));
    }
  }

  /** Live webhook status straight from Telegram (getWebhookInfo). */
  async webhookInfo(botId: string): Promise<{ url: string; expectedUrl: string; matches: boolean; pendingUpdates: number; lastErrorAt: string | null; lastErrorMessage: string | null }> {
    const bundle = await this.bots.require(botId);
    const info = await this.api.getWebhookInfo(this.bots.decryptToken(bundle));
    const expectedUrl = webhookUrl(this.env, botId);
    return {
      url: info.url,
      expectedUrl,
      matches: info.url === expectedUrl,
      pendingUpdates: info.pending_update_count ?? 0,
      lastErrorAt: info.last_error_date ? new Date(info.last_error_date * 1000).toISOString() : null,
      lastErrorMessage: info.last_error_message ?? null,
    };
  }

  /** Best-effort cleanup in Telegram when a bot is deleted from the platform. */
  async detach(bot: BotRecord, token: string): Promise<string[]> {
    const problems: string[] = [];
    await this.api.deleteWebhook(token).catch((e: unknown) => problems.push(`deleteWebhook: ${e instanceof Error ? e.message : String(e)}`));
    await this.api.resetMenuButton(token).catch((e: unknown) => problems.push(`setChatMenuButton: ${e instanceof Error ? e.message : String(e)}`));
    if (problems.length) this.logger.warn('telegram.detach_issues', { botId: bot.id, problems });
    return problems;
  }

  webhookSecret(bot: BotRecord): string {
    if (!bot.webhookSecretEnc) throw new Error('bot has no webhook secret');
    return this.box.decrypt(bot.webhookSecretEnc, webhookAad(bot.id));
  }

  /**
   * After a redeploy on a new URL (or a custom domain), re-registers webhooks of
   * active bots whose registered URL differs from the current public URL.
   */
  async resyncWebhooks(): Promise<{ checked: number; updated: number }> {
    if (!this.env.PUBLIC_URL.startsWith('https://')) return { checked: 0, updated: 0 };
    const bots = await this.store.query<BotRecord>(C.bots, { where: [{ field: 'status', op: '==', value: 'active' }] });
    let updated = 0;
    for (const { data: bot } of bots) {
      if (!bot.tokenEnc || bot.devOnly) continue;
      if (bot.telegram?.webhookUrl === webhookUrl(this.env, bot.id)) continue;
      const state = await this.sync(bot.id, { webhook: true, profile: true }).catch((e: unknown) => {
        this.logger.error('telegram.resync_failed', { botId: bot.id, err: e });
        return null;
      });
      if (state && !state.issues.some((i) => i.startsWith('setWebhook'))) updated++;
    }
    return { checked: bots.length, updated };
  }
}
