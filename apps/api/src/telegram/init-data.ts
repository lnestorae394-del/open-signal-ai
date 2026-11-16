import { createHmac } from 'node:crypto';
import { AppError } from '../lib/errors.ts';
import { safeEqual } from '../lib/crypto.ts';

/**
 * Telegram Mini App initData validation (first-party HMAC scheme):
 *   secret_key = HMAC_SHA256(key = "WebAppData", message = bot_token)
 *   data_check_string = all fields except `hash`, sorted by key, "key=value" joined by "\n"
 *   valid ⇔ hex(HMAC_SHA256(key = secret_key, message = data_check_string)) == hash
 * Plus freshness: auth_date must be recent and not in the future.
 *
 * Nothing from `initDataUnsafe` or the request body is trusted — only what this
 * function returns.
 */
export interface TelegramUser {
  id: number;
  first_name: string;
  last_name?: string;
  username?: string;
  language_code?: string;
  is_premium?: boolean;
  photo_url?: string;
}

export interface VerifiedInitData {
  user: TelegramUser;
  authDate: Date;
  queryId: string | null;
  startParam: string | null;
  chatType: string | null;
}

export interface ValidateOptions {
  maxAgeSec: number;
  now?: Date;
}

export function telegramSecretKey(botToken: string): Buffer {
  return createHmac('sha256', 'WebAppData').update(botToken).digest();
}

export function dataCheckString(params: URLSearchParams): string {
  return [...params.entries()]
    .filter(([k]) => k !== 'hash')
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
}

export function validateInitData(raw: string, botToken: string, opts: ValidateOptions): VerifiedInitData {
  if (typeof raw !== 'string' || raw.length === 0 || raw.length > 8192) {
    throw new AppError('INIT_DATA_INVALID', 'initData missing or too long');
  }
  const params = new URLSearchParams(raw);
  const hash = params.get('hash');
  if (!hash || !/^[a-f0-9]{64}$/.test(hash)) throw new AppError('INIT_DATA_INVALID', 'hash missing');

  const expected = createHmac('sha256', telegramSecretKey(botToken)).update(dataCheckString(params)).digest('hex');
  if (!safeEqual(expected, hash)) throw new AppError('INIT_DATA_INVALID', 'signature mismatch');

  const authDateSec = Number(params.get('auth_date'));
  if (!Number.isInteger(authDateSec) || authDateSec <= 0) throw new AppError('INIT_DATA_INVALID', 'auth_date missing');
  const nowSec = Math.floor((opts.now ?? new Date()).getTime() / 1000);
  if (authDateSec > nowSec + 60) throw new AppError('INIT_DATA_INVALID', 'auth_date in the future');
  if (nowSec - authDateSec > opts.maxAgeSec) throw new AppError('INIT_DATA_INVALID', 'initData expired');

  let user: TelegramUser;
  try {
    user = JSON.parse(params.get('user') ?? '') as TelegramUser;
  } catch {
    throw new AppError('INIT_DATA_INVALID', 'user payload invalid');
  }
  if (!user || !Number.isSafeInteger(user.id) || user.id <= 0 || typeof user.first_name !== 'string') {
    throw new AppError('INIT_DATA_INVALID', 'user payload invalid');
  }

  return {
    user,
    authDate: new Date(authDateSec * 1000),
    queryId: params.get('query_id'),
    startParam: params.get('start_param'),
    chatType: params.get('chat_type'),
  };
}

/** Test/dev helper: produces initData exactly as Telegram signs it. Never used in request handling. */
export function signInitDataForTests(botToken: string, fields: Record<string, string>): string {
  const params = new URLSearchParams(fields);
  const hash = createHmac('sha256', telegramSecretKey(botToken)).update(dataCheckString(params)).digest('hex');
  params.set('hash', hash);
  return params.toString();
}
