import type { Lang } from '@open-signal/i18n';
import type { DailyPoint } from './types.ts';

export const LOCALE: Record<Lang, string> = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-GB' };

export function dayLabel(isoDay: string, lang: Lang): string {
  return new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', timeZone: 'UTC' }).format(new Date(`${isoDay}T00:00:00Z`));
}

export function sum(days: DailyPoint[], metric: string): number {
  return days.reduce((n, d) => n + (d.metrics[metric] ?? 0), 0);
}

export function dateTime(iso: string | null | undefined, lang: Lang): string {
  if (!iso) return '—';
  return new Intl.DateTimeFormat(LOCALE[lang], { day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
}
