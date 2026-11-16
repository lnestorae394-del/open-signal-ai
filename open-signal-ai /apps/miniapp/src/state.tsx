import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, type MarketMode, type PublicBotConfig } from '@open-signal/shared';
import { createTranslator, isLang, resolveLanguage, type Lang, type Translator } from '@open-signal/i18n';
import { applyTheme } from '@open-signal/ui/theme';
import { ApiError, api, safeStorage, type BindingView, type Me, type OnboardingView, type Settings } from './lib/api.ts';
import { getWebApp, initTelegram, isInsideTelegram, resolveBotId } from './lib/telegram.ts';

export type Tab = 'signals' | 'pairs' | 'history' | 'academy' | 'profile';

type Phase =
  | { kind: 'loading' }
  | { kind: 'error'; code: string }
  | { kind: 'ready' };

interface AppState {
  phase: Phase;
  botId: string | null;
  config: PublicBotConfig | null;
  /** Verified Telegram session (null in browser preview or if sign-in failed). */
  me: Me | null;
  token: string | null;
  authError: string | null;
  guest: boolean;
  lang: Lang;
  t: Translator;
  setLang(l: Lang): void;
  tab: Tab;
  setTab(t: Tab): void;
  favorites: string[];
  toggleFavorite(id: string): void;
  /** Forex or OTC — saved on the server, so it follows the user to any device. */
  marketMode: MarketMode;
  setMarketMode(m: MarketMode): void;
  /** Instrument selected on the Signals screen, per mode. */
  instrument: Record<MarketMode, string | null>;
  selectInstrument(mode: MarketMode, id: string): void;
  /** The user chose to look at the Academy and demo before finishing onboarding (this launch only). */
  browsing: boolean;
  setBrowsing(v: boolean): void;
  setOnboarding(o: OnboardingView): void;
  setBinding(b: BindingView): void;
  /** Reloads profile, binding, access and onboarding from the server. */
  refreshMe(): Promise<void>;
  retry(): void;
}

const Ctx = createContext<AppState | null>(null);

export function useApp(): AppState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useApp outside provider');
  return v;
}

export function AppProvider({ children }: { children: ReactNode }) {
  const botId = useMemo(resolveBotId, []);
  const [phase, setPhase] = useState<Phase>({ kind: 'loading' });
  const [config, setConfig] = useState<PublicBotConfig | null>(null);
  const [me, setMe] = useState<Me | null>(null);
  const [token, setToken] = useState<string | null>(null);
  const [authError, setAuthError] = useState<string | null>(null);
  const [lang, setLangState] = useState<Lang>('ru');
  const [tab, setTab] = useState<Tab>('signals');
  const [attempt, setAttempt] = useState(0);
  const [favorites, setFavorites] = useState<string[]>([]);
  const [marketMode, setMode] = useState<MarketMode>('forex');
  const [instrument, setInstrument] = useState<Record<MarketMode, string | null>>({ forex: null, otc: null });
  const [browsing, setBrowsing] = useState(false);
  const localKey = (k: string) => `os:${botId ?? 'none'}:${k}`;

  useEffect(() => {
    let cancelled = false;
    (async () => {
      setPhase({ kind: 'loading' });
      if (!botId) {
        applyTheme(document.documentElement, DEFAULT_THEME);
        setPhase({ kind: 'error', code: 'NOT_FOUND' });
        return;
      }
      try {
        const cfg = await api.publicConfig(botId);
        if (cancelled) return;
        applyTheme(document.documentElement, cfg.theme);
        document.title = cfg.miniAppTitle;
        initTelegram(cfg.theme.background);
        setConfig(cfg);
        const wa = getWebApp();
        // Only a language hint for the very first paint; the server copy wins after sign-in.
        setLangState(resolveLanguage(safeStorage.get(localKey('lang')), cfg.defaultLanguage, wa?.initDataUnsafe?.user?.language_code));
        const firstEnabled: MarketMode = cfg.markets.forex.enabled ? 'forex' : 'otc';
        setMode(firstEnabled);
        if (cfg.status !== 'active') {
          setPhase({ kind: 'error', code: 'BOT_DISABLED' });
          return;
        }
        if (isInsideTelegram() && wa) {
          try {
            // 1) initData is verified on the server  2) Telegram ID + botId → user from the database
            // 3) onboarding status comes back with it  4) App opens the matching screen.
            const s = await api.session(botId, wa.initData);
            if (cancelled) return;
            setToken(s.session.token);
            setMe(s);
            setFavorites(s.settings.favorites);
            if (cfg.markets[s.settings.marketMode]?.enabled) setMode(s.settings.marketMode);
            setLangState(resolveLanguage(s.settings.language, cfg.defaultLanguage, s.user.languageCode));
          } catch (e) {
            setAuthError(e instanceof ApiError ? e.code : 'INTERNAL');
          }
        }
        setPhase({ kind: 'ready' });
      } catch (e) {
        applyTheme(document.documentElement, DEFAULT_THEME);
        setPhase({ kind: 'error', code: e instanceof ApiError ? e.code : 'NETWORK' });
      }
    })();
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, attempt]);

  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);

  const persist = useCallback(
    (patch: Partial<Settings>) => {
      if (botId && token) void api.saveSettings(botId, token, patch).catch(() => undefined);
    },
    [botId, token],
  );

  const setLang = useCallback(
    (l: Lang) => {
      if (!isLang(l)) return;
      setLangState(l);
      safeStorage.set(localKey('lang'), l);
      persist({ language: l });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persist],
  );

  const toggleFavorite = useCallback(
    (id: string) => {
      setFavorites((prev) => {
        const next = prev.includes(id) ? prev.filter((x) => x !== id) : [...prev, id];
        persist({ favorites: next });
        return next;
      });
    },
    [persist],
  );

  const setMarketMode = useCallback(
    (m: MarketMode) => {
      setMode(m);
      persist({ marketMode: m });
    },
    [persist],
  );

  const refreshMe = useCallback(async () => {
    if (!botId || !token) return;
    const fresh = await api.me(botId, token).catch(() => null);
    if (fresh) setMe(fresh);
  }, [botId, token]);

  const value: AppState = {
    phase,
    botId,
    config,
    me,
    token,
    authError,
    guest: !me,
    lang,
    t: useMemo(() => createTranslator(lang), [lang]),
    setLang,
    tab,
    setTab,
    favorites,
    toggleFavorite,
    marketMode,
    setMarketMode,
    instrument,
    selectInstrument: (mode, id) => setInstrument((s) => ({ ...s, [mode]: id })),
    browsing,
    setBrowsing,
    setOnboarding: (o) => setMe((m) => (m ? { ...m, onboarding: o } : m)),
    setBinding: (b) => {
      setMe((m) => (m ? { ...m, binding: b } : m));
      // Access and onboarding depend on the binding state — reload them from the server, never compute on the client.
      void refreshMe();
    },
    refreshMe,
    retry: () => setAttempt((a) => a + 1),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
