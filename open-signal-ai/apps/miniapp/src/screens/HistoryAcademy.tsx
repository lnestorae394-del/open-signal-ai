import { useEffect, useState } from 'react';
import { EmptyState, IconChevron, IconHistory, Panel, Spinner, cx } from '@open-signal/ui';
import { Header, LOCALE } from '../components/chrome.tsx';
import { MarketSwitch, OutcomeBadge, SimulatedStrip, fmtPrice, periodLabel, symbolOf } from '../components/market.tsx';
import { ApiError, api, errorKey, type DemoSignal, type SignalStats } from '../lib/api.ts';
import { useApp } from '../state.tsx';

export function HistoryScreen() {
  const { t, lang, guest, marketMode: mode, botId, token, setTab } = useApp();
  const [data, setData] = useState<{ signals: DemoSignal[]; stats: SignalStats } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const locale = LOCALE[lang];
  const time = new Intl.DateTimeFormat(locale, { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' });

  useEffect(() => {
    if (!botId || !token) return;
    let alive = true;
    const load = () =>
      api.signals(botId, token, mode).then(
        (r) => alive && (setData(r), setError(null)),
        (e: unknown) => alive && setError(t(errorKey(e instanceof ApiError ? e.code : 'NETWORK'))),
      );
    setData(null);
    void load();
    const id = setInterval(() => void load(), 15_000);
    return () => {
      alive = false;
      clearInterval(id);
    };
  }, [botId, token, mode, t]);

  const stats = data?.stats;
  const closed = stats ? stats.win + stats.loss + stats.draw : 0;

  return (
    <div>
      <Header title={t('history.title')} />
      <div className="flex flex-col gap-4 px-4 pt-2">
        <MarketSwitch />
        <SimulatedStrip compact />
        {guest ? (
          <Panel><EmptyState icon={<IconHistory />} text={t('profile.guestText')} /></Panel>
        ) : !data ? (
          error ? <p className="px-1 text-[13px] text-danger">{error}</p> : <div className="grid h-40 place-items-center"><Spinner /></div>
        ) : (
          <>
            <section className="os-enter px-1 pt-1">
              <div className="text-[13px] text-muted">{t('history.statsTitle')}</div>
              <div className="mt-3 grid grid-cols-4 gap-2">
                {(['total', 'win', 'loss', 'open'] as const).map((k) => (
                  <div key={k}>
                    <div className={cx('os-display os-num text-[34px] leading-none', k === 'win' ? 'text-success' : k === 'loss' ? 'text-primary' : '')}>{stats![k]}</div>
                    <div className="mt-1 text-[12px] text-muted">{t(`history.stat.${k}`)}</div>
                  </div>
                ))}
              </div>
              <p className="mt-3 text-[12px] leading-relaxed text-muted">{closed ? t('history.statsNote', { draw: stats!.draw }) : t('history.statsEmpty')}</p>
            </section>
            {data.signals.length ? (
              <ul className="os-panel os-rows overflow-hidden">
                {data.signals.map((s) => {
                  const d = s.instrumentId.includes('JPY') ? 3 : 5;
                  return (
                    <li key={s.id} className="flex items-center gap-3 px-4 py-3">
                      <span className={cx('grid h-9 w-9 shrink-0 place-items-center rounded-xl text-[17px] font-bold', s.direction === 'up' ? 'bg-success/15 text-success' : 'bg-primary/15 text-primary')} aria-label={s.direction === 'up' ? t('demo.up') : t('demo.down')}>
                        {s.direction === 'up' ? '↑' : '↓'}
                      </span>
                      <div className="min-w-0 flex-1">
                        <div className="text-[15px] font-semibold">{symbolOf(s.instrumentId)}</div>
                        <div className="text-[12px] text-muted">{time.format(new Date(s.entryAt))}, {periodLabel(s.periodSec, locale)}</div>
                      </div>
                      <div className="text-right">
                        <OutcomeBadge outcome={s.outcome} label={t(`demo.outcome.${s.outcome}`)} />
                        <div className="os-num mt-1 text-[12px] text-muted">{fmtPrice(s.entryPrice, d)}{s.exitPrice !== null ? ` / ${fmtPrice(s.exitPrice, d)}` : ''}</div>
                      </div>
                    </li>
                  );
                })}
              </ul>
            ) : (
              <Panel>
                <EmptyState icon={<IconHistory />} text={t('history.empty')}>
                  <button type="button" onClick={() => setTab('signals')} className="text-[14px] font-semibold text-primary">{t('demo.get')}</button>
                </EmptyState>
              </Panel>
            )}
          </>
        )}
      </div>
    </div>
  );
}

/** The ten Smart Money lessons are a real sequence, so they are numbered. */
const LESSONS = ['l1', 'l2', 'l3', 'l4', 'l5', 'l6', 'l7', 'l8', 'l9', 'l10'] as const;

export function AcademyScreen() {
  const { t } = useApp();
  const [open, setOpen] = useState<string | null>(null);
  const done = 0; // real progress comes from academy_progress once lessons are published

  return (
    <div>
      <Header title={t('academy.title')} subtitle={t('academy.subtitle')} />
      <section className="os-enter px-5 pb-6 pt-5">
        <div className="flex items-end justify-between gap-4">
          <h1 className="os-display os-num text-[64px]">
            {done}
            <span className="text-muted/50">/{LESSONS.length}</span>
          </h1>
          <p className="max-w-[55%] pb-2 text-right text-[13px] text-muted">{t('academy.progress', { done, total: LESSONS.length })}</p>
        </div>
        <div className="mt-4 grid grid-cols-10 gap-1" aria-hidden>
          {LESSONS.map((id, i) => (
            <span key={id} className={cx('h-1.5 rounded-full', i < done ? 'bg-primary' : 'bg-white/[0.1]')} />
          ))}
        </div>
      </section>

      <div className="px-4">
        <div className="mb-2 px-1 text-[13px] text-muted">{t('academy.lessonsTitle')}</div>
        <ol className="os-panel os-rows overflow-hidden">
          {LESSONS.map((id, idx) => {
            const isOpen = open === id;
            return (
              <li key={id}>
                <button type="button" onClick={() => setOpen(isOpen ? null : id)} aria-expanded={isOpen} className="flex w-full items-center gap-4 px-4 py-3.5 text-left">
                  <span className="os-num w-6 shrink-0 text-[13px] font-semibold text-muted">{idx + 1}</span>
                  <span className="flex-1 text-[15px] font-medium">{t(`academy.lessons.${id}`)}</span>
                  <IconChevron size={18} className={cx('text-muted transition-transform duration-300', isOpen && 'rotate-90')} />
                </button>
                {isOpen ? <p className="px-4 pb-4 pl-14 text-[14px] leading-relaxed text-muted">{t('academy.contentPending')}</p> : null}
              </li>
            );
          })}
        </ol>
      </div>
    </div>
  );
}
