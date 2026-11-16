import en from './locales/en.json' with { type: 'json' };
import ru from './locales/ru.json' with { type: 'json' };
import uk from './locales/uk.json' with { type: 'json' };

export const SUPPORTED_LANGUAGES = ['ru', 'uk', 'en'] as const;
export type Lang = (typeof SUPPORTED_LANGUAGES)[number];

type Dict = { [key: string]: string | Dict };

export const dictionaries: Record<Lang, Dict> = { ru, uk, en };

export function isLang(value: unknown): value is Lang {
  return typeof value === 'string' && (SUPPORTED_LANGUAGES as readonly string[]).includes(value);
}

/** Flattens a nested dictionary into dot-separated keys. */
export function flatten(dict: Dict, prefix = ''): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(dict)) {
    const key = prefix ? `${prefix}.${k}` : k;
    if (typeof v === 'string') out[key] = v;
    else Object.assign(out, flatten(v, key));
  }
  return out;
}

const flat: Record<Lang, Record<string, string>> = {
  ru: flatten(ru),
  uk: flatten(uk),
  en: flatten(en),
};

export type TParams = Record<string, string | number>;
export type Translator = (key: string, params?: TParams) => string;

/**
 * Translates a key in exactly one language. There is intentionally NO fallback
 * to another language (languages must never be mixed in one interface); a
 * missing key renders as the key itself, and the completeness test catches it.
 */
export function translate(lang: Lang, key: string, params?: TParams): string {
  const template = flat[lang][key];
  if (template === undefined) return key;
  if (!params) return template;
  return template.replace(/\{(\w+)\}/g, (m, name: string) =>
    params[name] === undefined ? m : String(params[name]),
  );
}

export function createTranslator(lang: Lang): Translator {
  return (key, params) => translate(lang, key, params);
}

/**
 * Picks the interface language: explicit user choice → bot default →
 * Telegram language_code → Russian.
 */
export function resolveLanguage(
  userChoice: string | null | undefined,
  botDefault: string | null | undefined,
  telegramLanguageCode: string | null | undefined,
): Lang {
  if (isLang(userChoice)) return userChoice;
  if (isLang(botDefault)) return botDefault;
  const tg = telegramLanguageCode?.slice(0, 2).toLowerCase();
  if (isLang(tg)) return tg;
  return 'ru';
}

export const LANGUAGE_LABELS: Record<Lang, string> = {
  ru: 'Русский',
  uk: 'Українська',
  en: 'English',
};
