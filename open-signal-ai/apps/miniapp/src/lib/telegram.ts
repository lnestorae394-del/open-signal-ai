/**
 * Telegram WebApp integration (https://core.telegram.org/bots/webapps).
 * Every call is optional-chained: older clients lack newer methods, and outside
 * Telegram the object does not exist at all (preview mode).
 */
interface Inset {
  top: number;
  bottom: number;
  left: number;
  right: number;
}

export interface TelegramWebApp {
  initData: string;
  initDataUnsafe?: { start_param?: string; user?: { language_code?: string } };
  version?: string;
  platform?: string;
  colorScheme?: 'light' | 'dark';
  viewportStableHeight?: number;
  safeAreaInset?: Inset;
  contentSafeAreaInset?: Inset;
  ready(): void;
  expand(): void;
  setHeaderColor?(color: string): void;
  setBackgroundColor?(color: string): void;
  setBottomBarColor?(color: string): void;
  disableVerticalSwipes?(): void;
  onEvent?(event: string, cb: () => void): void;
  offEvent?(event: string, cb: () => void): void;
  openTelegramLink?(url: string): void;
  openLink?(url: string): void;
  isVersionAtLeast?(v: string): boolean;
  BackButton?: { show(): void; hide(): void; onClick(cb: () => void): void; offClick(cb: () => void): void };
  HapticFeedback?: { selectionChanged(): void; notificationOccurred(t: 'error' | 'success' | 'warning'): void };
}

declare global {
  interface Window {
    Telegram?: { WebApp?: TelegramWebApp };
  }
}

export function getWebApp(): TelegramWebApp | null {
  const wa = window.Telegram?.WebApp;
  // The script defines WebApp even in a normal browser; real launches carry signed initData.
  return wa && typeof wa.initData === 'string' ? wa : null;
}

export function isInsideTelegram(): boolean {
  return Boolean(getWebApp()?.initData);
}

function setPx(name: string, value: number | undefined) {
  document.documentElement.style.setProperty(name, `${Math.max(0, value ?? 0)}px`);
}

/** Initializes the WebApp and keeps safe-area / viewport CSS variables in sync. */
export function initTelegram(background: string): void {
  const wa = getWebApp();
  if (!wa || !wa.initData) return;
  wa.ready();
  wa.expand();
  wa.setHeaderColor?.(background);
  wa.setBackgroundColor?.(background);
  wa.setBottomBarColor?.(background);
  if (wa.isVersionAtLeast?.('7.7')) wa.disableVerticalSwipes?.();

  const sync = () => {
    setPx('--tg-safe-top', wa.safeAreaInset?.top);
    setPx('--tg-safe-bottom', wa.safeAreaInset?.bottom);
    setPx('--tg-content-top', wa.contentSafeAreaInset?.top);
    setPx('--tg-content-bottom', wa.contentSafeAreaInset?.bottom);
    if (wa.viewportStableHeight) setPx('--tg-viewport-stable-height', wa.viewportStableHeight);
  };
  sync();
  for (const e of ['safeAreaChanged', 'contentSafeAreaChanged', 'viewportChanged']) wa.onEvent?.(e, sync);
}

/** Bot id comes from our own Mini App URL (?bot=…) set when the bot is registered. */
export function resolveBotId(): string | null {
  const fromUrl = new URLSearchParams(window.location.search).get('bot');
  if (fromUrl && /^[A-Za-z0-9_-]{4,40}$/.test(fromUrl)) return fromUrl;
  return null;
}

export function haptic(kind: 'select' | 'success' | 'error' = 'select'): void {
  const h = getWebApp()?.HapticFeedback;
  if (!h) return;
  if (kind === 'select') h.selectionChanged();
  else h.notificationOccurred(kind);
}

export function openSupport(contact: string): void {
  const wa = getWebApp();
  const handle = contact.trim();
  if (!handle) return;
  if (handle.startsWith('@')) {
    const url = `https://t.me/${handle.slice(1)}`;
    if (wa?.openTelegramLink) wa.openTelegramLink(url);
    else window.open(url, '_blank', 'noopener');
  } else if (/^https?:\/\//.test(handle)) {
    if (wa?.openLink) wa.openLink(handle);
    else window.open(handle, '_blank', 'noopener');
  }
}
