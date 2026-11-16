import { useEffect, useState } from 'react';
import { forexSessionState } from '@open-signal/shared';
import { Badge, Button, DataStatusBadge, EmptyState, IconGrid, IconInfo, IconLock, IconScan, IconSignal, Notice, Panel, Segmented } from '@open-signal/ui';
import { Header, LOCALE } from '../components/chrome.tsx';
import { WeekTape } from '../components/WeekTape.tsx';
import { useApp } from '../state.tsx';

function useNow(intervalMs = 30_000): Date {
  const [now, setNow] = useState(() => new Date());
  useEffect(() => {
    const id = setInterval(() => setNow(new Date()), intervalMs);
    return () => clearInterval(id);
  }, [intervalMs]);
  return now;
}

/** "in 2 days" / "in 5 hours" / "in 12 minutes" in the interface language. */
function relative(target: Date, now: Date, locale: string): string {
  const rtf = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' });
  const ms = target.getTime() - now.getTime();
  const h = ms / 3_600_000;
  if (Math.abs(h) >= 36) return rtf.format(Math.round(h / 24), 'day');
  if (Math.abs(h) >= 1) return rtf.format(Math.round(h), 'hour');
  return rtf.format(Math.max(1, Math.round(ms / 60_000)), 'minute');
}

export function SignalsScreen() {
  const { t, lang, config, me, setTab, analysisMode, setAnalysisMode } = useApp();
  const now = useNow();
  const session = forexSessionState(now);
  const locale = LOCALE[lang];
  const absolute = new Intl.DateTimeFormat(locale, { weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(session.nextChangeAt);
  const locked = me ? me.access['signals'] === false : false;

  return (
    <div>
      <Header title={config?.miniAppTitle ?? t('common.appName')} />

      <section className="os-enter px-5 pb-7 pt-6" aria-label={t('signals.marketTitle')}>
        <div className="flex items-center gap-2 text-[13px] text-muted">
          <span className={session.open ? 'os-live-dot os-pulse h-2 w-2 rounded-full bg-primary' : 'h-2 w-2 rounded-full bg-muted/60'} />
          {t('signals.marketTitle')}
          {!session.open ? <DataStatusBadge status="MARKET_CLOSED" label={t('status.MARKET_CLOSED')} /> : null}
        </div>
        <h1 className="os-display mt-3 text-[44px]">{session.open ? t('signals.forexOpen') : t('signals.forexClosed')}</h1>
        <p className="mt-3 text-[17px] text-fg/90">
          {session.open
            ? t('signals.nextClose', { time: relative(session.nextChangeAt, now, locale) })
            : t('signals.nextOpen', { time: relative(session.nextChangeAt, now, locale) })}
        </p>
        <p className="mt-0.5 text-[13px] text-muted">{t('signals.localTime', { time: absolute })}</p>
        <div className="mt-6">
          <WeekTape now={now} locale={locale} open={session.open} />
        </div>
        <p className="mt-3 text-[12px] text-muted/80">{t('signals.calendarNote')}</p>
      </section>

      <div className="flex flex-col gap-4 px-4">
        <Panel className="p-4">
          <div className="flex items-center justify-between gap-3">
            <span className="text-[15px] font-semibold">{t('signals.dataSource')}</span>
            <DataStatusBadge status="UNAVAILABLE" label={t('common.notConnected')} />
          </div>
          <p className="mt-2 text-[14px] leading-relaxed text-muted">{t('signals.sourceMissing')}</p>
        </Panel>

        <div>
          <div className="mb-2 px-1 text-[13px] text-muted">{t('signals.mode')}</div>
          <Segmented
            block
            ariaLabel={t('signals.mode')}
            value={analysisMode}
            onChange={setAnalysisMode}
            options={[
              { value: 'BASIC', label: 'BASIC' },
              { value: 'FULL', label: 'FULL' },
            ]}
          />
          <p className="mt-2 px-1 text-[13px] text-muted">{analysisMode === 'BASIC' ? t('signals.modeBasic') : t('signals.modeFull')}</p>
        </div>

        {locked ? (
          <Notice tone="warning" icon={<IconLock size={16} />}>
            <div className="flex flex-col items-start gap-2.5">
              <span>{t('errors.moduleLocked')}</span>
              <Button size="sm" variant="secondary" onClick={() => setTab('profile')}>{t('binding.submit')}</Button>
            </div>
          </Notice>
        ) : null}

        <div className="grid grid-cols-2 gap-3">
          <div className="flex flex-col gap-1.5">
            <Button size="lg" icon={<IconScan size={20} />} disabled>
              {t('signals.autoScan')}
            </Button>
            <span className="text-center text-[12px] text-muted">{t('common.notConnected')}</span>
          </div>
          <Button size="lg" variant="secondary" icon={<IconGrid size={20} />} onClick={() => setTab('pairs')}>
            {t('signals.selectPair')}
          </Button>
        </div>

        <Panel className="p-4">
          <div className="flex items-center justify-between">
            <span className="text-[15px] font-semibold">{t('signals.recent')}</span>
            <Badge>0</Badge>
          </div>
          <EmptyState icon={<IconSignal />} text={t('signals.recentEmpty')} />
        </Panel>

        <p className="flex items-start gap-2 px-1 pb-2 text-[12px] leading-relaxed text-muted/80">
          <IconInfo size={14} className="mt-0.5 shrink-0" />
          {t('common.disclaimer')}
        </p>
      </div>
    </div>
  );
}
