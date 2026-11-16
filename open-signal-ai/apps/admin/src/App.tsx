import { useEffect, useState } from 'react';
import { LANGUAGE_LABELS, SUPPORTED_LANGUAGES, type Lang } from '@open-signal/i18n';
import { IconAcademy, IconBot, IconGrid, IconLogs, IconMenu, IconShield, IconUsers, Notice, Wordmark, cx, IconInfo } from '@open-signal/ui';
import { useI18n } from './i18n.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { BotsPage } from './pages/Bots.tsx';
import { BotEditorPage } from './pages/BotEditor.tsx';
import { AcademyPage, LogsPage, ManagersPage, UsersPage } from './pages/Sections.tsx';
import { readRoute, type Route } from './components/layout.tsx';


const NAV: { route: Route; icon: typeof IconGrid; key: string }[] = [
  { route: 'dashboard', icon: IconGrid, key: 'admin.nav.dashboard' },
  { route: 'bots', icon: IconBot, key: 'admin.nav.bots' },
  { route: 'academy', icon: IconAcademy, key: 'admin.nav.academy' },
  { route: 'users', icon: IconUsers, key: 'admin.nav.users' },
  { route: 'logs', icon: IconLogs, key: 'admin.nav.logs' },
  { route: 'managers', icon: IconShield, key: 'admin.nav.managers' },
];

export function App() {
  const { t, lang, setLang } = useI18n();
  const [route, setRoute] = useState<Route>(readRoute);
  const [menuOpen, setMenuOpen] = useState(false);

  useEffect(() => {
    const on = () => {
      setRoute(readRoute());
      setMenuOpen(false);
    };
    window.addEventListener('hashchange', on);
    return () => window.removeEventListener('hashchange', on);
  }, []);

  const section = route.startsWith('bots') ? 'bots' : route;

  const nav = (
    <nav className="flex flex-col gap-1" aria-label="Admin">
      {NAV.map(({ route: r, icon: Icon, key }) => (
        <a
          key={r}
          href={`#/${r}`}
          aria-current={section === r ? 'page' : undefined}
          className={cx(
            'flex items-center gap-3 rounded-xl px-3 py-2.5 text-sm font-medium transition-colors',
            section === r ? 'bg-primary/14 text-fg shadow-[inset_0_0_0_1px_rgb(var(--os-primary-rgb)/0.3)]' : 'text-muted hover:bg-white/[0.04] hover:text-fg',
          )}
        >
          <Icon size={19} className={section === r ? 'text-primary' : ''} />
          {t(key)}
        </a>
      ))}
    </nav>
  );

  return (
    <div className="os-ambient min-h-dvh lg:grid lg:grid-cols-[260px_1fr]">
      <aside className="hidden border-r border-line bg-surface/60 p-5 lg:flex lg:flex-col lg:gap-8">
        <Wordmark title="OPEN SIGNAL AI" subtitle={t('admin.title')} />
        {nav}
        <div className="mt-auto">
          <LangSelect lang={lang} onChange={setLang} />
        </div>
      </aside>

      <div className="min-w-0">
        <header className="sticky top-0 z-10 flex items-center justify-between border-b border-line bg-bg/80 px-4 py-3 backdrop-blur-xl lg:hidden">
          <Wordmark title="OPEN SIGNAL AI" />
          <div className="flex items-center gap-2">
            <LangSelect lang={lang} onChange={setLang} compact />
            <button type="button" onClick={() => setMenuOpen((v) => !v)} aria-expanded={menuOpen} aria-label="Menu" className="grid h-10 w-10 place-items-center rounded-xl border border-line-strong">
              <IconMenu size={20} />
            </button>
          </div>
        </header>
        {menuOpen ? <div className="border-b border-line bg-surface p-3 lg:hidden">{nav}</div> : null}

        <main className="mx-auto max-w-6xl px-4 py-6 lg:px-10 lg:py-10">
          <div className="mb-6">
            <Notice tone="warning" icon={<IconInfo size={16} />}>{t('admin.devBanner')}</Notice>
          </div>
          {route === 'dashboard' && <DashboardPage />}
          {route === 'bots' && <BotsPage />}
          {route === 'bots/new' && <BotEditorPage />}
          {route === 'academy' && <AcademyPage />}
          {route === 'users' && <UsersPage />}
          {route === 'logs' && <LogsPage />}
          {route === 'managers' && <ManagersPage />}
        </main>
      </div>
    </div>
  );
}

function LangSelect({ lang, onChange, compact }: { lang: Lang; onChange: (l: Lang) => void; compact?: boolean }) {
  return (
    <select
      value={lang}
      onChange={(e) => onChange(e.target.value as Lang)}
      aria-label="Language"
      className="h-10 rounded-xl border border-line-strong bg-white/[0.04] px-3 text-sm text-fg outline-none"
    >
      {SUPPORTED_LANGUAGES.map((l) => (
        <option key={l} value={l} className="bg-card">
          {compact ? l.toUpperCase() : LANGUAGE_LABELS[l]}
        </option>
      ))}
    </select>
  );
}
