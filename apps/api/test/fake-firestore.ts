import http from 'node:http';
import { randomBytes } from 'node:crypto';
import type { AddressInfo } from 'node:net';
import { decodeFields, decodeValue, encodeFields, type FsFields, type FsValue } from '../src/storage/firestore/codec.ts';

/**
 * Test double of the Firestore REST API v1 (the subset the adapter uses),
 * modelled on the documented behaviour: preconditions, field transforms,
 * serializable (pessimistic) transactions, ABORTED injection, index admin API.
 * It verifies the adapter's protocol handling; it is NOT a substitute for the
 * real service (the server probes real Firestore at startup).
 */
export interface FakeFirestore {
  url: string;
  docs: Map<string, FsFields>;
  indexes: Map<string, unknown[]>;
  ttl: Set<string>;
  abortNextCommits: number;
  requests: number;
  close(): Promise<void>;
}

export async function startFakeFirestore(): Promise<FakeFirestore> {
  const docs = new Map<string, FsFields>(); // "col/id" → fields
  const indexes = new Map<string, unknown[]>();
  const ttl = new Set<string>();
  let lock: Promise<void> = Promise.resolve();
  const holders = new Map<string, () => void>();

  const acquire = async (): Promise<() => void> => {
    let release!: () => void;
    const next = new Promise<void>((r) => (release = r));
    const prev = lock;
    lock = prev.then(() => next);
    await prev;
    return release;
  };

  const state: FakeFirestore = {
    url: '',
    docs,
    indexes,
    ttl,
    abortNextCommits: 0,
    requests: 0,
    close: () => new Promise((r) => server.close(() => r())),
  };

  const send = (res: http.ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' }).end(JSON.stringify(body));
  };
  const fail = (res: http.ServerResponse, code: number, status: string, message: string) => send(res, code, { error: { code, status, message } });

  // Full resource name without "/v1/" → documents of different projects never mix.
  const keyOf = (name: string) => name.replace(/^\/?v1\//, '');

  const server = http.createServer((req, res) => {
    let raw = '';
    req.on('data', (c) => (raw += c));
    req.on('end', async () => {
      state.requests++;
      const url = new URL(req.url ?? '/', 'http://x');
      const body = raw ? JSON.parse(raw) : {};
      const path = decodeURIComponent(url.pathname);

      // ── index admin API ──
      const ix = /\/collectionGroups\/([^/]+)\/indexes$/.exec(path);
      if (ix) {
        const list = indexes.get(ix[1]!) ?? [];
        if (req.method === 'GET') return send(res, 200, { indexes: list });
        list.push({ ...body, state: 'CREATING' });
        indexes.set(ix[1]!, list);
        return send(res, 200, { name: 'operations/x' });
      }
      const fieldMatch = /\/collectionGroups\/([^/]+)\/fields\/([^/]+)$/.exec(path);
      if (fieldMatch && req.method === 'PATCH') {
        ttl.add(`${fieldMatch[1]}.${fieldMatch[2]}`);
        return send(res, 200, { name: 'operations/ttl' });
      }

      if (path.endsWith(':beginTransaction')) {
        const id = randomBytes(9).toString('base64');
        holders.set(id, await acquire());
        return send(res, 200, { transaction: id });
      }
      if (path.endsWith(':rollback')) {
        holders.get(body.transaction)?.();
        holders.delete(body.transaction);
        return send(res, 200, {});
      }
      if (path.endsWith(':runQuery')) {
        return send(res, 200, runQuery(docs, keyOf(path).replace(/:runQuery$/, ''), body.structuredQuery));
      }
      if (path.endsWith(':commit')) {
        const txRelease = body.transaction ? holders.get(body.transaction) : undefined;
        if (body.transaction && !txRelease) return fail(res, 400, 'INVALID_ARGUMENT', 'unknown transaction');
        const release = txRelease ?? (await acquire());
        holders.delete(body.transaction);
        try {
          if (state.abortNextCommits > 0 && body.transaction) {
            state.abortNextCommits--;
            return fail(res, 409, 'ABORTED', 'Transaction lock timeout.');
          }
          const staged = new Map(docs);
          for (const w of body.writes as Record<string, any>[]) {
            const err = applyWrite(staged, w);
            if (err) return fail(res, err.code, err.status, err.message);
          }
          docs.clear();
          for (const [k, v] of staged) docs.set(k, v);
          return send(res, 200, { writeResults: [], commitTime: new Date().toISOString() });
        } finally {
          release();
        }
      }
      if (req.method === 'GET') {
        const doc = docs.get(keyOf(path));
        if (!doc) return fail(res, 404, 'NOT_FOUND', `Document "${path}" not found.`);
        return send(res, 200, { name: keyOf(path), fields: doc });
      }
      return fail(res, 404, 'NOT_FOUND', 'unknown route');
    });
  });

  function applyWrite(staged: Map<string, FsFields>, w: Record<string, any>): { code: number; status: string; message: string } | null {
    if (w['delete']) {
      staged.delete(keyOf(w['delete']));
      return null;
    }
    const k = keyOf(w['update'].name);
    const existing = staged.get(k);
    const pre = w['currentDocument'];
    if (pre?.exists === false && existing) return { code: 409, status: 'ALREADY_EXISTS', message: 'Document already exists: ' + k };
    if (pre?.exists === true && !existing) return { code: 404, status: 'NOT_FOUND', message: 'No document to update: ' + k };
    let fields: FsFields;
    if (w['updateMask']) {
      fields = { ...(existing ?? {}) };
      for (const fp of w['updateMask'].fieldPaths as string[]) {
        const v = w['update'].fields?.[fp];
        if (v === undefined) delete fields[fp];
        else fields[fp] = v;
      }
    } else {
      fields = { ...(w['update'].fields ?? {}) };
    }
    for (const t of (w['updateTransforms'] ?? []) as { fieldPath: string; increment: FsValue }[]) {
      const prev = fields[t.fieldPath] ? (decodeValue(fields[t.fieldPath]!) as number) : 0;
      fields[t.fieldPath] = encodeFields({ v: (typeof prev === 'number' ? prev : 0) + (decodeValue(t.increment) as number) }).v!;
    }
    staged.set(k, fields);
    return null;
  }

  await new Promise<void>((r) => server.listen(0, '127.0.0.1', () => r()));
  server.unref(); // never keep a test process alive
  server.keepAliveTimeout = 1000;
  state.url = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
  return state;
}

function runQuery(docs: Map<string, FsFields>, root: string, q: Record<string, any>) {
  const col = `${root}/${q['from'][0].collectionId as string}`;
  const filters: Record<string, any>[] = q['where']?.compositeFilter ? q['where'].compositeFilter.filters : q['where'] ? [q['where']] : [];
  let rows = [...docs.entries()]
    .filter(([k]) => k.startsWith(`${col}/`) && !k.slice(col.length + 1).includes('/'))
    .map(([k, f]) => ({ k, data: decodeFields(f), fields: f }))
    .filter(({ data }) =>
      filters.every(({ fieldFilter: ff }) => {
        const v = get(data, ff.field.fieldPath);
        const x = decodeValue(ff.value);
        switch (ff.op) {
          case 'EQUAL': return v === x;
          case 'NOT_EQUAL': return v !== undefined && v !== x;
          case 'IN': return (x as unknown[]).includes(v);
          case 'LESS_THAN': return v !== undefined && (v as any) < (x as any);
          case 'LESS_THAN_OR_EQUAL': return v !== undefined && (v as any) <= (x as any);
          case 'GREATER_THAN': return v !== undefined && (v as any) > (x as any);
          case 'GREATER_THAN_OR_EQUAL': return v !== undefined && (v as any) >= (x as any);
          case 'ARRAY_CONTAINS': return Array.isArray(v) && v.includes(x);
          default: throw new Error('op ' + ff.op);
        }
      }),
    );
  const ob = q['orderBy']?.[0];
  if (ob) {
    const dir = ob.direction === 'DESCENDING' ? -1 : 1;
    rows = rows.filter((r) => get(r.data, ob.field.fieldPath) !== undefined);
    rows.sort((a, b) => ((get(a.data, ob.field.fieldPath) as any) < (get(b.data, ob.field.fieldPath) as any) ? -1 : 1) * dir);
  }
  if (q['limit'] !== undefined) rows = rows.slice(0, q['limit']);
  const now = new Date().toISOString();
  return rows.length ? rows.map((r) => ({ document: { name: r.k, fields: r.fields }, readTime: now })) : [{ readTime: now }];
}

function get(o: Record<string, unknown>, path: string): unknown {
  let cur: unknown = o;
  for (const p of path.replace(/`/g, '').split('.')) {
    if (cur === null || typeof cur !== 'object') return undefined;
    cur = (cur as Record<string, unknown>)[p];
  }
  return cur;
}
