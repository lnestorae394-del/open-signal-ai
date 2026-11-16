import { useEffect } from 'react';
import { Button, LogoMark, Notice, Spinner } from '@open-signal/ui';
import { BottomNav } from './components/chrome.tsx';
import { errorKey } from './lib/api.ts';
import { getWebApp, isInsideTelegram } from './lib/telegram.ts';
import { AcademyScreen, HistoryScreen } from './screens/HistoryAcademy.tsx';
import { PairsScreen } from './screens/Pairs.tsx';
import { ProfileScreen } from './screens/Profile.tsx';
import { SignalsScreen } from './screens/Signals.tsx';
import { OnboardingScreen } from './screens/Onboarding.tsx';
import { useApp } from './state.tsx';

export function App() {
  const { phase, tab, setTab, t, guest, retry, me, browsing } = useApp();

  // Telegram BackButton: visible on secondary tabs, returns to Signals.
  useEffect(() => {
    const bb = getWebApp()?.BackButton;
    if (!bb || !isInsideTelegram()) return;
    const back = () => setTab('signals');
    if (tab === 'signals') bb.hide();
    else bb.show();
    bb.onClick(back);
    return () => bb.offClick(back);
  }, [tab, setTab]);

  if (phase.kind === 'loading') {
    return (
      <div className="os-canvas grid min-h-dvh place-items-center">
        <div className="flex flex-col items-center gap-5">
          <LogoMark size={56} />
          <Spinner />
        </div>
      </div>
    );
  }

  if (phase.kind === 'error') {
    return (
      <div className="os-canvas grid min-h-dvh place-items-center px-6">
        <div className="flex max-w-sm flex-col items-center gap-5 text-center">
          <LogoMark size={56} />
          <div className="text-[15px] font-extrabold tracking-[0.14em]">{t('common.appName')}</div>
          <Notice tone={phase.code === 'BOT_DISABLED' ? 'warning' : 'danger'}>{t(errorKey(phase.code))}</Notice>
          {phase.code === 'NETWORK' ? <Button onClick={retry}>{t('common.retry')}</Button> : null}
        </div>
      </div>
    );
  }

  // Onboarding is chosen from the server-side status on every launch; the user can
  // still open the Academy and demo first (they never require registration or a deposit).
  if (me && me.onboarding.status !== 'completed' && !browsing) return <OnboardingScreen />;

  return (
    <div className="app-shell os-canvas">
      <main className="mx-auto max-w-lg">
        {guest ? (
          <div className="px-4 pt-3">
            <Notice tone="info">{t('profile.guestText')}</Notice>
          </div>
        ) : null}
        {tab === 'signals' && <SignalsScreen />}
        {tab === 'pairs' && <PairsScreen />}
        {tab === 'history' && <HistoryScreen />}
        {tab === 'academy' && <AcademyScreen />}
        {tab === 'profile' && <ProfileScreen />}
      </main>
      <BottomNav />
    </div>
  );
}
