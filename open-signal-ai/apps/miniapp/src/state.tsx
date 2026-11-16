import { createContext, useCallback, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { DEFAULT_THEME, type PublicBotConfig } from '@open-signal/shared';
import { createTranslator, isLang, resolveLanguage, type Lang, type Translator } from '@open-signal/i18n';
import { applyTheme } from '@open-signal/ui/theme';
import { ApiError, api, safeStorage, type BindingView, type Me, type Settings } from './lib/api.ts';
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
  analysisMode: Settings['analysisMode'];
  setAnalysisMode(m: Settings['analysisMode']): void;
  setBinding(b: BindingView): void;
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
  const localKey = (k: string) => `os:${botId ?? 'none'}:${k}`;
  const [favorites, setFavorites] = useState<string[]>(() => {
    try {
      return JSON.parse(safeStorage.get(localKey('favorites')) ?? '[]') as string[];
    } catch {
      return [];
    }
  });
  const [analysisMode, setMode] = useState<Settings['analysisMode']>('BASIC');

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
        const stored = safeStorage.get(localKey('lang'));
        setLangState(resolveLanguage(stored, cfg.defaultLanguage, wa?.initDataUnsafe?.user?.language_code));
        if (cfg.status !== 'active') {
          setPhase({ kind: 'error', code: 'BOT_DISABLED' });
          return;
        }
        if (isInsideTelegram() && wa) {
          try {
            const s = await api.session(botId, wa.initData);
            if (cancelled) return;
            setToken(s.session.token);
            setMe(s);
            setFavorites(s.settings.favorites);
            setMode(s.settings.analysisMode);
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
        safeStorage.set(localKey('favorites'), JSON.stringify(next));
        persist({ favorites: next });
        return next;
      });
    },
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [persist],
  );

  const setAnalysisMode = useCallback(
    (m: Settings['analysisMode']) => {
      setMode(m);
      persist({ analysisMode: m });
    },
    [persist],
  );

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
    analysisMode,
    setAnalysisMode,
    setBinding: (b) => {
      setMe((m) => (m ? { ...m, binding: b } : m));
      // Access map depends on binding state — reload it from the server, never compute it on the client.
      if (botId && token) void api.me(botId, token).then(setMe).catch(() => undefined);
    },
    retry: () => setAttempt((a) => a + 1),
  };
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}
