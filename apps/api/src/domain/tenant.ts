import type { Filter } from '../storage/types.ts';

/**
 * Tenant isolation. Every per-bot document carries `botId`, and every per-bot
 * document id is prefixed with it. Domain code never builds ids or filters by
 * hand — it goes through a TenantScope, so a query without the botId filter
 * cannot be written by accident. The botId always comes from the URL + a
 * verified session/webhook secret, never from the request body.
 */
export class TenantScope {
  readonly botId: string;

  constructor(botId: string) {
    if (!/^[A-Za-z0-9_-]{4,40}$/.test(botId)) throw new Error('Invalid botId');
    this.botId = botId;
  }

  /** users/{botId}_{telegramId} */
  userDocId(telegramId: number): string {
    return `${this.botId}_${telegramId}`;
  }

  /** Builds the mandatory tenant filter plus extra filters. */
  where(...extra: Filter[]): Filter[] {
    return [{ field: 'botId', op: '==', value: this.botId }, ...extra];
  }

  /** Adds botId to a document being written. */
  stamp<T extends Record<string, unknown>>(data: T): T & { botId: string } {
    return { ...data, botId: this.botId };
  }

  owns(doc: { botId?: unknown } | null | undefined): boolean {
    return Boolean(doc) && doc!.botId === this.botId;
  }
}
