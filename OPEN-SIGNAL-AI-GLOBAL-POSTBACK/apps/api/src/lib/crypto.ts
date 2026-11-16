import { createCipheriv, createDecipheriv, createHash, createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Secret encryption at rest: AES-256-GCM with a random 96-bit IV per value and
 * optional associated data (AAD). AAD binds a ciphertext to its context
 * (e.g. "bot:<botId>:token"), so a ciphertext copied to another bot's record
 * fails to decrypt instead of silently working.
 *
 * Format: v1.<keyId>.<iv>.<tag>.<ciphertext>  (base64url parts)
 */
export interface SecretBox {
  encrypt(plaintext: string, aad?: string): string;
  decrypt(payload: string, aad?: string): string;
  readonly currentKeyId: string;
}

export interface KeyringEntry {
  id: string;
  key: Buffer;
}

export function parseKey(base64: string): Buffer {
  const key = Buffer.from(base64, 'base64');
  if (key.length !== 32) throw new Error('Encryption key must be exactly 32 bytes (base64-encoded)');
  return key;
}

/** Generates a new random key (base64). Run locally, never paste it into chat or git. */
export function generateKeyBase64(): string {
  return randomBytes(32).toString('base64');
}

export function createSecretBox(current: KeyringEntry, previous: KeyringEntry[] = []): SecretBox {
  if (!/^[a-z0-9]{1,16}$/i.test(current.id)) throw new Error('Invalid key id');
  const keys = new Map<string, Buffer>([[current.id, current.key], ...previous.map((p) => [p.id, p.key] as [string, Buffer])]);

  return {
    currentKeyId: current.id,
    encrypt(plaintext, aad) {
      const iv = randomBytes(12);
      const cipher = createCipheriv('aes-256-gcm', current.key, iv);
      if (aad) cipher.setAAD(Buffer.from(aad, 'utf8'));
      const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
      const tag = cipher.getAuthTag();
      return ['v1', current.id, iv.toString('base64url'), tag.toString('base64url'), ct.toString('base64url')].join('.');
    },
    decrypt(payload, aad) {
      const parts = payload.split('.');
      if (parts.length !== 5 || parts[0] !== 'v1') throw new Error('Unsupported ciphertext format');
      const [, keyId, ivB64, tagB64, ctB64] = parts as [string, string, string, string, string];
      const key = keys.get(keyId);
      if (!key) throw new Error(`Unknown encryption key id: ${keyId}`);
      const decipher = createDecipheriv('aes-256-gcm', key, Buffer.from(ivB64, 'base64url'));
      if (aad) decipher.setAAD(Buffer.from(aad, 'utf8'));
      decipher.setAuthTag(Buffer.from(tagB64, 'base64url'));
      return Buffer.concat([decipher.update(Buffer.from(ctB64, 'base64url')), decipher.final()]).toString('utf8');
    },
  };
}

/** "1234567890:AAH5…" → "1234567890:AA••••x8". Never returns the secret part. */
export function maskBotToken(token: string): string {
  const [id = '', secret = ''] = token.split(':');
  if (!secret) return '••••';
  return `${id}:${secret.slice(0, 2)}••••${secret.slice(-2)}`;
}

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function hmacSha256Hex(key: string | Buffer, value: string): string {
  return createHmac('sha256', key).update(value, 'utf8').digest('hex');
}

/** Constant-time string comparison (length leak only). */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}
