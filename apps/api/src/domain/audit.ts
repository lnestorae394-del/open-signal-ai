import { redact } from '../lib/logger.ts';
import { newId } from '../lib/ids.ts';
import { C } from '../storage/collections.ts';
import type { Transaction } from '../storage/types.ts';

export interface AuditActor {
  type: 'admin' | 'system';
  id: string;
}

export interface AuditEntry {
  botId: string | null;
  actor: AuditActor;
  action: string;
  target: string;
  reason?: string;
  before?: unknown;
  after?: unknown;
}

/** Writes an audit record inside the same transaction as the change it describes. */
export function writeAudit(tx: Transaction, entry: AuditEntry, now: Date): string {
  const id = newId();
  tx.create(C.auditLogs, id, {
    botId: entry.botId,
    actor: entry.actor,
    action: entry.action,
    target: entry.target,
    reason: entry.reason ?? null,
    before: entry.before === undefined ? null : redact(entry.before),
    after: entry.after === undefined ? null : redact(entry.after),
    at: now.toISOString(),
  });
  return id;
}
