import { readFileSync } from 'node:fs';
import type { Logger } from '../../lib/logger.ts';
import type { TokenProvider } from './auth.ts';

/**
 * Creates the composite indexes and TTL policy from firebase/firestore.indexes.json
 * through the Firestore Admin REST API at startup — so no Firebase CLI is needed.
 * Idempotent: existing indexes are skipped. If the service account lacks the
 * permission, the status says so (shown in the admin dashboard) instead of failing silently.
 */
interface IndexField {
  fieldPath: string;
  order?: 'ASCENDING' | 'DESCENDING';
}
interface IndexSpec {
  collectionGroup: string;
  queryScope: string;
  fields: IndexField[];
}
interface IndexFile {
  indexes: IndexSpec[];
  fieldOverrides?: { collectionGroup: string; fieldPath: string; ttl?: boolean }[];
}

export interface IndexStatus {
  checkedAt: string | null;
  total: number;
  ready: number;
  building: number;
  created: number;
  ttlConfigured: boolean;
  error: string | null;
}

export function loadIndexFile(): IndexFile {
  const url = new URL('../../../../../firebase/firestore.indexes.json', import.meta.url);
  return JSON.parse(readFileSync(url, 'utf8')) as IndexFile;
}

const key = (fields: IndexField[]) =>
  fields
    .filter((f) => f.fieldPath !== '__name__')
    .map((f) => `${f.fieldPath}:${f.order ?? 'ASCENDING'}`)
    .join(',');

export async function ensureIndexes(opts: {
  projectId: string;
  tokens: TokenProvider;
  logger: Logger;
  baseUrl?: string;
  fetchImpl?: typeof fetch;
  file?: IndexFile;
}): Promise<IndexStatus> {
  const file = opts.file ?? loadIndexFile();
  const f = opts.fetchImpl ?? fetch;
  const base = `${(opts.baseUrl ?? 'https://firestore.googleapis.com').replace(/\/$/, '')}/v1/projects/${opts.projectId}/databases/(default)/collectionGroups`;
  const status: IndexStatus = { checkedAt: new Date().toISOString(), total: file.indexes.length, ready: 0, building: 0, created: 0, ttlConfigured: false, error: null };
  const token = await opts.tokens.getToken();
  const headers = { 'content-type': 'application/json', authorization: `Bearer ${token ?? 'owner'}` };

  try {
    const groups = [...new Set(file.indexes.map((i) => i.collectionGroup))];
    const existing = new Map<string, string>(); // `${group}|${key}` → state
    for (const g of groups) {
      const res = await f(`${base}/${g}/indexes`, { headers, signal: AbortSignal.timeout(15_000) });
      if (!res.ok) throw new Error(`list indexes ${g}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      const body = (await res.json()) as { indexes?: { fields: IndexField[]; state: string; queryScope: string }[] };
      for (const ix of body.indexes ?? []) existing.set(`${g}|${ix.queryScope}|${key(ix.fields)}`, ix.state);
    }
    for (const ix of file.indexes) {
      const state = existing.get(`${ix.collectionGroup}|${ix.queryScope}|${key(ix.fields)}`);
      if (state === 'READY') {
        status.ready++;
        continue;
      }
      if (state) {
        status.building++;
        continue;
      }
      const res = await f(`${base}/${ix.collectionGroup}/indexes`, {
        method: 'POST',
        headers,
        body: JSON.stringify({ queryScope: ix.queryScope, fields: ix.fields }),
        signal: AbortSignal.timeout(15_000),
      });
      if (res.ok || res.status === 409) {
        status.created++;
        status.building++;
      } else {
        throw new Error(`create index ${ix.collectionGroup}: HTTP ${res.status} ${(await res.text()).slice(0, 200)}`);
      }
    }
    for (const o of file.fieldOverrides ?? []) {
      if (!o.ttl) continue;
      const res = await f(`${base}/${o.collectionGroup}/fields/${o.fieldPath}?updateMask=ttlConfig`, {
        method: 'PATCH',
        headers,
        body: JSON.stringify({ ttlConfig: {} }),
        signal: AbortSignal.timeout(15_000),
      });
      status.ttlConfigured = res.ok;
    }
    opts.logger.info('firestore.indexes', { ...status });
  } catch (e) {
    status.error = e instanceof Error ? e.message : String(e);
    opts.logger.error('firestore.indexes_failed', { error: status.error });
  }
  return status;
}
