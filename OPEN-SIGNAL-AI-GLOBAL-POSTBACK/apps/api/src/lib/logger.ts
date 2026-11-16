/**
 * Centralized structured logger (JSON lines). Secrets are redacted by key name
 * at any depth before anything is written.
 */
export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const ORDER: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

const REDACT_KEYS = new Set([
  'token',
  'tokenenc',
  'bottoken',
  'secret',
  'secretenc',
  'webhooksecret',
  'password',
  'authorization',
  'initdata',
  'hash',
  'signature',
  'apikey',
  'session',
  'cookie',
  'x-telegram-bot-api-secret-token',
]);

export function redact(value: unknown, depth = 0): unknown {
  if (depth > 6 || value === null || typeof value !== 'object') return value;
  if (Array.isArray(value)) return value.map((v) => redact(v, depth + 1));
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
    out[k] = REDACT_KEYS.has(k.toLowerCase()) ? '[REDACTED]' : redact(v, depth + 1);
  }
  return out;
}

export interface Logger {
  debug(msg: string, fields?: Record<string, unknown>): void;
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
  child(bindings: Record<string, unknown>): Logger;
}

export type LogSink = (line: string) => void;

export function createLogger(
  level: LogLevel = 'info',
  sink: LogSink = (l) => process.stdout.write(l + '\n'),
  bindings: Record<string, unknown> = {},
): Logger {
  const write = (lvl: LogLevel, msg: string, fields?: Record<string, unknown>) => {
    if (ORDER[lvl] < ORDER[level]) return;
    const entry = { level: lvl, time: new Date().toISOString(), msg, ...bindings, ...(fields ? (redact(fields) as object) : {}) };
    sink(JSON.stringify(entry, errorReplacer));
  };
  return {
    debug: (m, f) => write('debug', m, f),
    info: (m, f) => write('info', m, f),
    warn: (m, f) => write('warn', m, f),
    error: (m, f) => write('error', m, f),
    child: (b) => createLogger(level, sink, { ...bindings, ...(redact(b) as object) }),
  };
}

function errorReplacer(_key: string, value: unknown): unknown {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack?.split('\n').slice(0, 8).join('\n') };
  }
  return value;
}

/** Silent logger for tests. */
export const nullLogger: Logger = {
  debug() {},
  info() {},
  warn() {},
  error() {},
  child: () => nullLogger,
};
