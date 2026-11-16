import { Button, Notice } from '@open-signal/ui';
import { useI18n } from './i18n.tsx';
import { useSession } from './session.tsx';
import { FullScreenCenter, Loading, Shell, useRoute } from './components/layout.tsx';
import { InvitePage, LoginPage, SetupPage } from './pages/Auth.tsx';
import { DashboardPage } from './pages/Dashboard.tsx';
import { BotNewPage, BotsPage } from './pages/Bots.tsx';
import { BotDetailPage } from './pages/BotDetail.tsx';
import { AccountPage, ManagersPage } from './pages/People.tsx';
import { SettingsPage, UsersPage } from './pages/Sections.tsx';

export function App() {
  const { t } = useI18n();
  const { state, refresh } = useSession();
  const route = useRoute();

  if (route[0] === 'invite' && route[1] && state.kind !== 'signed-in') return <InvitePage token={route[1]} />;
  if (state.kind === 'loading') return <FullScreenCenter><Loading /></FullScreenCenter>;
  if (state.kind === 'error') {
    return (
      <FullScreenCenter>
        <div className="flex max-w-sm flex-col items-center gap-4 text-center">
          <Notice tone="danger">{t('errors.network')}</Notice>
          <Button onClick={() => void refresh()}>{t('common.retry')}</Button>
        </div>
      </FullScreenCenter>
    );
  }
  if (state.kind === 'setup') return <SetupPage />;
  if (state.kind === 'signed-out') return <LoginPage />;

  const [first, second, third] = route;
  let section = 'dashboard';
  let page = <DashboardPage />;
  if (first === 'bots' && second === 'new') {
    section = 'bots';
    page = <BotNewPage />;
  } else if (first === 'bots' && second) {
    section = 'bots';
    page = <BotDetailPage key={second} botId={second} tab={third} />;
  } else if (first === 'bots') {
    section = 'bots';
    page = <BotsPage />;
  } else if (first === 'managers' && state.me.role === 'owner') {
    section = 'managers';
    page = <ManagersPage />;
  } else if (first === 'users') {
    section = 'users';
    page = <UsersPage />;
  } else if (first === 'settings') {
    section = 'settings';
    page = <SettingsPage />;
  } else if (first === 'account') {
    section = 'account';
    page = <AccountPage />;
  }
  return <Shell section={section}>{page}</Shell>;
}
