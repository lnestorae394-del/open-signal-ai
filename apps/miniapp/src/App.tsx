import { useEffect, type ReactNode } from 'react';
import { Button, LogoMark, Notice, Spinner } from '@open-signal/ui';
import { BottomNav } from './components/chrome.tsx';
import { errorKey } from './lib/api.ts';
import { getWebApp, isInsideTelegram } from './lib/telegram.ts';
import { AcademyScreen } from './screens/Academy.tsx';
import { OnboardingScreen } from './screens/Onboarding.tsx';
import { ProfileScreen } from './screens/Profile.tsx';
import { SignalsScreen } from './screens/Signals.tsx';
import { useApp } from './state.tsx';

function Centered({ children }: { children: ReactNode }) {
  return (
    <div className="os-canvas grid min-h-dvh place-items-center px-6">
      <div className="flex max-w-sm flex-col items-center gap-5 text-center">{children}</div>
    </div>
  );
}

export function App() {
  const { phase, tab, setTab, t, retry, me, config } = useApp();

  // Telegram BackButton on secondary tabs returns to Signals.
  useEffect(() => {
    const bb = getWebApp()?.BackButton;
    if (!bb || !isInsideTelegram() || me?.onboarding.status !== 'completed') return;
    const back = () => setTab('signals');
    if (tab === 'signals') bb.hide();
    else bb.show();
    bb.onClick(back);
    return () => bb.offClick(back);
  }, [tab, setTab, me?.onboarding.status]);

  if (phase.kind === 'loading') {
    return (
      <Centered>
        <LogoMark size={56} src={config?.logoUrl ?? null} />
        <Spinner />
      </Centered>
    );
  }

  if (phase.kind === 'outside') {
    return (
      <Centered>
        <LogoMark size={56} src={config?.logoUrl ?? null} />
        <h1 className="os-display text-[28px] leading-tight">{config?.miniAppTitle ?? t('common.appName')}</h1>
        <p className="text-[15px] leading-relaxed text-muted">{t('app.openInTelegram')}</p>
        {phase.username ? (
          <a className="os-btn-primary inline-flex h-12 items-center justify-center rounded-2xl px-6 text-[15px] font-semibold" href={`https://t.me/${phase.username}`}>
            {t('app.openBot', { username: `@${phase.username}` })}
          </a>
        ) : null}
      </Centered>
    );
  }

  if (phase.kind === 'error' || !me) {
    const code = phase.kind === 'error' ? phase.code : 'UNAUTHORIZED';
    return (
      <Centered>
        <LogoMark size={56} src={config?.logoUrl ?? null} />
        <Notice tone={code === 'BOT_DISABLED' ? 'warning' : 'danger'}>{t(errorKey(code))}</Notice>
        {code !== 'BOT_DISABLED' && code !== 'NOT_FOUND' ? <Button onClick={retry}>{t('common.retry')}</Button> : null}
      </Centered>
    );
  }

  // Onboarding is mandatory and chosen from the server-side state on every launch.
  if (me.onboarding.status !== 'completed') return <OnboardingScreen />;

  return (
    <div className="app-shell os-canvas">
      <main className="mx-auto max-w-lg">
        {tab === 'signals' && <SignalsScreen />}
        {tab === 'academy' && <AcademyScreen />}
        {tab === 'profile' && <ProfileScreen />}
      </main>
      <BottomNav />
    </div>
  );
}
