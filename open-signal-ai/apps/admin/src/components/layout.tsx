import { useEffect, useState, type ReactNode } from 'react';
import { SUPPORTED_LANGUAGES, LANGUAGE_LABELS, type Lang } from '@open-signal/i18n';
import { IconBot, IconGrid, IconMenu, IconProfile, IconShield, LogoMark, Spinner, cx } from '@open-signal/ui';
import { useI18n } from '../i18n.tsx';
import { useSession } from '../session.tsx';

/** Hash routes: #/, #/bots, #/bots/new, #/bots/:id/:tab, #/managers, #/account, #/invite/:token */
export function parseHash(): string[] {
  return window.location.hash.replace(/^#\/?/, '').split('/').filter(Boolean);
}

export function useRoute(): string[] {
  const [parts, setParts] = useState(parseHash);
  useEffect(() => {
    const on = () => {
      setParts(parseHash());
      window.scrollTo({ top: 0 });
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);
  return parts;
}

export function navigate(path: string): void {
  window.location.hash = path.startsWith('/') ? path : `/${path}`;
}

export function PageTitle({ title, subtitle, action, back }: { title: string; subtitle?: ReactNode; action?: ReactNode; back?: { href: string; label: string } }) {
  return (
    <div className="mb-8">
      {back ? (
        <a href={back.href} className="mb-3 inline-block text-[13px] text-muted hover:text-fg">
          ← {back.label}
        </a>
      ) : null}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <h1 className="os-display text-[36px] lg:text-[44px]">{title}</h1>
          {subtitle ? <div className="mt-2 text-[15px] text-muted">{subtitle}</div> : null}
        </div>
        {action}
      </div>
    </div>
  );
}

export function LangSelect() {
  const { lang, setLang } = useI18n();
  return (
    <div className="flex rounded-full bg-white/[0.06] p-0.5" role="group" aria-label="Language">
      {SUPPORTED_LANGUAGES.map((l: Lang) => (
        <button
          key={l}
          type="button"
          title={LANGUAGE_LABELS[l]}
          aria-pressed={l === lang}
          onClick={() => setLang(l)}
          className={cx('h-8 rounded-full px-2.5 text-[12px] font-semibold uppercase', l === lang ? 'bg-fg text-bg' : 'text-muted hover:text-fg')}
        >
          {l}
        </button>
      ))}
    </div>
  );
}

export function FullScreenCenter({ children }: { children: ReactNode }) {
  return <div className="os-canvas grid min-h-dvh place-items-center px-5 py-10">{children}</div>;
}

export function Loading() {
  return (
    <div className="grid place-items-center py-24">
      <Spinner />
    </div>
  );
}

export function Shell({ children, section }: { children: ReactNode; section: string }) {
  const { t } = useI18n();
  const { state, logout } = useSession();
  const [open, setOpen] = useState(false);
  const me = state.kind === 'signed-in' ? state.me : null;
  const items = [
    { id: 'dashboard', href: '#/', icon: IconGrid, label: t('admin.nav.dashboard') },
    { id: 'bots', href: '#/bots', icon: IconBot, label: t('admin.nav.bots') },
    ...(me?.role === 'owner' ? [{ id: 'managers', href: '#/managers', icon: IconShield, label: t('admin.nav.managers') }] : []),
    { id: 'account', href: '#/account', icon: IconProfile, label: t('admin.nav.account') },
  ];
  const nav = (
    <nav className="flex flex-col gap-0.5" aria-label="Admin">
      {items.map(({ id, href, icon: Icon, label }) => (
        <a
          key={id}
          href={href}
          onClick={() => setOpen(false)}
          aria-current={section === id ? 'page' : undefined}
          className={cx(
            'flex items-center gap-3 rounded-xl px-3 py-2.5 text-[14px] font-medium transition-colors',
            section === id ? 'bg-white/[0.07] text-fg' : 'text-muted hover:bg-white/[0.04] hover:text-fg',
          )}
        >
          <Icon size={19} className={section === id ? 'text-primary' : ''} />
          {label}
        </a>
      ))}
    </nav>
  );
  return (
    <div className="os-canvas min-h-dvh lg:grid lg:grid-cols-[248px_1fr]">
      <aside className="sticky top-0 hidden h-dvh flex-col gap-8 border-r border-line p-5 lg:flex">
        <div className="flex items-center gap-3">
          <LogoMark size={32} />
          <div className="leading-tight">
            <div className="text-[14px] font-semibold">Open Signal</div>
            <div className="text-[12px] text-muted">{t('admin.title')}</div>
          </div>
        </div>
        {nav}
        <div className="mt-auto flex flex-col gap-3">
          <LangSelect />
          {me ? (
            <div className="text-[12px] text-muted">
              <div className="truncate">{me.email}</div>
              <button type="button" onClick={() => void logout()} className="mt-1 font-semibold text-fg/80 hover:text-fg">
                {t('admin.auth.logout')}
              </button>
            </div>
          ) : null}
        </div>
      </aside>
      <div className="min-w-0">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-bg/80 px-4 py-3 backdrop-blur-xl lg:hidden">
          <div className="flex items-center gap-2.5">
            <LogoMark size={28} />
            <span className="text-[14px] font-semibold">Open Signal</span>
          </div>
          <div className="flex items-center gap-2">
            <LangSelect />
            <button type="button" onClick={() => setOpen((v) => !v)} aria-expanded={open} aria-label="Menu" className="grid h-9 w-9 place-items-center rounded-xl bg-white/[0.06]">
              <IconMenu size={19} />
            </button>
          </div>
        </header>
        {open ? (
          <div className="border-b border-line bg-surface p-3 lg:hidden">
            {nav}
            <button type="button" onClick={() => void logout()} className="mt-2 px-3 py-2 text-[14px] text-muted">
              {t('admin.auth.logout')}
            </button>
          </div>
        ) : null}
        <main className="mx-auto max-w-6xl px-4 py-8 lg:px-10 lg:py-12">{children}</main>
      </div>
    </div>
  );
}
