import { isLang } from '@open-signal/i18n';
import { findInstrument } from '@open-signal/shared';
import { AppError } from '../lib/errors.ts';
import { C } from '../storage/collections.ts';
import { increment, type DocumentStore } from '../storage/types.ts';
import type { TelegramUser } from '../telegram/init-data.ts';
import type { TenantScope } from './tenant.ts';
import type { UserRecord, UserSettingsRecord } from './records.ts';

/**
 * Users are identified by Telegram ID only (no email/password). The first
 * verified launch creates the profile; later launches return the same profile.
 */
export class UserService {
  private readonly store: DocumentStore;

  constructor(store: DocumentStore) {
    this.store = store;
  }

  async upsertFromTelegram(scope: TenantScope, tg: TelegramUser, now: Date): Promise<{ user: UserRecord; created: boolean }> {
    const id = scope.userDocId(tg.id);
    return this.store.runTransaction(async (tx) => {
      const existing = await tx.get<UserRecord>(C.users, id);
      const profile = {
        username: tg.username ?? null,
        firstName: tg.first_name.slice(0, 128),
        lastName: tg.last_name?.slice(0, 128) ?? null,
        languageCode: tg.language_code?.slice(0, 16) ?? null,
        isPremium: Boolean(tg.is_premium),
        lastSeenAt: now.toISOString(),
      };
      if (existing) {
        tx.update(C.users, id, { ...profile, launches: increment(1) });
        return { user: { ...existing, ...profile, launches: existing.launches + 1 }, created: false };
      }
      const user: UserRecord = scope.stamp({
        telegramId: tg.id,
        ...profile,
        createdAt: now.toISOString(),
        launches: 1,
        bindingState: 'telegram_created' as const,
        bindingUpdatedAt: now.toISOString(),
        traderId: null,
        verifiedTraderIdHash: null,
        mismatchAttempts: 0,
        lastRecheckAt: null,
      });
      tx.create(C.users, id, user);
      tx.update(C.bots, scope.botId, { usersCount: increment(1) });
      return { user, created: true };
    });
  }

  async get(scope: TenantScope, telegramId: number): Promise<UserRecord> {
    const u = await this.store.get<UserRecord>(C.users, scope.userDocId(telegramId));
    if (!u || !scope.owns(u)) throw new AppError('UNAUTHORIZED', 'user not found for this bot');
    return u;
  }

  async getSettings(scope: TenantScope, telegramId: number): Promise<UserSettingsRecord> {
    const s = await this.store.get<UserSettingsRecord>(C.userSettings, scope.userDocId(telegramId));
    return s ?? scope.stamp({ language: null, favorites: [], analysisMode: 'BASIC' as const, updatedAt: '' });
  }

  async updateSettings(
    scope: TenantScope,
    telegramId: number,
    patch: { language?: unknown; favorites?: unknown; analysisMode?: unknown },
    now: Date,
  ): Promise<UserSettingsRecord> {
    const current = await this.getSettings(scope, telegramId);
    const next: UserSettingsRecord = { ...current, updatedAt: now.toISOString() };
    if (patch.language !== undefined) {
      if (patch.language !== null && !isLang(patch.language)) throw new AppError('BAD_REQUEST', 'unsupported language');
      next.language = patch.language as UserSettingsRecord['language'];
    }
    if (patch.favorites !== undefined) {
      if (!Array.isArray(patch.favorites) || patch.favorites.length > 50) throw new AppError('BAD_REQUEST', 'favorites invalid');
      const ids = [...new Set(patch.favorites.map(String))];
      if (ids.some((i) => !findInstrument(i))) throw new AppError('BAD_REQUEST', 'unknown instrument');
      next.favorites = ids;
    }
    if (patch.analysisMode !== undefined) {
      if (patch.analysisMode !== 'BASIC' && patch.analysisMode !== 'FULL') throw new AppError('BAD_REQUEST', 'analysisMode invalid');
      next.analysisMode = patch.analysisMode;
    }
    await this.store.set(C.userSettings, scope.userDocId(telegramId), scope.stamp(next));
    return next;
  }
}
