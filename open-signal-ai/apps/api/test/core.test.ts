import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createSecretBox, maskBotToken, parseKey, generateKeyBase64 } from '../src/lib/crypto.ts';
import { validateInitData, signInitDataForTests } from '../src/telegram/init-data.ts';
import { SessionService } from '../src/auth/session.ts';
import { LocalDocumentStore } from '../src/storage/local-store.ts';
import { increment } from '../src/storage/types.ts';
import { TokenBucketLimiter } from '../src/lib/rate-limit.ts';
import { loadEnv } from '../src/config/env.ts';
import { createLogger, redact } from '../src/lib/logger.ts';
import { AppError } from '../src/lib/errors.ts';

// ───────── AES-256-GCM ─────────

test('crypto: round trip, AAD binding, tamper detection, key rotation', () => {
  const k1 = { id: 'k1', key: parseKey(generateKeyBase64()) };
  const k2 = { id: 'k2', key: parseKey(generateKeyBase64()) };
  const box1 = createSecretBox(k1);
  const c = box1.encrypt('123456:SECRET', 'bot:A:token');
  assert.notEqual(c.includes('SECRET'), true);
  assert.equal(box1.decrypt(c, 'bot:A:token'), '123456:SECRET');
  assert.throws(() => box1.decrypt(c, 'bot:B:token'), 'ciphertext moved to another bot must fail');
  const parts = c.split('.');
  parts[4] = Buffer.from('tampered').toString('base64url');
  assert.throws(() => box1.decrypt(parts.join('.'), 'bot:A:token'));
  // rotation: new key current, old key still decrypts old values
  const box2 = createSecretBox(k2, [k1]);
  assert.equal(box2.decrypt(c, 'bot:A:token'), '123456:SECRET');
  assert.ok(box2.encrypt('x').startsWith('v1.k2.'));
  // two encryptions differ (random IV)
  assert.notEqual(box1.encrypt('same'), box1.encrypt('same'));
});

test('crypto: token masking never reveals the secret part', () => {
  const masked = maskBotToken('1234567890:AAH5YkoiEuPk8-FZa32hStHTqXiLPtAEhx8');
  assert.equal(masked, '1234567890:AA••••x8');
});

// ───────── initData ─────────

const TOKEN = '1234567:AAEXAMPLEexampleEXAMPLEexample_1234';
const now = new Date('2026-11-18T12:00:00Z');
const authDate = String(Math.floor(now.getTime() / 1000) - 60);
const user = JSON.stringify({ id: 42, first_name: 'Ann', username: 'ann' });

test('initData: valid signature accepted and user parsed', () => {
  const raw = signInitDataForTests(TOKEN, { auth_date: authDate, query_id: 'AAE', user });
  const v = validateInitData(raw, TOKEN, { maxAgeSec: 3600, now });
  assert.equal(v.user.id, 42);
});

test('initData: tampered user, wrong bot, expired, future and missing hash are rejected', () => {
  const raw = signInitDataForTests(TOKEN, { auth_date: authDate, user });
  const tampered = raw.replace(encodeURIComponent('"id":42'), encodeURIComponent('"id":43'));
  const code = (fn: () => unknown) => {
    try {
      fn();
      return 'OK';
    } catch (e) {
      return (e as AppError).code;
    }
  };
  assert.equal(code(() => validateInitData(tampered, TOKEN, { maxAgeSec: 3600, now })), 'INIT_DATA_INVALID');
  assert.equal(code(() => validateInitData(raw, '7654321:AAOTHERotherOTHERotherOTHER_5678', { maxAgeSec: 3600, now })), 'INIT_DATA_INVALID');
  assert.equal(code(() => validateInitData(raw, TOKEN, { maxAgeSec: 30, now })), 'INIT_DATA_INVALID');
  const future = signInitDataForTests(TOKEN, { auth_date: String(Number(authDate) + 3600), user });
  assert.equal(code(() => validateInitData(future, TOKEN, { maxAgeSec: 3600, now })), 'INIT_DATA_INVALID');
  assert.equal(code(() => validateInitData('user=%7B%7D&auth_date=1', TOKEN, { maxAgeSec: 3600, now })), 'INIT_DATA_INVALID');
});

// ───────── sessions ─────────

test('session: bound to bot, expires, rejects tampering', () => {
  const s = new SessionService('x'.repeat(40), 3600);
  const { token } = s.issue('botA', 7, now);
  assert.equal(s.verify(token, 'botA', now).tgId, 7);
  assert.throws(() => s.verify(token, 'botB', now), (e: AppError) => e.code === 'UNAUTHORIZED');
  assert.throws(() => s.verify(token, 'botA', new Date(now.getTime() + 3601_000)), (e: AppError) => e.code === 'SESSION_EXPIRED');
  const [body] = token.split('.');
  const forged = Buffer.from(JSON.stringify({ v: 1, botId: 'botA', tgId: 8, iat: 0, exp: 9e9 })).toString('base64url');
  assert.throws(() => s.verify(`${forged}.${token.split('.')[1]}`, 'botA', now));
  assert.ok(body);
});

// ───────── local store ─────────

test('local store: create is unique, update needs existing doc, increments, queries', async () => {
  const st = new LocalDocumentStore(null);
  await st.create('c', 'a', { botId: 'b1', n: 1, tags: ['x'] });
  await assert.rejects(st.create('c', 'a', { n: 2 }), (e: AppError) => e.code === 'ALREADY_EXISTS');
  await assert.rejects(st.update('c', 'missing', { n: 1 }), (e: AppError) => e.code === 'NOT_FOUND');
  await st.update('c', 'a', { n: increment(5) });
  assert.equal((await st.get<{ n: number }>('c', 'a'))!.n, 6);
  await st.create('c', 'b', { botId: 'b2', n: 3 });
  const q = await st.query('c', { where: [{ field: 'botId', op: '==', value: 'b1' }] });
  assert.deepEqual(q.map((d) => d.id), ['a']);
  const sorted = await st.query<{ n: number }>('c', { orderBy: { field: 'n', direction: 'desc' } });
  assert.deepEqual(sorted.map((d) => d.id), ['a', 'b']);
});

test('local store: transaction enforces reads-before-writes and is all-or-nothing', async () => {
  const st = new LocalDocumentStore(null);
  await assert.rejects(
    st.runTransaction(async (tx) => {
      tx.set('c', 'x', { v: 1 });
      await tx.get('c', 'x');
    }),
    /reads must happen before writes/,
  );
  await assert.rejects(
    st.runTransaction(async (tx) => {
      tx.set('c', 'y', { v: 1 });
      throw new Error('boom');
    }),
  );
  assert.equal(await st.get('c', 'y'), null, 'failed transaction left no partial write');
});

test('local store: 20 concurrent creates of one id → exactly one wins', async () => {
  const st = new LocalDocumentStore(null);
  const results = await Promise.allSettled(Array.from({ length: 20 }, (_, i) => st.create('locks', 'same', { i })));
  assert.equal(results.filter((r) => r.status === 'fulfilled').length, 1);
});

test('local store: data survives a restart (file persistence)', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'os-store-'));
  const file = join(dir, 'store.json');
  const a = new LocalDocumentStore(file);
  await a.create('users', 'b_1', { botId: 'b', name: 'Ann' });
  await a.close();
  const b = new LocalDocumentStore(file);
  assert.equal((await b.get<{ name: string }>('users', 'b_1'))!.name, 'Ann');
});

// ───────── rate limiter, env, logger ─────────

test('rate limiter: capacity, refill and retry-after', () => {
  const l = new TokenBucketLimiter();
  const rule = { capacity: 3, refillPerSec: 1 };
  assert.ok(l.take('k', rule, 0).allowed);
  assert.ok(l.take('k', rule, 0).allowed);
  assert.ok(l.take('k', rule, 0).allowed);
  const denied = l.take('k', rule, 0);
  assert.equal(denied.allowed, false);
  assert.equal(denied.retryAfterSec, 1);
  assert.ok(l.take('k', rule, 1000).allowed, 'refilled after 1s');
  assert.ok(l.take('other', rule, 0).allowed, 'keys are independent');
});

test('env: errors list variable names, never values', () => {
  try {
    loadEnv({ ENCRYPTION_KEY: 'short-secret-value', SESSION_SECRET: 'tiny' });
    assert.fail('should throw');
  } catch (e) {
    const msg = (e as Error).message;
    assert.match(msg, /ENCRYPTION_KEY/);
    assert.match(msg, /SESSION_SECRET/);
    assert.doesNotMatch(msg, /short-secret-value|tiny/);
  }
  assert.throws(
    () => loadEnv({ NODE_ENV: 'production', ENCRYPTION_KEY: Buffer.alloc(32).toString('base64'), SESSION_SECRET: 'x'.repeat(40) }),
    /PUBLIC_API_URL[\s\S]*STORAGE_DRIVER|STORAGE_DRIVER[\s\S]*PUBLIC_API_URL/,
  );
});

test('logger: secrets are redacted at any depth', () => {
  const lines: string[] = [];
  const log = createLogger('debug', (l) => lines.push(l));
  log.info('x', { botId: 'b', nested: { token: '123:abc', list: [{ secret: 's' }] }, authorization: 'Bearer t' });
  const out = lines.join('\n');
  assert.doesNotMatch(out, /123:abc|Bearer t|"s"/);
  assert.match(out, /REDACTED/);
  assert.deepEqual(redact({ initData: 'q' }), { initData: '[REDACTED]' });
});
