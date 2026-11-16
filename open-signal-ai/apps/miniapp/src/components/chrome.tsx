import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Lang } from '@open-signal/i18n';
import { IconAcademy, IconHistory, IconPairs, IconProfile, IconSignal, LogoMark, cx } from '@open-signal/ui';
import { useApp, type Tab } from '../state.tsx';
import { haptic } from '../lib/telegram.ts';

export const LOCALE: Record<Lang, string> = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-GB' };

export function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  const { me, setTab } = useApp();
  const initial = (me?.user.firstName ?? '·').slice(0, 1).toUpperCase();
  return (
    <header className="flex items-center justify-between gap-3 px-4 pb-4 pt-4">
      <div className="flex min-w-0 items-center gap-3">
        <LogoMark size={38} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[15px] font-extrabold tracking-[0.14em]">{title}</div>
          {subtitle ? <div className="truncate text-xs text-muted">{subtitle}</div> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <LanguageSwitcher />
        <button
          type="button"
          onClick={() => setTab('profile')}
          className="grid h-9 w-9 place-items-center rounded-full border border-line-strong bg-white/[0.04] text-sm font-bold"
          aria-label="Profile"
        >
          {initial}
        </button>
      </div>
    </header>
  );
}

export function LanguageSwitcher() {
  const { lang, setLang, t } = useApp();
  return (
    <label className="relative">
      <span className="sr-only">{t('common.language')}</span>
      <select
        value={lang}
        onChange={(e) => {
          haptic();
          setLang(e.target.value as Lang);
        }}
        className="h-9 appearance-none rounded-full border border-line-strong bg-white/[0.04] pl-3 pr-7 text-xs font-bold uppercase tracking-wider text-fg outline-none"
      >
        {SUPPORTED_LANGUAGES.map((l) => (
          <option key={l} value={l} title={LANGUAGE_LABELS[l]} className="bg-card text-fg">
            {l.toUpperCase()}
          </option>
        ))}
      </select>
      <span className="pointer-events-none absolute right-2.5 top-1/2 -translate-y-1/2 text-[10px] text-muted">▾</span>
    </label>
  );
}

const TABS: { id: Tab; icon: typeof IconSignal; key: string }[] = [
  { id: 'signals', icon: IconSignal, key: 'nav.signals' },
  { id: 'pairs', icon: IconPairs, key: 'nav.pairs' },
  { id: 'history', icon: IconHistory, key: 'nav.history' },
  { id: 'academy', icon: IconAcademy, key: 'nav.academy' },
  { id: 'profile', icon: IconProfile, key: 'nav.profile' },
];

export function BottomNav() {
  const { tab, setTab, t } = useApp();
  return (
    <nav className="bottom-nav fixed inset-x-0 bottom-0 z-20 border-t border-line pt-2" aria-label="Main">
      <ul className="mx-auto grid max-w-lg grid-cols-5 px-2">
        {TABS.map(({ id, icon: Icon, key }) => {
          const active = id === tab;
          return (
            <li key={id}>
              <button
                type="button"
                onClick={() => {
                  if (!active) haptic();
                  setTab(id);
                }}
                aria-current={active ? 'page' : undefined}
                className={cx(
                  'relative flex w-full flex-col items-center gap-1 rounded-xl py-1.5 text-[10.5px] font-semibold transition-colors duration-200',
                  active ? 'text-fg' : 'text-muted',
                )}
              >
                <span
                  className={cx(
                    'grid h-8 w-12 place-items-center rounded-full transition-all duration-300',
                    active ? 'bg-primary/18 text-primary' : '',
                  )}
                >
                  <Icon size={21} />
                </span>
                <span className="max-w-full truncate px-0.5">{t(key)}</span>
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
