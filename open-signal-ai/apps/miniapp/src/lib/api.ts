import type { BindingState, PublicBotConfig } from '@open-signal/shared';
import type { Lang } from '@open-signal/i18n';

/** Admin panel, Mini App and API are served from one origin, so API paths are relative. */
export const API_URL = '';

export interface BindingView {
  enabled: boolean;
  state: BindingState;
  traderIdMasked: string | null;
  recheckAvailableAt: string | null;
  showSupport: boolean;
  supportContact: string;
}

export interface Settings {
  language: Lang | null;
  favorites: string[];
  analysisMode: 'BASIC' | 'FULL';
}

export interface Me {
  user: { telegramId: number; username: string | null; firstName: string; registeredAt: string; languageCode: string | null };
  settings: Settings;
  binding: BindingView;
  access: Record<string, boolean>;
}

export interface SessionResponse extends Me {
  session: { token: string; expiresAt: string };
}

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly payload: unknown;
  constructor(code: string, status: number, payload: unknown) {
    super(code);
    this.code = code;
    this.status = status;
    this.payload = payload;
  }
}

async function request<T>(path: string, init: RequestInit & { token?: string | null } = {}): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}${path}`, {
      ...init,
      headers: {
        'content-type': 'application/json',
        ...(init.token ? { authorization: `Bearer ${init.token}` } : {}),
        ...(init.headers ?? {}),
      },
    });
  } catch {
    throw new ApiError('NETWORK', 0, null);
  }
  const body = (await res.json().catch(() => null)) as { error?: { code?: string } } | null;
  if (!res.ok) throw new ApiError(body?.error?.code ?? 'INTERNAL', res.status, body);
  return body as T;
}

export const api = {
  publicConfig: (botId: string) => request<PublicBotConfig>(`/api/public/bots/${botId}/config`),
  session: (botId: string, initData: string) =>
    request<SessionResponse>(`/api/miniapp/${botId}/session`, { method: 'POST', body: JSON.stringify({ initData }) }),
  me: (botId: string, token: string) => request<Me>(`/api/miniapp/${botId}/me`, { token }),
  saveSettings: (botId: string, token: string, patch: Partial<Settings>) =>
    request<{ settings: Settings }>(`/api/miniapp/${botId}/settings`, { method: 'PUT', token, body: JSON.stringify(patch) }),
  submitTraderId: (botId: string, token: string, traderId: string) =>
    request<{ binding: BindingView }>(`/api/miniapp/${botId}/binding/trader-id`, { method: 'POST', token, body: JSON.stringify({ traderId }) }),
  recheck: (botId: string, token: string) =>
    request<{ binding: BindingView }>(`/api/miniapp/${botId}/binding/recheck`, { method: 'POST', token }),
};

/** Maps API error codes to translation keys. */
export function errorKey(code: string): string {
  const map: Record<string, string> = {
    NETWORK: 'errors.network',
    BOT_DISABLED: 'errors.botDisabled',
    NOT_FOUND: 'errors.botNotFound',
    INIT_DATA_INVALID: 'errors.initDataInvalid',
    SESSION_EXPIRED: 'errors.sessionExpired',
    UNAUTHORIZED: 'errors.sessionExpired',
    RATE_LIMITED: 'errors.rateLimited',
    TRADER_ID_INVALID: 'errors.traderIdInvalid',
    TRADER_ID_CHANGE_FORBIDDEN: 'errors.traderIdChangeForbidden',
    TRADER_ID_MISMATCH: 'errors.traderIdMismatch',
    RECHECK_TOO_SOON: 'errors.recheckTooSoon',
    MODULE_LOCKED: 'errors.moduleLocked',
  };
  return map[code] ?? 'errors.generic';
}

/** Safe storage: browser storage may be unavailable inside some WebViews. */
export const safeStorage = {
  get(key: string): string | null {
    try {
      return window.localStorage.getItem(key);
    } catch {
      return null;
    }
  },
  set(key: string, value: string): void {
    try {
      window.localStorage.setItem(key, value);
    } catch {
      /* ignore */
    }
  },
};
