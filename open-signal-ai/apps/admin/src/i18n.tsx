import { createContext, useContext, useEffect, useMemo, useState, type ReactNode } from 'react';
import { createTranslator, isLang, type Lang, type Translator } from '@open-signal/i18n';

interface I18nState {
  lang: Lang;
  setLang(l: Lang): void;
  t: Translator;
}

const Ctx = createContext<I18nState | null>(null);
const KEY = 'os-admin:lang';

function readLang(): Lang {
  try {
    const v = window.localStorage.getItem(KEY);
    return isLang(v) ? v : 'ru';
  } catch {
    return 'ru';
  }
}

export function I18nProvider({ children }: { children: ReactNode }) {
  const [lang, setLangState] = useState<Lang>(readLang);
  useEffect(() => {
    document.documentElement.lang = lang;
  }, [lang]);
  const value = useMemo<I18nState>(
    () => ({
      lang,
      t: createTranslator(lang),
      setLang: (l) => {
        setLangState(l);
        try {
          window.localStorage.setItem(KEY, l);
        } catch {
          /* ignore */
        }
      },
    }),
    [lang],
  );
  return <Ctx.Provider value={value}>{children}</Ctx.Provider>;
}

export function useI18n(): I18nState {
  const v = useContext(Ctx);
  if (!v) throw new Error('useI18n outside provider');
  return v;
}
