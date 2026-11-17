/**
 * Storage abstraction. Business logic talks only to `DocumentStore`; the local
 * JSON adapter (development) and the Firestore adapter (production, Stage 2/3)
 * implement the same contract, mirroring Firestore semantics on purpose:
 *
 *  - `create` fails with ALREADY_EXISTS if the document exists (used for
 *    uniqueness locks and idempotency keys);
 *  - `update` fails with NOT_FOUND if the document is missing;
 *  - transactions are serializable; inside a transaction ALL reads must happen
 *    before the first write (Firestore rule — the local adapter enforces it too,
 *    so code that passes local tests is valid for Firestore).
 */

export type DocData = Record<string, unknown>;

export type FilterOp = '==' | '!=' | 'in' | '<' | '<=' | '>' | '>=' | 'array-contains';

export interface Filter {
  field: string;
  op: FilterOp;
  value: unknown;
}

export interface QueryOptions {
  where?: Filter[];
  orderBy?: { field: string; direction?: 'asc' | 'desc' };
  limit?: number;
}

export interface StoredDoc<T> {
  id: string;
  data: T;
}

/** Sentinel for atomic counters (maps to FieldValue.increment in Firestore). */
export interface IncrementOp {
  readonly __op: 'increment';
  readonly by: number;
}

export function increment(by = 1): IncrementOp {
  return { __op: 'increment', by };
}

export function isIncrement(v: unknown): v is IncrementOp {
  return typeof v === 'object' && v !== null && (v as IncrementOp).__op === 'increment';
}

export interface SetOptions {
  merge?: boolean;
}

export interface DocumentReader {
  get<T extends DocData>(collection: string, id: string): Promise<T | null>;
  query<T extends DocData>(collection: string, options?: QueryOptions): Promise<StoredDoc<T>[]>;
}

export interface DocumentWriter {
  create(collection: string, id: string, data: DocData): Promise<void>;
  set(collection: string, id: string, data: DocData, options?: SetOptions): Promise<void>;
  update(collection: string, id: string, patch: DocData): Promise<void>;
  delete(collection: string, id: string): Promise<void>;
}

export interface Transaction extends DocumentReader {
  create(collection: string, id: string, data: DocData): void;
  set(collection: string, id: string, data: DocData, options?: SetOptions): void;
  update(collection: string, id: string, patch: DocData): void;
  delete(collection: string, id: string): void;
}

export interface DocumentStore extends DocumentReader, DocumentWriter {
  readonly kind: 'local' | 'firestore' | 'memory';
  runTransaction<R>(fn: (tx: Transaction) => Promise<R>): Promise<R>;
  /** Persists pending writes (no-op for Firestore). */
  flush(): Promise<void>;
  close(): Promise<void>;
}
