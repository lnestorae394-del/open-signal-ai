import { randomBytes } from 'node:crypto';
import {
  ALWAYS_OPEN_MODULES,
  botConfigEditSchema,
  botCreateInputSchema,
  botStatusSchema,
  type BotConfig,
  type BotStatus,
} from '@open-signal/shared';
import { miniAppUrl, type Env } from '../config/env.ts';
import { AppError } from '../lib/errors.ts';
import { maskBotToken, sha256Hex, type SecretBox } from '../lib/crypto.ts';
import { newId, newWebhookSecret } from '../lib/ids.ts';
import type { Logger } from '../lib/logger.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import { writeAudit } from '../domain/audit.ts';
import { tokenAad, type BotRepository } from '../domain/bots.ts';
import type { BotConfigRecord, BotRecord, TelegramSyncState } from '../domain/records.ts';
import { TelegramApiError, type TelegramBotApi } from '../telegram/bot-api.ts';
import { webhookAad, type TelegramProvisioner } from '../telegram/provisioning.ts';
import { canSeeBot, requireOwner, requirePermission, type AdminActor } from './auth.ts';

export interface BotSummary {
  botId: string;
  status: BotStatus;
  name: string;
  username: string;
  miniAppTitle: string;
  defaultLanguage: string;
  theme: BotConfig['theme'];
  tokenMasked: string | null;
  usersCount: number;
  telegram: TelegramSyncState | null;
  miniAppUrl: string;
  createdAt: string;
  logoUrl: string | null;
}

const MEDIA_MAX_BYTES = 512 * 1024;
const MIME_MAGIC: Record<string, (b: Buffer) => boolean> = {
  'image/jpeg': (b) => b[0] === 0xff && b[1] === 0xd8 && b[2] === 0xff,
  'image/png': (b) => b.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])),
  'image/webp': (b) => b.subarray(0, 4).toString('ascii') === 'RIFF' && b.subarray(8, 12).toString('ascii') === 'WEBP',
};

/** Normalizes Account Binding settings: Academy, simulator and profile can never be gated. */
function sanitizeConfig<T extends { accountBinding: BotConfig['accountBinding'] }>(c: T): T {
  return { ...c, accountBinding: { ...c.accountBinding, gatedModules: c.accountBinding.gatedModules.filter((m) => !ALWAYS_OPEN_MODULES.includes(m)) } };
}

function validationError(issues: { path: (string | number)[]; message: string }[]): AppError {
  return new AppError('VALIDATION_FAILED', 'validation failed', { fields: Object.fromEntries(issues.map((i) => [i.path.join('.'), i.message])) });
}

/**
 * Bot management from the admin panel: create (token verified with getMe,
 * encrypted, webhook + profile pushed to Telegram), edit, enable/disable/archive,
 * rotate token, upload logo/avatar. Nothing is ever hard-deleted.
 */
export class BotAdminService {
  private readonly d: {
    store: DocumentStore;
    bots: BotRepository;
    box: SecretBox;
    api: TelegramBotApi;
    provisioner: TelegramProvisioner;
    env: Env;
    logger: Logger;
    now: () => Date;
  };

  constructor(deps: BotAdminService['d']) {
    this.d = deps;
  }

  summary(bot: BotRecord, config: BotConfigRecord): BotSummary {
    return {
      botId: bot.id,
      status: bot.status,
      name: config.name,
      username: config.username,
      miniAppTitle: config.miniAppTitle,
      defaultLanguage: config.defaultLanguage,
      theme: config.theme,
      tokenMasked: bot.tokenMasked,
      usersCount: bot.usersCount ?? 0,
      telegram: bot.telegram ?? null,
      miniAppUrl: miniAppUrl(this.d.env, bot.id),
      createdAt: bot.createdAt,
      logoUrl: config.logoMediaId ? `/media/${config.logoMediaId}` : null,
    };
  }

  async list(actor: AdminActor): Promise<BotSummary[]> {
    const [bots, configs] = await Promise.all([
      this.d.store.query<BotRecord>(C.bots, {}),
      this.d.store.query<BotConfigRecord>(C.botConfigs, {}),
    ]);
    const cfg = new Map(configs.map((c) => [c.id, c.data]));
    return bots
      .filter((b) => canSeeBot(actor, b.id) && cfg.has(b.id))
      .map((b) => this.summary(b.data, cfg.get(b.id)!))
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1));
  }

  async get(actor: AdminActor, botId: string): Promise<BotSummary & { config: BotConfigRecord }> {
    if (!canSeeBot(actor, botId)) throw new AppError('FORBIDDEN');
    const { bot, config } = await this.d.bots.require(botId);
    return { ...this.summary(bot, config), config };
  }

  async create(actor: AdminActor, raw: unknown): Promise<BotSummary> {
    requireOwner(actor);
    const parsed = botCreateInputSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const { token, ...edit } = parsed.data;
    let me;
    try {
      me = await this.d.api.getMe(token);
    } catch (e) {
      if (e instanceof TelegramApiError && (e.errorCode === 401 || e.errorCode === 404)) throw new AppError('TELEGRAM_TOKEN_INVALID');
      throw new AppError('INTERNAL', `Telegram is not reachable: ${e instanceof Error ? e.message : String(e)}`);
    }
    const botId = `b${randomBytes(6).toString('hex')}`;
    const now = this.d.now().toISOString();
    const secret = newWebhookSecret();
    const config: BotConfigRecord = sanitizeConfig({ ...edit, username: me.username, avatarMediaId: null, logoMediaId: null, botId, updatedAt: now });
    await this.d.store.runTransaction(async (tx) => {
      const lock = await tx.get<{ botId: string }>(C.botTokens, String(me.id));
      if (lock) throw new AppError('BOT_ALREADY_CONNECTED', `already connected as ${lock.botId}`);
      tx.create(C.botTokens, String(me.id), { botId });
      tx.create(C.bots, botId, {
        id: botId,
        status: 'active',
        telegramBotId: me.id,
        tokenEnc: this.d.box.encrypt(token, tokenAad(botId)),
        tokenMasked: maskBotToken(token),
        webhookSecretHash: sha256Hex(secret),
        webhookSecretEnc: this.d.box.encrypt(secret, webhookAad(botId)),
        devOnly: false,
        usersCount: 0,
        telegram: { username: me.username, webhookUrl: null, syncedAt: null, issues: [] },
        createdAt: now,
        updatedAt: now,
        archivedAt: null,
      } satisfies BotRecord);
      tx.create(C.botConfigs, botId, config);
      writeAudit(tx, { botId, actor: { type: 'admin', id: actor.uid }, action: 'bot.created', target: botId, after: { name: config.name, username: me.username } }, this.d.now());
    });
    this.d.bots.invalidate(botId);
    await this.d.provisioner.sync(botId);
    const fresh = await this.d.bots.require(botId);
    return this.summary(fresh.bot, fresh.config);
  }

  async updateConfig(actor: AdminActor, botId: string, raw: unknown): Promise<BotSummary> {
    requirePermission(actor, botId, 'bot.appearance.edit');
    const parsed = botConfigEditSchema.safeParse(raw);
    if (!parsed.success) throw validationError(parsed.error.issues);
    const before = await this.d.bots.require(botId);
    const next = sanitizeConfig({ ...parsed.data });
    const now = this.d.now().toISOString();
    await this.d.store.runTransaction(async (tx) => {
      const cur = await tx.get<BotConfigRecord>(C.botConfigs, botId);
      if (!cur) throw new AppError('NOT_FOUND');
      tx.update(C.botConfigs, botId, { ...next, updatedAt: now });
      writeAudit(tx, { botId, actor: { type: 'admin', id: actor.uid }, action: 'bot.config_updated', target: botId, before: { name: cur.name, theme: cur.theme, modules: cur.modules }, after: { name: next.name, theme: next.theme, modules: next.modules } }, this.d.now());
    });
    this.d.bots.invalidate(botId);
    const c0 = before.config;
    const telegramFieldsChanged =
      c0.name !== next.name || c0.miniAppTitle !== next.miniAppTitle || JSON.stringify(c0.description) !== JSON.stringify(next.description) ||
      JSON.stringify(c0.shortDescription) !== JSON.stringify(next.shortDescription) || c0.defaultLanguage !== next.defaultLanguage;
    if (telegramFieldsChanged && before.bot.tokenEnc && !before.bot.devOnly) await this.d.provisioner.sync(botId, { webhook: false, profile: true });
    const fresh = await this.d.bots.require(botId);
    return this.summary(fresh.bot, fresh.config);
  }

  async setStatus(actor: AdminActor, botId: string, rawStatus: unknown): Promise<BotSummary> {
    const parsed = botStatusSchema.safeParse(rawStatus);
    if (!parsed.success || parsed.data === 'token_invalid') throw new AppError('VALIDATION_FAILED', 'status must be active, disabled or archived');
    const status = parsed.data;
    if (status === 'archived') requireOwner(actor);
    else requirePermission(actor, botId, 'bot.status.toggle');
    const now = this.d.now();
    await this.d.store.runTransaction(async (tx) => {
      const bot = await tx.get<BotRecord>(C.bots, botId);
      if (!bot) throw new AppError('NOT_FOUND');
      tx.update(C.bots, botId, { status, updatedAt: now.toISOString(), archivedAt: status === 'archived' ? now.toISOString() : null });
      writeAudit(tx, { botId, actor: { type: 'admin', id: actor.uid }, action: 'bot.status_changed', target: botId, before: { status: bot.status }, after: { status } }, now);
    });
    this.d.bots.invalidate(botId);
    const fresh = await this.d.bots.require(botId);
    return this.summary(fresh.bot, fresh.config);
  }

  /** Replaces the token after it was revoked in BotFather. Must belong to the same Telegram bot. */
  async rotateToken(actor: AdminActor, botId: string, token: unknown): Promise<BotSummary> {
    requireOwner(actor);
    const parsed = botCreateInputSchema.shape.token.safeParse(token);
    if (!parsed.success) throw new AppError('TELEGRAM_TOKEN_INVALID');
    const { bot } = await this.d.bots.require(botId);
    let me;
    try {
      me = await this.d.api.getMe(parsed.data);
    } catch {
      throw new AppError('TELEGRAM_TOKEN_INVALID');
    }
    if (bot.telegramBotId !== null && me.id !== bot.telegramBotId) throw new AppError('VALIDATION_FAILED', 'this token belongs to a different Telegram bot');
    await this.d.store.runTransaction(async (tx) => {
      tx.update(C.bots, botId, {
        tokenEnc: this.d.box.encrypt(parsed.data, tokenAad(botId)),
        tokenMasked: maskBotToken(parsed.data),
        status: bot.status === 'token_invalid' ? 'active' : bot.status,
        updatedAt: this.d.now().toISOString(),
      });
      writeAudit(tx, { botId, actor: { type: 'admin', id: actor.uid }, action: 'bot.token_rotated', target: botId }, this.d.now());
    });
    this.d.bots.invalidate(botId);
    await this.d.provisioner.sync(botId);
    const fresh = await this.d.bots.require(botId);
    return this.summary(fresh.bot, fresh.config);
  }

  async resync(actor: AdminActor, botId: string): Promise<TelegramSyncState> {
    requirePermission(actor, botId, 'bot.appearance.edit');
    return this.d.provisioner.sync(botId);
  }

  /** Logo (Mini App header) or avatar (Telegram profile photo, JPEG only). */
  async uploadMedia(actor: AdminActor, botId: string, raw: unknown): Promise<BotSummary> {
    requirePermission(actor, botId, 'bot.appearance.edit');
    const body = raw as { kind?: unknown; mime?: unknown; data?: unknown };
    const kind = body.kind === 'avatar' ? 'avatar' : body.kind === 'logo' ? 'logo' : null;
    if (!kind || typeof body.mime !== 'string' || typeof body.data !== 'string') throw new AppError('VALIDATION_FAILED', 'kind, mime and data are required');
    const buf = Buffer.from(body.data, 'base64');
    if (!buf.length || buf.length > MEDIA_MAX_BYTES) throw new AppError('VALIDATION_FAILED', 'image must be 1 byte – 512 KB');
    const check = MIME_MAGIC[body.mime];
    if (!check || !check(buf)) throw new AppError('VALIDATION_FAILED', 'unsupported or mismatching image type (PNG, JPEG or WebP)');
    if (kind === 'avatar' && body.mime !== 'image/jpeg') throw new AppError('VALIDATION_FAILED', 'Telegram profile photos must be JPEG');

    const bundle = await this.d.bots.require(botId);
    if (kind === 'avatar') {
      try {
        await this.d.api.setMyProfilePhoto(this.d.bots.decryptToken(bundle), buf);
      } catch (e) {
        throw new AppError('VALIDATION_FAILED', `Telegram rejected the photo: ${e instanceof Error ? e.message : String(e)}`);
      }
    }
    const mediaId = `m${newId().replace(/[^A-Za-z0-9]/g, '')}`;
    const now = this.d.now().toISOString();
    await this.d.store.runTransaction(async (tx) => {
      tx.create(C.media, mediaId, { botId, kind, mime: body.mime, size: buf.length, data: buf.toString('base64'), createdAt: now });
      tx.update(C.botConfigs, botId, { [kind === 'logo' ? 'logoMediaId' : 'avatarMediaId']: mediaId, updatedAt: now });
      writeAudit(tx, { botId, actor: { type: 'admin', id: actor.uid }, action: `bot.${kind}_uploaded`, target: mediaId }, this.d.now());
    });
    this.d.bots.invalidate(botId);
    const fresh = await this.d.bots.require(botId);
    return this.summary(fresh.bot, fresh.config);
  }
}
