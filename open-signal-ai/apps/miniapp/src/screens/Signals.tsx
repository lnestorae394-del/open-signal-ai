import { useEffect, useState } from 'react';
import { forexSessionState } from '@open-signal/shared';
import { Badge, Button, Card, DataStatusBadge, EmptyState, IconGrid, IconInfo, IconLock, IconScan, IconSignal, Notice, SectionTitle, Segmented } from '@open-signal/ui';
import { Header, LOCALE } from '../components/chrome.tsx';
import { useApp } from '../state.tsx';

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

export function SignalsScreen() {
  const { t, lang, config, me, setTab, analysisMode, setAnalysisMode } = useApp();
  const now = useNow();
  const session = forexSessionState(now);
  const fmt = new Intl.DateTimeFormat(LOCALE[lang], { weekday: 'short', hour: '2-digit', minute: '2-digit' });
  const locked = me ? me.access['signals'] === false : false;

  return (
    <div className="os-rise">
      <Header title={config?.miniAppTitle ?? t('common.appName')} subtitle={t('signals.subtitle')} />

      <div className="flex flex-col gap-4 px-4">
        <Card hero>
          <div className="flex items-start justify-between gap-3">
            <div>
              <div className="text-xs font-semibold uppercase tracking-[0.14em] text-muted">{t('signals.marketTitle')}</div>
              <div className="mt-2 flex items-center gap-2.5">
                <span className={session.open ? 'os-glow-dot h-2.5 w-2.5 rounded-full bg-primary os-pulse' : 'h-2.5 w-2.5 rounded-full bg-muted/50'} />
                <span className="text-xl font-bold tracking-tight">{session.open ? t('signals.forexOpen') : t('signals.forexClosed')}</span>
              </div>
              <div className="mt-1.5 text-sm text-muted">
                {session.open
                  ? t('signals.nextClose', { time: fmt.format(session.nextChangeAt) })
                  : t('signals.nextOpen', { time: fmt.format(session.nextChangeAt) })}
              </div>
            </div>
            {session.open ? <Badge tone="primary">FOREX</Badge> : <DataStatusBadge status="MARKET_CLOSED" label={t('status.MARKET_CLOSED')} />}
          </div>
          <div className="mt-3 text-[11px] text-muted/80">{t('signals.calendarNote')}</div>
          <div className="mt-4 border-t border-line pt-4">
            <div className="flex items-center justify-between gap-2">
              <DataStatusBadge status="UNAVAILABLE" label={t('status.UNAVAILABLE')} />
              <span className="text-[11px] text-muted">{t('common.notConnected')}</span>
            </div>
            <p className="mt-2.5 text-[13px] leading-relaxed text-muted">{t('signals.sourceMissing')}</p>
          </div>
        </Card>

        <div className="flex flex-col gap-2">
          <Segmented
            block
            ariaLabel="Analysis mode"
            value={analysisMode}
            onChange={setAnalysisMode}
            options={[
              { value: 'BASIC', label: 'BASIC' },
              { value: 'FULL', label: 'FULL' },
            ]}
          />
          <p className="px-1 text-xs text-muted">{analysisMode === 'BASIC' ? t('signals.modeBasic') : t('signals.modeFull')}</p>
        </div>

        {locked ? (
          <Notice tone="warning" icon={<IconLock size={16} />}>
            <div className="flex flex-col items-start gap-2">
              <span>{t('errors.moduleLocked')}</span>
              <Button size="sm" variant="secondary" onClick={() => setTab('profile')}>{t('binding.submit')}</Button>
            </div>
          </Notice>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Button size="lg" icon={<IconScan size={20} />} disabled title={t('common.stageNote', { stage: 4 })}>
              {t('signals.autoScan')}
            </Button>
            <span className="text-center text-[11px] text-muted">{t('common.stageNote', { stage: 4 })}</span>
          </div>
          <Button size="lg" variant="secondary" icon={<IconGrid size={20} />} onClick={() => setTab('pairs')}>
            {t('signals.selectPair')}
          </Button>
        </div>

        <Card>
          <SectionTitle>{t('signals.recent')}</SectionTitle>
          <EmptyState icon={<IconSignal />} text={t('signals.recentEmpty')} />
        </Card>

        <p className="flex items-start gap-2 px-1 pb-2 text-[11px] leading-relaxed text-muted/80">
          <IconInfo size={14} className="mt-0.5 shrink-0" />
          {t('common.disclaimer')}
        </p>
      </div>
    </div>
  );
}
