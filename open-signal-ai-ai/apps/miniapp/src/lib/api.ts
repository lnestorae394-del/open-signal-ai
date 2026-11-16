import type { BindingState, DepositStatus, MarketMode, OnboardingStatus, PublicBotConfig } from '@open-signal/shared';
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
  marketMode: MarketMode;
}

export interface DepositView {
  status: DepositStatus;
  sourceConnected: boolean;
  ftdAmount: number | null;
  ftdCurrency: string | null;
  ftdAt: string | null;
  ftdThresholdMet: boolean;
  depositsCount: number;
  lastDepositAt: string | null;
}

/** Onboarding state — always derived on the server from the stored user record. */
export interface OnboardingView {
  status: OnboardingStatus;
  registrationStartedAt: string | null;
  traderIdMasked: string | null;
  verification: 'not_submitted' | 'pending' | 'confirmed' | 'review';
  deposit: DepositView;
  partner: { configured: boolean };
}

export interface Quote {
  instrumentId: string;
  price: number;
  changePct: number;
  decimals: number;
  at: string;
}

export interface MarketStatus {
  status: 'SIMULATED' | 'LIVE' | 'DELAYED' | 'STALE' | 'MARKET_CLOSED' | 'UNAVAILABLE' | 'NO_VERIFIED_SOURCE';
  marketOpen: boolean;
  frozenAt: string | null;
  source: { id: string; simulated: boolean };
}

export interface Overview extends MarketStatus {
  mode: MarketMode;
  quotes: Quote[];
}

export interface Candle {
  time: number;
  open: number;
  high: number;
  low: number;
  close: number;
}

export interface CandlesResponse extends MarketStatus {
  mode: MarketMode;
  instrumentId: string;
  timeframeSec: number;
  quote: Quote;
  candles: Candle[];
  rsi: (number | null)[] | null;
}

export interface DemoSignal {
  id: string;
  mode: MarketMode;
  instrumentId: string;
  direction: 'up' | 'down';
  basis: 'rsi_oversold' | 'rsi_overbought' | 'above_average' | 'below_average';
  rsi: number | null;
  periodSec: number;
  entryPrice: number;
  entryAt: string;
  expiresAt: string;
  outcome: 'open' | 'win' | 'loss' | 'draw';
  exitPrice: number | null;
  simulated: boolean;
}

export interface SignalStats {
  total: number;
  open: number;
  win: number;
  loss: number;
  draw: number;
}

export interface Me {
  user: { telegramId: number; username: string | null; firstName: string; registeredAt: string; languageCode: string | null };
  settings: Settings;
  binding: BindingView;
  access: Record<string, boolean>;
  onboarding: OnboardingView;
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
  onboarding: (botId: string, token: string) =>
    request<{ onboarding: OnboardingView; binding: BindingView }>(`/api/miniapp/${botId}/onboarding`, { token }),
  register: (botId: string, token: string) =>
    request<{ link: string; onboarding: OnboardingView }>(`/api/miniapp/${botId}/onboarding/register`, { method: 'POST', token }),
  returned: (botId: string, token: string) =>
    request<{ onboarding: OnboardingView }>(`/api/miniapp/${botId}/onboarding/returned`, { method: 'POST', token }),
  overview: (botId: string, token: string, mode: MarketMode) => request<Overview>(`/api/miniapp/${botId}/market/${mode}/overview`, { token }),
  candles: (botId: string, token: string, mode: MarketMode, instrumentId: string, count = 48) =>
    request<CandlesResponse>(`/api/miniapp/${botId}/market/${mode}/candles?instrument=${encodeURIComponent(instrumentId)}&count=${count}`, { token }),
  createSignal: (botId: string, token: string, mode: MarketMode, instrumentId: string, periodSec: number) =>
    request<{ signal: DemoSignal }>(`/api/miniapp/${botId}/market/${mode}/signals`, { method: 'POST', token, body: JSON.stringify({ instrumentId, periodSec }) }),
  signals: (botId: string, token: string, mode: MarketMode) =>
    request<{ signals: DemoSignal[]; stats: SignalStats }>(`/api/miniapp/${botId}/signals?mode=${mode}`, { token }),
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
    PARTNER_LINK_MISSING: 'errors.partnerLinkMissing',
    MARKET_CLOSED: 'errors.marketClosed',
    MARKET_DISABLED: 'errors.marketDisabled',
    SIGNAL_LIMIT: 'errors.signalLimit',
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
