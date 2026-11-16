import { randomBytes } from 'node:crypto';

/** Document id: 96 random bits, URL-safe. */
export function newId(): string {
  return randomBytes(12).toString('base64url');
}

/** click_id: 128 cryptographically random bits (22 chars base64url). Not derived from any user data. */
export function newClickId(): string {
  return randomBytes(16).toString('base64url');
}

export const CLICK_ID_PATTERN = /^[A-Za-z0-9_-]{22}$/;

/** Webhook secret_token for Telegram setWebhook: 1–256 chars of A-Z a-z 0-9 _ -. */
export function newWebhookSecret(): string {
  return randomBytes(32).toString('base64url');
}
