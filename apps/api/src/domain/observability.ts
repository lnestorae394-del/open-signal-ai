import { sha256Hex } from '../lib/crypto.ts';
import type { Logger } from '../lib/logger.ts';
import { C } from '../storage/collections.ts';
import { increment, type DocumentStore } from '../storage/types.ts';

/**
 * Per-bot error log with fingerprinting: identical errors collapse into one
 * document with a counter instead of thousands of writes (Firestore quota).
 */
export class ErrorLog {
  private readonly store: DocumentStore;
  private readonly logger: Logger;

  constructor(store: DocumentStore, logger: Logger) {
    this.store = store;
    this.logger = logger;
  }

  async record(botId: string | null, module: string, code: string, message: string, now = new Date()): Promise<void> {
    const firstLine = message.split('\n')[0]!.slice(0, 300);
    const fingerprint = sha256Hex(`${module}|${code}|${firstLine}`).slice(0, 20);
    const id = `${botId ?? 'platform'}_${fingerprint}`;
    try {
      await this.store.runTransaction(async (tx) => {
        const existing = await tx.get(C.errorLogs, id);
        if (existing) {
          tx.update(C.errorLogs, id, { count: increment(1), lastSeenAt: now.toISOString() });
        } else {
          tx.create(C.errorLogs, id, {
            botId,
            module,
            code,
            message: firstLine,
            count: 1,
            firstSeenAt: now.toISOString(),
            lastSeenAt: now.toISOString(),
          });
        }
      });
    } catch (e) {
      // Logging must never break a request.
      this.logger.error('error_log.write_failed', { err: e, botId, module });
    }
  }
}

/**
 * Activity counters buffered in memory and flushed in batches
 * (one write per bot per day per flush) — never one write per event.
 */
export class StatsBuffer {
  private pending = new Map<string, Map<string, number>>(); // docId → metric → n
  private readonly store: DocumentStore;
  private readonly logger: Logger;
  private timer: NodeJS.Timeout | null = null;
  private readonly clock: () => Date;

  constructor(store: DocumentStore, logger: Logger, clock: () => Date = () => new Date()) {
    this.store = store;
    this.logger = logger;
    this.clock = clock;
  }

  incr(botId: string, metric: string, by = 1, now = this.clock()): void {
    const day = now.toISOString().slice(0, 10);
    const id = `${botId}_${day}`;
    let m = this.pending.get(id);
    if (!m) {
      m = new Map();
      this.pending.set(id, m);
    }
    m.set(metric, (m.get(metric) ?? 0) + by);
  }

  start(intervalMs = 60_000): void {
    this.timer ??= setInterval(() => void this.flush(), intervalMs);
    this.timer.unref?.();
  }

  async flush(): Promise<void> {
    const batch = this.pending;
    this.pending = new Map();
    for (const [id, metrics] of batch) {
      const [botId, day] = [id.slice(0, id.lastIndexOf('_')), id.slice(id.lastIndexOf('_') + 1)];
      const data: Record<string, unknown> = { botId, day };
      for (const [k, v] of metrics) data[`m_${k}`] = increment(v);
      try {
        await this.store.set(C.botStatsDaily, id, data, { merge: true });
      } catch (e) {
        this.logger.error('stats.flush_failed', { err: e, id });
      }
    }
  }

  async stop(): Promise<void> {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    await this.flush();
  }
}
