import { randomBytes } from 'node:crypto';

/** Document id: 96 random bits, URL-safe. */
export function newId(): string {
  return randomBytes(12).toString('base64url');
}

/**
 * click_id: 128 cryptographically random bits, not derived from any user data.
 * Written as 32 lowercase hex characters: partner trackers often allow only letters and
 * digits in sub-id fields and some change the letter case — hex survives both.
 */
export function newClickId(): string {
  return randomBytes(16).toString('hex');
}

/** New format (32 hex) and the former one (22 chars base64url, still valid for stored links). */
export const CLICK_ID_PATTERN = /^(?:[0-9a-f]{32}|[A-Za-z0-9_-]{22})$/i;

/** A hex click_id that came back upper-cased is the same click. Former base64url ids are case-sensitive and kept as is. */
export function normalizeClickId(raw: string): string {
  const v = raw.trim();
  return /^[0-9a-f]{32}$/i.test(v) ? v.toLowerCase() : v;
}

/** Webhook secret_token for Telegram setWebhook: 1–256 chars of A-Z a-z 0-9 _ -. */
export function newWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}
