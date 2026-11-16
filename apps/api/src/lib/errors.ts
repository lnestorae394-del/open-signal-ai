/**
 * Application errors. `code` is stable and mapped to a translation key on the
 * client (errors.*), so server messages never leak into the UI language.
 */
export type ErrorCode =
  | 'BAD_REQUEST'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'NOT_FOUND'
  | 'ALREADY_EXISTS'
  | 'PAYLOAD_TOO_LARGE'
  | 'RATE_LIMITED'
  | 'BOT_DISABLED'
  | 'INIT_DATA_INVALID'
  | 'SESSION_EXPIRED'
  | 'TRADER_ID_INVALID'
  | 'TRADER_ID_CHANGE_FORBIDDEN'
  | 'TRADER_ID_MISMATCH'
  | 'REGISTRATION_NOT_CONFIRMED'
  | 'CLICK_MISMATCH'
  | 'TRADER_ID_TAKEN'
  | 'ONBOARDING_REQUIRED'
  | 'SIGNAL_COOLDOWN'
  | 'RECHECK_TOO_SOON'
  | 'MODULE_LOCKED'
  | 'NOT_IMPLEMENTED'
  | 'INVALID_CREDENTIALS'
  | 'ACCOUNT_LOCKED'
  | 'SETUP_ALREADY_DONE'
  | 'TELEGRAM_TOKEN_INVALID'
  | 'BOT_ALREADY_CONNECTED'
  | 'VALIDATION_FAILED'
  | 'STORAGE_UNAVAILABLE'
  | 'SIGNAL_LIMIT'
  | 'PARTNER_LINK_MISSING'
  | 'CONFIRMATION_MISMATCH'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  BAD_REQUEST: 400,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  NOT_FOUND: 404,
  ALREADY_EXISTS: 409,
  PAYLOAD_TOO_LARGE: 413,
  RATE_LIMITED: 429,
  BOT_DISABLED: 403,
  INIT_DATA_INVALID: 401,
  SESSION_EXPIRED: 401,
  TRADER_ID_INVALID: 400,
  TRADER_ID_CHANGE_FORBIDDEN: 409,
  TRADER_ID_MISMATCH: 409,
  REGISTRATION_NOT_CONFIRMED: 409,
  CLICK_MISMATCH: 409,
  TRADER_ID_TAKEN: 409,
  ONBOARDING_REQUIRED: 403,
  SIGNAL_COOLDOWN: 429,
  RECHECK_TOO_SOON: 429,
  MODULE_LOCKED: 403,
  NOT_IMPLEMENTED: 501,
  INVALID_CREDENTIALS: 401,
  ACCOUNT_LOCKED: 423,
  SETUP_ALREADY_DONE: 409,
  TELEGRAM_TOKEN_INVALID: 400,
  BOT_ALREADY_CONNECTED: 409,
  VALIDATION_FAILED: 400,
  STORAGE_UNAVAILABLE: 503,
  SIGNAL_LIMIT: 429,
  PARTNER_LINK_MISSING: 409,
  CONFIRMATION_MISMATCH: 400,
  INTERNAL: 500,
};

export class AppError extends Error {
  readonly code: ErrorCode;
  readonly status: number;
  readonly details: Record<string, unknown> | undefined;

  constructor(code: ErrorCode, message?: string, details?: Record<string, unknown>) {
    super(message ?? code);
    this.name = 'AppError';
    this.code = code;
    this.status = STATUS[code];
    this.details = details;
  }
}

export function isAppError(e: unknown): e is AppError {
  return e instanceof AppError;
}
