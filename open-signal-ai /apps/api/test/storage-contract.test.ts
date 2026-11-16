import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import { generateKeyPairSync, createVerify } from 'node:crypto';
import { LocalDocumentStore } from '../src/storage/local-store.ts';
import { FirestoreDocumentStore } from '../src/storage/firestore/store.ts';
import { NoAuthTokenProvider, ServiceAccountTokenProvider, parseServiceAccount } from '../src/storage/firestore/auth.ts';
import { decodeFields, encodeFields, fieldPath } from '../src/storage/firestore/codec.ts';
import { ensureIndexes, loadIndexFile } from '../src/storage/firestore/indexes.ts';
import { increment, type DocumentStore } from '../src/storage/types.ts';
import { AppError } from '../src/lib/errors.ts';
import { nullLogger } from '../src/lib/logger.ts';
import { startFakeFirestore } from './fake-firestore.ts';

const fake = await startFakeFirestore();
after(() => fake.close());

const stores: [string, () => DocumentStore][] = [
  ['local', () => new LocalDocumentStore(null)],
  ['firestore-rest', () => new FirestoreDocumentStore({ projectId: `c${Math.random().toString(36).slice(2, 8)}`, tokens: new NoAuthTokenProvider(), baseUrl: fake.url })],
];

for (const [label, make] of stores) {
  test(`[${label}] create/get/set/update/delete semantics`, async () => {
    const st = make();
    await st.create('c', 'a', { botId: 'b1', n: 1, nested: { x: [1, 'two', null], ok: true }, f: 1.5 });
    assert.deepEqual(await st.get('c', 'a'), { botId: 'b1', n: 1, nested: { x: [1, 'two', null], ok: true }, f: 1.5 });
    await assert.rejects(st.create('c', 'a', { n: 2 }), (e: AppError) => e.code === 'ALREADY_EXISTS');
    await assert.rejects(st.update('c', 'missing', { n: 1 }), (e: AppError) => e.code === 'NOT_FOUND');
    await st.update('c', 'a', { n: increment(5), tag: 'z' });
    const a = await st.get<{ n: number; tag: string; botId: string }>('c', 'a');
    assert.equal(a!.n, 6);
    assert.equal(a!.tag, 'z');
    assert.equal(a!.botId, 'b1', 'update keeps other fields');
    await st.set('c', 'a', { only: 1 });
    assert.deepEqual(await st.get('c', 'a'), { only: 1 }, 'set without merge replaces');
    await st.set('c', 'a', { more: 2, cnt: increment(3) }, { merge: true });
    assert.deepEqual(await st.get('c', 'a'), { only: 1, more: 2, cnt: 3 });
    await st.delete('c', 'a');
    assert.equal(await st.get('c', 'a'), null);
  });

  test(`[${label}] queries: filters, in, inequality, order, limit`, async () => {
    const st = make();
    for (let i = 0; i < 6; i++) await st.create('q', `d${i}`, { botId: i % 2 ? 'odd' : 'even', n: i, at: `2026-01-0${i + 1}` });
    const even = await st.query<{ n: number }>('q', { where: [{ field: 'botId', op: '==', value: 'even' }], orderBy: { field: 'n', direction: 'desc' } });
    assert.deepEqual(even.map((d) => d.data.n), [4, 2, 0]);
    const inq = await st.query('q', { where: [{ field: 'n', op: 'in', value: [1, 5] }] });
    assert.deepEqual(inq.map((d) => d.id).sort(), ['d1', 'd5']);
    const gt = await st.query('q', { where: [{ field: 'at', op: '>', value: '2026-01-04' }], orderBy: { field: 'at' }, limit: 1 });
    assert.deepEqual(gt.map((d) => d.id), ['d4']);
  });

  test(`[${label}] transactions: atomic, reads-before-writes, concurrent creates → exactly one`, async () => {
    const st = make();
    await assert.rejects(
      st.runTransaction(async (tx) => {
        tx.set('t', 'x', { v: 1 });
        await tx.get('t', 'x');
      }),
      /reads must happen before writes/,
    );
    await assert.rejects(
      st.runTransaction(async (tx) => {
        tx.set('t', 'y', { v: 1 });
        throw new Error('boom');
      }),
    );
    assert.equal(await st.get('t', 'y'), null);
    const results = await Promise.allSettled(
      Array.from({ length: 8 }, (_, i) =>
        st.runTransaction(async (tx) => {
          const cur = await tx.get('t', 'lock');
          if (cur) throw new AppError('ALREADY_EXISTS');
          tx.create('t', 'lock', { i });
        }),
      ),
    );
    assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
    // counter: 10 transactional increments are all applied
    await st.create('t', 'ctr', { n: 0 });
    await Promise.all(Array.from({ length: 10 }, () => st.runTransaction(async (tx) => {
      const c = await tx.get<{ n: number }>('t', 'ctr');
      tx.update('t', 'ctr', { n: c!.n + 1 });
    })));
    assert.equal((await st.get<{ n: number }>('t', 'ctr'))!.n, 10);
  });
}

test('[firestore-rest] ABORTED commits are retried transparently', async () => {
  const st = new FirestoreDocumentStore({ projectId: 'retry1', tokens: new NoAuthTokenProvider(), baseUrl: fake.url });
  fake.abortNextCommits = 2;
  let runs = 0;
  await st.runTransaction(async (tx) => {
    runs++;
    await tx.get('r', 'a');
    tx.set('r', 'a', { ok: true });
  });
  assert.equal(runs, 3);
  assert.deepEqual(await st.get('r', 'a'), { ok: true });
});

test('codec: types round-trip, TTL fields become timestamps, field paths are quoted', () => {
  const doc = { s: 'x', i: 42, d: 0.25, b: false, n: null, arr: [1, { k: 'v' }], map: { 'weird-key': 1 }, expireAt: '2026-11-20T00:00:00.000Z' };
  const enc = encodeFields(doc);
  assert.deepEqual(enc['i'], { integerValue: '42' });
  assert.deepEqual(enc['expireAt'], { timestampValue: '2026-11-20T00:00:00.000Z' });
  assert.deepEqual(decodeFields(enc), doc);
  assert.equal(fieldPath('botPermissions.my-bot'), 'botPermissions.`my-bot`');
});

test('service account: parsing (raw JSON or base64) and RS256 JWT bearer grant', async () => {
  const { privateKey, publicKey } = generateKeyPairSync('rsa', { modulusLength: 2048 });
  const sa = { type: 'service_account', project_id: 'demo', client_email: 'svc@demo.iam.gserviceaccount.com', private_key: privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() };
  assert.equal(parseServiceAccount(JSON.stringify(sa)).project_id, 'demo');
  assert.equal(parseServiceAccount(Buffer.from(JSON.stringify(sa)).toString('base64')).client_email, sa.client_email);
  assert.throws(() => parseServiceAccount('{"type":"user"}'), /service account/);

  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++;
    const assertion = new URLSearchParams(String(init.body)).get('assertion')!;
    const [h, p, sig] = assertion.split('.') as [string, string, string];
    const ok = createVerify('RSA-SHA256').update(`${h}.${p}`).verify(publicKey, Buffer.from(sig, 'base64url'));
    const claims = JSON.parse(Buffer.from(p, 'base64url').toString());
    assert.ok(ok, 'JWT signature verifies with the public key');
    assert.equal(claims.iss, sa.client_email);
    assert.match(claims.scope, /datastore/);
    return new Response(JSON.stringify({ access_token: 'ya29.test', expires_in: 3600 }), { status: 200 });
  }) as unknown as typeof fetch;
  const tp = new ServiceAccountTokenProvider(parseServiceAccount(JSON.stringify(sa)), fetchImpl);
  assert.equal(await tp.getToken(), 'ya29.test');
  assert.equal(await tp.getToken(), 'ya29.test');
  assert.equal(calls, 1, 'token is cached');
});

test('index provisioning creates all composite indexes and the TTL policy, idempotently', async () => {
  const file = loadIndexFile();
  const first = await ensureIndexes({ projectId: 'idx', tokens: new NoAuthTokenProvider(), logger: nullLogger, baseUrl: fake.url, file });
  assert.equal(first.error, null);
  assert.equal(first.created, file.indexes.length);
  assert.ok(first.ttlConfigured);
  const second = await ensureIndexes({ projectId: 'idx', tokens: new NoAuthTokenProvider(), logger: nullLogger, baseUrl: fake.url, file });
  assert.equal(second.created, 0, 'nothing is created twice');
  assert.equal(second.building, file.indexes.length);
});
