import { AppError } from '../../lib/errors.ts';
import type { Logger } from '../../lib/logger.ts';
import {
  isIncrement,
  type DocData,
  type DocumentStore,
  type Filter,
  type QueryOptions,
  type SetOptions,
  type StoredDoc,
  type Transaction,
} from '../types.ts';
import { decodeFields, encodeFields, encodeValue, fieldPath, type FsFields } from './codec.ts';
import type { TokenProvider } from './auth.ts';

/**
 * Firestore adapter over the official REST API v1
 * (https://firebase.google.com/docs/firestore/reference/rest).
 * Implements the same DocumentStore contract as the local adapter:
 *  create → precondition exists:false (ALREADY_EXISTS),
 *  update → precondition exists:true  (NOT_FOUND),
 *  increment → FieldTransform.increment,
 *  runTransaction → beginTransaction / reads with transaction / commit, retried on ABORTED.
 */
export interface FirestoreOptions {
  projectId: string;
  tokens: TokenProvider;
  /** e.g. "https://firestore.googleapis.com" or "http://127.0.0.1:8085" (emulator). */
  baseUrl?: string;
  databaseId?: string;
  fetchImpl?: typeof fetch;
  logger?: Logger;
  maxTxAttempts?: number;
}

interface FsDocument {
  name: string;
  fields?: FsFields;
}

type Write = Record<string, unknown>;

export class FirestoreError extends Error {
  readonly httpStatus: number;
  readonly status: string;
  constructor(httpStatus: number, status: string, message: string) {
    super(message);
    this.name = 'FirestoreError';
    this.httpStatus = httpStatus;
    this.status = status;
  }
}

export class FirestoreDocumentStore implements DocumentStore {
  readonly kind = 'firestore' as const;
  readonly projectId: string;
  private readonly root: string;
  private readonly docsUrl: string;
  private readonly tokens: TokenProvider;
  private readonly fetchImpl: typeof fetch;
  private readonly logger: Logger | undefined;
  private readonly maxTxAttempts: number;

  constructor(o: FirestoreOptions) {
    this.projectId = o.projectId;
    this.root = `projects/${o.projectId}/databases/${o.databaseId ?? '(default)'}/documents`;
    this.docsUrl = `${(o.baseUrl ?? 'https://firestore.googleapis.com').replace(/\/$/, '')}/v1/${this.root}`;
    this.tokens = o.tokens;
    this.fetchImpl = o.fetchImpl ?? fetch;
    this.logger = o.logger;
    this.maxTxAttempts = o.maxTxAttempts ?? 5;
  }

  // ───────── DocumentStore ─────────

  get<T extends DocData>(collection: string, id: string): Promise<T | null> {
    return this.readDoc<T>(collection, id, null);
  }

  query<T extends DocData>(collection: string, options?: QueryOptions): Promise<StoredDoc<T>[]> {
    return this.runQuery<T>(collection, options ?? {}, null);
  }

  async create(collection: string, id: string, data: DocData): Promise<void> {
    await this.commit([this.write(collection, id, data, 'create')], null);
  }

  async set(collection: string, id: string, data: DocData, options?: SetOptions): Promise<void> {
    await this.commit([this.write(collection, id, data, options?.merge ? 'merge' : 'set')], null);
  }

  async update(collection: string, id: string, patch: DocData): Promise<void> {
    await this.commit([this.write(collection, id, patch, 'update')], null);
  }

  async delete(collection: string, id: string): Promise<void> {
    await this.commit([{ delete: this.name(collection, id) }], null);
  }

  async runTransaction<R>(fn: (tx: Transaction) => Promise<R>): Promise<R> {
    let previous: string | null = null;
    for (let attempt = 1; ; attempt++) {
      const begin: { transaction: string } = await this.call('POST', `${this.docsUrl}:beginTransaction`, {
        options: { readWrite: previous ? { retryTransaction: previous } : {} },
      });
      const txId = begin.transaction;
      const writes: Write[] = [];
      let wrote = false;
      const guard = () => {
        if (wrote) throw new Error('Transaction reads must happen before writes (Firestore rule)');
      };
      const tx: Transaction = {
        get: async <T extends DocData>(c: string, i: string) => {
          guard();
          return this.readDoc<T>(c, i, txId);
        },
        query: async <T extends DocData>(c: string, o?: QueryOptions) => {
          guard();
          return this.runQuery<T>(c, o ?? {}, txId);
        },
        create: (c, i, d) => {
          wrote = true;
          writes.push(this.write(c, i, d, 'create'));
        },
        set: (c, i, d, o) => {
          wrote = true;
          writes.push(this.write(c, i, d, o?.merge ? 'merge' : 'set'));
        },
        update: (c, i, p) => {
          wrote = true;
          writes.push(this.write(c, i, p, 'update'));
        },
        delete: (c, i) => {
          wrote = true;
          writes.push({ delete: this.name(c, i) });
        },
      };

      let result: R;
      try {
        result = await fn(tx);
      } catch (e) {
        await this.call('POST', `${this.docsUrl}:rollback`, { transaction: txId }).catch(() => undefined);
        throw e;
      }
      try {
        await this.commit(writes, txId);
        return result;
      } catch (e) {
        if (e instanceof FirestoreError && e.status === 'ABORTED' && attempt < this.maxTxAttempts) {
          previous = txId;
          this.logger?.warn('firestore.tx_retry', { attempt });
          await new Promise((r) => setTimeout(r, 25 * 2 ** attempt + Math.random() * 25));
          continue;
        }
        throw e;
      }
    }
  }

  async flush(): Promise<void> {}
  async close(): Promise<void> {}

  /** Cheap connectivity + permission probe (one read). */
  async probe(): Promise<void> {
    await this.readDoc('_system', 'probe', null);
  }

  // ───────── internals ─────────

  private name(collection: string, id: string): string {
    if (!id || id.includes('/')) throw new Error(`Invalid document id: ${id}`);
    return `${this.root}/${collection}/${id}`;
  }

  private write(collection: string, id: string, data: DocData, mode: 'create' | 'set' | 'merge' | 'update'): Write {
    const plain: DocData = {};
    const transforms: Record<string, unknown>[] = [];
    for (const [k, v] of Object.entries(data)) {
      if (v === undefined) continue;
      if (isIncrement(v)) transforms.push({ fieldPath: fieldPath(k), increment: encodeValue(v.by) });
      else plain[k] = v;
    }
    const w: Write = { update: { name: this.name(collection, id), fields: encodeFields(plain) } };
    if (mode === 'merge' || mode === 'update') w['updateMask'] = { fieldPaths: Object.keys(plain).map(fieldPath) };
    if (mode === 'create') w['currentDocument'] = { exists: false };
    if (mode === 'update') w['currentDocument'] = { exists: true };
    if (transforms.length) w['updateTransforms'] = transforms;
    return w;
  }

  private async readDoc<T extends DocData>(collection: string, id: string, txId: string | null): Promise<T | null> {
    const url = `${this.docsUrl}/${collection}/${encodeURIComponent(id)}${txId ? `?transaction=${encodeURIComponent(txId)}` : ''}`;
    try {
      const doc: FsDocument = await this.call('GET', url);
      return decodeFields(doc.fields ?? {}) as T;
    } catch (e) {
      if (e instanceof FirestoreError && e.status === 'NOT_FOUND') return null;
      throw e;
    }
  }

  private async runQuery<T extends DocData>(collection: string, o: QueryOptions, txId: string | null): Promise<StoredDoc<T>[]> {
    const sq: Record<string, unknown> = { from: [{ collectionId: collection }] };
    const filters = (o.where ?? []).map(encodeFilter);
    if (filters.length === 1) sq['where'] = filters[0];
    else if (filters.length > 1) sq['where'] = { compositeFilter: { op: 'AND', filters } };
    if (o.orderBy) sq['orderBy'] = [{ field: { fieldPath: fieldPath(o.orderBy.field) }, direction: o.orderBy.direction === 'desc' ? 'DESCENDING' : 'ASCENDING' }];
    if (o.limit !== undefined) sq['limit'] = o.limit;
    const rows: { document?: FsDocument }[] = await this.call('POST', `${this.docsUrl}:runQuery`, {
      structuredQuery: sq,
      ...(txId ? { transaction: txId } : {}),
    });
    return rows
      .filter((r): r is { document: FsDocument } => Boolean(r.document))
      .map((r) => ({ id: r.document.name.slice(r.document.name.lastIndexOf('/') + 1), data: decodeFields(r.document.fields ?? {}) as T }));
  }

  private async commit(writes: Write[], txId: string | null): Promise<void> {
    if (!writes.length && !txId) return;
    try {
      await this.call('POST', `${this.docsUrl}:commit`, { writes, ...(txId ? { transaction: txId } : {}) });
    } catch (e) {
      if (e instanceof FirestoreError && e.status === 'ALREADY_EXISTS') throw new AppError('ALREADY_EXISTS', e.message);
      if (e instanceof FirestoreError && e.status === 'NOT_FOUND') throw new AppError('NOT_FOUND', e.message);
      throw e;
    }
  }

  private async call<T>(method: string, url: string, body?: unknown): Promise<T> {
    const token = await this.tokens.getToken();
    // Only side-effect-free calls are retried; a commit is never blindly replayed.
    const idempotent = method === 'GET' || url.endsWith(':runQuery') || url.endsWith(':beginTransaction') || url.endsWith(':rollback');
    const maxAttempts = idempotent ? 3 : 1;
    let lastErr: unknown;
    for (let attempt = 1; attempt <= maxAttempts; attempt++) {
      let res: Response;
      try {
        res = await this.fetchImpl(url, {
          method,
          headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : { authorization: 'Bearer owner' }) },
          ...(body === undefined ? {} : { body: JSON.stringify(body) }),
          signal: AbortSignal.timeout(15_000),
        });
      } catch (e) {
        lastErr = e; // network error → retry only idempotent calls
        if (attempt < maxAttempts) await new Promise((r) => setTimeout(r, 100 * attempt));
        continue;
      }
      const text = await res.text();
      const json = text ? (JSON.parse(text) as unknown) : {};
      if (res.ok) return json as T;
      const err = (json as { error?: { status?: string; message?: string } }).error ?? {};
      const fe = new FirestoreError(res.status, err.status ?? String(res.status), err.message ?? `Firestore HTTP ${res.status}`);
      if ((res.status === 503 || res.status === 500) && attempt < maxAttempts) {
        lastErr = fe;
        await new Promise((r) => setTimeout(r, 150 * attempt));
        continue;
      }
      if (fe.status === 'FAILED_PRECONDITION' && /index/i.test(fe.message)) {
        this.logger?.error('firestore.index_missing', { message: fe.message });
      }
      throw fe;
    }
    throw lastErr instanceof Error ? lastErr : new Error('Firestore request failed');
  }
}

const OPS: Record<Filter['op'], string> = {
  '==': 'EQUAL',
  '!=': 'NOT_EQUAL',
  in: 'IN',
  '<': 'LESS_THAN',
  '<=': 'LESS_THAN_OR_EQUAL',
  '>': 'GREATER_THAN',
  '>=': 'GREATER_THAN_OR_EQUAL',
  'array-contains': 'ARRAY_CONTAINS',
};

function encodeFilter(f: Filter): Record<string, unknown> {
  return { fieldFilter: { field: { fieldPath: fieldPath(f.field) }, op: OPS[f.op], value: encodeValue(f.value) } };
}
