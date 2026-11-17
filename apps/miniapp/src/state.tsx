import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, type PublicBotConfig } from '@open-signal/shared';
import { createTranslator, isLang, resolveLanguage, type Lang, type Translator } from '@open-signal/i18n';
import { applyTheme } from '@open-signal/ui/theme';
import { ApiError, api, safeStorage, type Me, type OnboardingView, type Settings } from './lib/api.ts';
import { getWebApp, initTelegram, isInsideTelegram, resolveBotId } from './lib/telegram.ts';

/** 'connect': a user with manual access finishes linking the account (opened from the profile). */
export type Tab = 'signals' | 'academy' | 'profile' | 'connect';

type Phase =
  | { kind: 'loading' }
  /** Opened outside Telegram: there is no verified user, so nothing but a pointer to the bot is shown. */
  | { kind: 'outside'; username: string | null }
  | { kind: 'error'; code: string }
  | { kind: 'ready' };

interface AppState {
  phase: Phase;
  botId: string | null;
  config: PublicBotConfig | null;
  /** Verified Telegram session. Every screen after loading requires it. */
  me: Me | null;
  token: string | null;
  lang: Lang;
  t: Translator;
  setLang(l: Lang): void;
  tab: Tab;
  setTab(t: Tab): void;
  favorites: string[];
  toggleFavorite(id: string): void;
  setOnboarding(o: OnboardingView): void;
  /** Reloads profile, binding, onboarding and progress from the server. */
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
  const [lang, setLangState] = useState<Lang>('ru');
  const [tab, setTab] = useState<Tab>('signals');
  const [attempt, setAttempt] = useState(0);
  const [favorites, setFavorites] = useState<string[]>([]);
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
        // Only a hint for the first paint; the language saved on the server wins after sign-in.
        setLangState(resolveLanguage(safeStorage.get(localKey('lang')), cfg.defaultLanguage, wa?.initDataUnsafe?.user?.language_code));
        if (cfg.status !== 'active') {
          setPhase({ kind: 'error', code: 'BOT_DISABLED' });
          return;
        }
        // No guest mode: without Telegram there is no verified user and no app.
        if (!isInsideTelegram()) {
          setPhase({ kind: 'outside', username: cfg.username || null });
          return;
        }
        if (!wa?.initData) {
          setPhase({ kind: 'error', code: 'INIT_DATA_INVALID' });
          return;
        }
        // 1) initData verified on the server  2) Telegram ID + botId → user from the database
        // 3) onboarding status computed there  4) the matching screen opens.
        const s = await api.session(botId, wa.initData);
        if (cancelled) return;
        setToken(s.session.token);
        setMe(s);
        setFavorites(s.settings.favorites);
        setLangState(resolveLanguage(s.settings.language, cfg.defaultLanguage, s.user.languageCode));
        setPhase({ kind: 'ready' });
      } catch (e) {
        if (cancelled) return;
        applyTheme(document.documentElement, config?.theme ?? DEFAULT_THEME);
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
    lang,
    t: useMemo(() => createTranslator(lang), [lang]),
    setLang,
    tab,
    setTab,
    favorites,
    toggleFavorite,
    setOnboarding: (o) => setMe((m) => (m ? { ...m, onboarding: o } : m)),
    refreshMe,
    retry: () => setAttempt((a) => a + 1),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
