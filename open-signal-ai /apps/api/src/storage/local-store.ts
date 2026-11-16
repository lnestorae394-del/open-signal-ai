import { mkdirSync, readFileSync, renameSync, writeFileSync, existsSync } from 'node:fs';
import { dirname } from 'node:path';
import { AppError } from '../lib/errors.ts';
import {
  isIncrement,
  type DocData,
  type DocumentStore,
  type Filter,
  type QueryOptions,
  type SetOptions,
  type StoredDoc,
  type Transaction,
} from './types.ts';

/**
 * Local development adapter: in-memory collections persisted to one JSON file
 * with atomic writes (write to temp file, then rename). Single process only.
 * All operations are serialized through one queue, which makes transactions
 * serializable — the same guarantee Firestore transactions give.
 */
export class LocalDocumentStore implements DocumentStore {
  readonly kind: 'local' | 'memory';
  private data = new Map<string, Map<string, DocData>>();
  private queue: Promise<unknown> = Promise.resolve();
  private dirty = false;
  private saveTimer: NodeJS.Timeout | null = null;
  private readonly filePath: string | null;

  /** @param filePath JSON file for persistence; `null` keeps data in memory only (tests). */
  constructor(filePath: string | null) {
    this.filePath = filePath;
    this.kind = filePath ? 'local' : 'memory';
    if (filePath && existsSync(filePath)) {
      const raw = JSON.parse(readFileSync(filePath, 'utf8')) as Record<string, Record<string, DocData>>;
      for (const [col, docs] of Object.entries(raw)) this.data.set(col, new Map(Object.entries(docs)));
    }
  }

  // ───────── public API (serialized) ─────────

  get<T extends DocData>(collection: string, id: string): Promise<T | null> {
    return this.enqueue(() => this.readDoc<T>(collection, id));
  }

  query<T extends DocData>(collection: string, options?: QueryOptions): Promise<StoredDoc<T>[]> {
    return this.enqueue(() => this.readQuery<T>(collection, options));
  }

  create(collection: string, id: string, data: DocData): Promise<void> {
    return this.runTransaction(async (tx) => tx.create(collection, id, data));
  }

  set(collection: string, id: string, data: DocData, options?: SetOptions): Promise<void> {
    return this.runTransaction(async (tx) => tx.set(collection, id, data, options));
  }

  update(collection: string, id: string, patch: DocData): Promise<void> {
    return this.runTransaction(async (tx) => tx.update(collection, id, patch));
  }

  delete(collection: string, id: string): Promise<void> {
    return this.runTransaction(async (tx) => tx.delete(collection, id));
  }

  runTransaction<R>(fn: (tx: Transaction) => Promise<R>): Promise<R> {
    return this.enqueue(async () => {
      const ops: Array<() => void> = [];
      const staged = new Map<string, DocData | null>(); // key "col/id" → state after staged ops
      let wrote = false;
      const key = (c: string, i: string) => `${c}/${i}`;
      const current = (c: string, i: string): DocData | null =>
        staged.has(key(c, i)) ? (staged.get(key(c, i)) ?? null) : (this.data.get(c)?.get(i) ?? null);
      const readGuard = () => {
        if (wrote) throw new Error('Transaction reads must happen before writes (Firestore rule)');
      };

      const tx: Transaction = {
        get: async <T extends DocData>(c: string, i: string) => {
          readGuard();
          return this.readDoc<T>(c, i);
        },
        query: async <T extends DocData>(c: string, o?: QueryOptions) => {
          readGuard();
          return this.readQuery<T>(c, o);
        },
        create: (c, i, d) => {
          wrote = true;
          if (current(c, i)) throw new AppError('ALREADY_EXISTS', `${c}/${i} already exists`);
          const doc = applyWrite(null, d, false);
          staged.set(key(c, i), doc);
          ops.push(() => this.col(c).set(i, doc));
        },
        set: (c, i, d, o) => {
          wrote = true;
          const doc = applyWrite(o?.merge ? current(c, i) : null, d, Boolean(o?.merge));
          staged.set(key(c, i), doc);
          ops.push(() => this.col(c).set(i, doc));
        },
        update: (c, i, p) => {
          wrote = true;
          const existing = current(c, i);
          if (!existing) throw new AppError('NOT_FOUND', `${c}/${i} not found`);
          const doc = applyWrite(existing, p, true);
          staged.set(key(c, i), doc);
          ops.push(() => this.col(c).set(i, doc));
        },
        delete: (c, i) => {
          wrote = true;
          staged.set(key(c, i), null);
          ops.push(() => this.col(c).delete(i));
        },
      };

      const result = await fn(tx);
      for (const op of ops) op(); // commit atomically (no await between ops)
      if (ops.length) this.markDirty();
      return result;
    });
  }

  async flush(): Promise<void> {
    await this.enqueue(async () => this.saveNow());
  }

  async close(): Promise<void> {
    if (this.saveTimer) clearTimeout(this.saveTimer);
    await this.flush();
  }

  // ───────── internals ─────────

  private enqueue<R>(task: () => R | Promise<R>): Promise<R> {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => undefined);
    return run;
  }

  private col(name: string): Map<string, DocData> {
    let c = this.data.get(name);
    if (!c) {
      c = new Map();
      this.data.set(name, c);
    }
    return c;
  }

  private readDoc<T extends DocData>(collection: string, id: string): T | null {
    const d = this.data.get(collection)?.get(id);
    return d ? (structuredClone(d) as T) : null;
  }

  private readQuery<T extends DocData>(collection: string, options: QueryOptions = {}): StoredDoc<T>[] {
    const docs = [...(this.data.get(collection)?.entries() ?? [])]
      .filter(([, d]) => (options.where ?? []).every((f) => matches(d, f)))
      .map(([id, d]) => ({ id, data: structuredClone(d) as T }));
    if (options.orderBy) {
      const { field, direction = 'asc' } = options.orderBy;
      const sign = direction === 'asc' ? 1 : -1;
      docs.sort((a, b) => compare(getPath(a.data, field), getPath(b.data, field)) * sign);
    }
    return options.limit !== undefined ? docs.slice(0, options.limit) : docs;
  }

  private markDirty(): void {
    if (!this.filePath) return;
    this.dirty = true;
    if (!this.saveTimer) {
      this.saveTimer = setTimeout(() => {
        this.saveTimer = null;
        void this.enqueue(async () => this.saveNow());
      }, 50);
      this.saveTimer.unref?.();
    }
  }

  private saveNow(): void {
    if (!this.filePath || !this.dirty) return;
    const out: Record<string, Record<string, DocData>> = {};
    for (const [col, docs] of this.data) out[col] = Object.fromEntries(docs);
    mkdirSync(dirname(this.filePath), { recursive: true });
    const tmp = `${this.filePath}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(out), { mode: 0o600 });
    renameSync(tmp, this.filePath);
    this.dirty = false;
  }
}

function applyWrite(existing: DocData | null, input: DocData, merge: boolean): DocData {
  const out: DocData = merge && existing ? structuredClone(existing) : {};
  for (const [k, v] of Object.entries(input)) {
    if (v === undefined) continue;
    if (isIncrement(v)) {
      const prev = merge && existing && typeof existing[k] === 'number' ? (existing[k] as number) : 0;
      out[k] = prev + v.by;
    } else {
      out[k] = structuredClone(v);
    }
  }
  return out;
}

function getPath(doc: DocData, path: string): unknown {
  let cur: unknown = doc;
  for (const part of path.split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[part];
  }
  return cur;
}

function compare(a: unknown, b: unknown): number {
  if (a === b) return 0;
  if (a === undefined || a === null) return -1;
  if (b === undefined || b === null) return 1;
  return (a as number | string) < (b as number | string) ? -1 : 1;
}

function matches(doc: DocData, f: Filter): boolean {
  const v = getPath(doc, f.field);
  switch (f.op) {
    case '==':
      return v === f.value;
    case '!=':
      return v !== f.value && v !== undefined;
    case 'in':
      return Array.isArray(f.value) && f.value.includes(v);
    case '<':
      return compare(v, f.value) < 0 && v !== undefined;
    case '<=':
      return compare(v, f.value) <= 0 && v !== undefined;
    case '>':
      return compare(v, f.value) > 0;
    case '>=':
      return compare(v, f.value) >= 0;
    case 'array-contains':
      return Array.isArray(v) && v.includes(f.value);
  }
}
