import type { BindingState, DepositCheckStatus, DepositStatus, OnboardingStatus, PublicBotConfig, SignalCategory, SignalEngineKind } from '@open-signal/shared';
import type { Lang } from '@open-signal/i18n';

/** Admin panel, Mini App and API are served from one origin, so API paths are relative. */
export const API_URL = '';

export interface BindingView {
  enabled: boolean;
  state: BindingState;
  traderIdMasked: string | null;
  lastError: string | null;
  showSupport: boolean;
  supportContact: string;
}

export interface Settings {
  language: Lang | null;
  favorites: string[];
}

export interface DepositView {
  status: DepositStatus;
  check: DepositCheckStatus;
  checkReason: 'below_threshold' | 'amount_conflict' | 'no_amount' | 'currency' | 'no_ftd_event' | null;
  sourceConnected: boolean;
  thresholdUsd: number;
  ftdAmount: number | null;
  ftdCurrency: string | null;
  ftdAt: string | null;
  depositsCount: number;
  lastDepositAt: string | null;
}

/** Onboarding state — always derived on the server from the stored user record. */
export interface OnboardingView {
  status: OnboardingStatus;
  registrationStartedAt: string | null;
  traderIdMasked: string | null;
  verification: 'not_submitted' | 'failed' | 'confirmed' | 'review';
  lastError: string | null;
  deposit: DepositView;
  partner: { configured: boolean };
}

export interface Me {
  user: { telegramId: number; username: string | null; firstName: string; registeredAt: string; languageCode: string | null; botName: string; traderId: string | null };
  settings: Settings;
  binding: BindingView;
  onboarding: OnboardingView;
  academy: { done: number; total: number };
}

export interface SessionResponse extends Me {
  session: { token: string; expiresAt: string };
}

export interface SignalConfig {
  engine: SignalEngineKind;
  categories: { id: SignalCategory; instruments: string[] }[];
  periods: number[];
  defaultPeriod: number;
  cooldownSec: number;
}

export interface Signal {
  id: string;
  instrumentId: string;
  category: SignalCategory;
  periodSec: number;
  direction: 'buy' | 'sell';
  engine: SignalEngineKind;
  createdAt: string;
  openedAt: string | null;
  expiresAt: string | null;
  status: 'issued' | 'open' | 'completed';
}

export type Localized = { ru?: string; uk?: string; en?: string };

export interface CatalogLesson {
  id: string;
  categoryId: string;
  title: Localized;
  summary: Localized;
  durationMin: number;
  hasVideo: boolean;
  hasPdf: boolean;
}

export interface Catalog {
  builtIn: boolean;
  categories: { id: string; title: Localized; lessons: CatalogLesson[] }[];
}

export interface Lesson extends CatalogLesson {
  body: Localized;
  videoUrl: string | null;
  pdfUrl: string | null;
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
    request<{ binding: BindingView; onboarding: OnboardingView }>(`/api/miniapp/${botId}/binding/trader-id`, { method: 'POST', token, body: JSON.stringify({ traderId }) }),
  onboarding: (botId: string, token: string) =>
    request<{ onboarding: OnboardingView; binding: BindingView }>(`/api/miniapp/${botId}/onboarding`, { token }),
  register: (botId: string, token: string) =>
    request<{ link: string; onboarding: OnboardingView }>(`/api/miniapp/${botId}/onboarding/register`, { method: 'POST', token }),
  returned: (botId: string, token: string) =>
    request<{ onboarding: OnboardingView }>(`/api/miniapp/${botId}/onboarding/returned`, { method: 'POST', token }),
  restart: (botId: string, token: string) =>
    request<{ onboarding: OnboardingView }>(`/api/miniapp/${botId}/onboarding/restart`, { method: 'POST', token }),
  signalConfig: (botId: string, token: string) => request<SignalConfig>(`/api/miniapp/${botId}/signals/config`, { token }),
  createSignal: (botId: string, token: string, instrumentId: string, periodSec: number) =>
    request<{ signal: Signal }>(`/api/miniapp/${botId}/signals`, { method: 'POST', token, body: JSON.stringify({ instrumentId, periodSec }) }),
  signals: (botId: string, token: string, limit = 20) => request<{ signals: Signal[] }>(`/api/miniapp/${botId}/signals?limit=${limit}`, { token }),
  openSignal: (botId: string, token: string, id: string) =>
    request<{ signal: Signal }>(`/api/miniapp/${botId}/signals/${encodeURIComponent(id)}/open`, { method: 'POST', token }),
  academy: (botId: string, token: string) => request<{ catalog: Catalog; progress: Record<string, string> }>(`/api/miniapp/${botId}/academy`, { token }),
  lesson: (botId: string, token: string, id: string) => request<{ lesson: Lesson }>(`/api/miniapp/${botId}/academy/lessons/${encodeURIComponent(id)}`, { token }),
  setLessonDone: (botId: string, token: string, id: string, done: boolean) =>
    request<{ progress: Record<string, string> }>(`/api/miniapp/${botId}/academy/lessons/${encodeURIComponent(id)}/progress`, { method: 'PUT', token, body: JSON.stringify({ done }) }),
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
    REGISTRATION_NOT_CONFIRMED: 'errors.registrationNotConfirmed',
    CLICK_MISMATCH: 'errors.clickMismatch',
    TRADER_ID_TAKEN: 'errors.traderIdTaken',
    ONBOARDING_REQUIRED: 'errors.onboardingRequired',
    PARTNER_LINK_MISSING: 'errors.partnerLinkMissing',
    SIGNAL_COOLDOWN: 'errors.signalCooldown',
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
