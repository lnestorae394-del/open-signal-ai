import { SUPPORTED_LANGUAGES, type Lang } from '@open-signal/i18n';
import { IconAcademy, IconProfile, IconSignal, LogoMark, cx } from '@open-signal/ui';
import { useApp, type Tab } from '../state.tsx';
import { haptic } from '../lib/telegram.ts';

export const LOCALE: Record<Lang, string> = { ru: 'ru-RU', uk: 'uk-UA', en: 'en-GB' };

export function Header({ title, subtitle }: { title: string; subtitle?: string }) {
  const { me, setTab, config } = useApp();
  const initial = (me?.user.firstName ?? '').slice(0, 1).toUpperCase();
  return (
    <header className="flex items-center justify-between gap-3 px-5 pb-2 pt-4">
      <div className="flex min-w-0 items-center gap-3">
        <LogoMark size={34} src={config?.logoUrl ?? null} />
        <div className="min-w-0 leading-tight">
          <div className="truncate text-[15px] font-semibold tracking-[-0.01em]">{title}</div>
          {subtitle ? <div className="truncate text-[13px] text-muted">{subtitle}</div> : null}
        </div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <LanguageSwitcher />
        {me ? (
          <button
            type="button"
            onClick={() => setTab('profile')}
            className="grid h-9 w-9 place-items-center rounded-full bg-white/[0.08] text-[13px] font-semibold"
            aria-label={me.user.firstName}
          >
            {initial}
          </button>
        ) : null}
      </div>
    </header>
  );
}

export function LanguageSwitcher() {
  const { lang, setLang, t } = useApp();
  return (
    <div className="flex rounded-full bg-white/[0.06] p-0.5" role="group" aria-label={t('common.language')}>
      {SUPPORTED_LANGUAGES.map((l) => (
        <button
          key={l}
          type="button"
          aria-pressed={l === lang}
          onClick={() => {
            if (l !== lang) haptic();
            setLang(l);
          }}
          className={cx('h-8 rounded-full px-2.5 text-[12px] font-semibold uppercase transition-colors', l === lang ? 'bg-fg text-bg' : 'text-muted')}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

const TABS: { id: Tab; icon: typeof IconSignal; key: string }[] = [
  { id: 'signals', icon: IconSignal, key: 'nav.signals' },
  { id: 'academy', icon: IconAcademy, key: 'nav.academy' },
  { id: 'profile', icon: IconProfile, key: 'nav.profile' },
];

/** Floating tab bar above the Telegram safe area. */
export function BottomNav() {
  const { tab, setTab, t } = useApp();
  return (
    <nav className="bottom-nav fixed inset-x-0 bottom-0 z-20 px-3" aria-label="Main">
      <ul className="mx-auto grid max-w-xs grid-cols-3 rounded-[26px] border border-line bg-[color-mix(in_srgb,var(--os-surface)_88%,transparent)] px-1 py-1.5 shadow-[0_20px_50px_-20px_rgb(0_0_0/0.9)] backdrop-blur-xl">
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
                className={cx('relative flex w-full flex-col items-center gap-0.5 rounded-2xl py-1.5 text-[11px] font-medium transition-colors duration-200', active ? 'text-fg' : 'text-muted')}
              >
                <Icon size={22} className={active ? 'text-primary' : ''} />
                <span className="max-w-full truncate px-0.5">{t(key)}</span>
                <span className={cx('absolute -bottom-0.5 h-[3px] w-5 rounded-full bg-primary transition-opacity duration-300', active ? 'opacity-100' : 'opacity-0')} />
              </button>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
