import { DEFAULT_SIGNAL_SETTINGS, signalSettingsSchema, type SignalSettings } from '@open-signal/shared';
import { AppError } from '../lib/errors.ts';
import { C } from '../storage/collections.ts';
import type { DocumentStore } from '../storage/types.ts';
import { writeAudit } from '../domain/audit.ts';
import { requireOwner, type AdminActor } from '../admin/auth.ts';

const SIGNALS_DOC = 'signals';
const CACHE_MS = 10_000;

/** Platform-wide settings shared by every bot (one signal system for all). */
export class PlatformSettings {
  private readonly store: DocumentStore;
  private readonly now: () => Date;
  private cache: { at: number; value: SignalSettings } | null = null;

  constructor(deps: { store: DocumentStore; now: () => Date }) {
    this.store = deps.store;
    this.now = deps.now;
  }

  async signals(): Promise<SignalSettings> {
    const t = this.now().getTime();
    if (this.cache && t - this.cache.at < CACHE_MS) return this.cache.value;
    const raw = await this.store.get<Record<string, unknown>>(C.platformSettings, SIGNALS_DOC);
    const parsed = raw ? signalSettingsSchema.safeParse({ ...DEFAULT_SIGNAL_SETTINGS, ...raw }) : null;
    const value = parsed?.success ? parsed.data : DEFAULT_SIGNAL_SETTINGS;
    this.cache = { at: t, value };
    return value;
  }

  async updateSignals(actor: AdminActor, raw: unknown): Promise<SignalSettings> {
    requireOwner(actor);
    const parsed = signalSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      const fields: Record<string, string> = {};
      for (const i of parsed.error.issues) fields[i.path.join('.') || 'form'] = i.message;
      throw new AppError('VALIDATION_FAILED', 'invalid signal settings', { fields });
    }
    const before = await this.signals();
    const now = this.now();
    await this.store.runTransaction(async (tx) => {
      tx.set(C.platformSettings, SIGNALS_DOC, { ...parsed.data, updatedAt: now.toISOString() });
      writeAudit(tx, { botId: 'global', actor: { type: 'admin', id: actor.uid }, action: 'settings.signals_updated', target: SIGNALS_DOC, before, after: parsed.data }, now);
    });
    this.cache = null;
    return parsed.data;
  }
}
