import { useCallback, useEffect, useMemo, useState } from 'react';
import { findInstrument, type SignalCategory } from '@open-signal/shared';
import { Button, IconArrowDown, IconArrowUp, IconChevron, IconClose, IconInfo, IconSearch, IconStar, Segmented, Spinner, cx } from '@open-signal/ui';
import { Header, LOCALE } from '../components/chrome.tsx';
import { ApiError, api, errorKey, type Signal, type SignalConfig } from '../lib/api.ts';
import { getWebApp, haptic } from '../lib/telegram.ts';
import { useApp } from '../state.tsx';

const symbolOf = (id: string) => findInstrument(id)?.symbol.replace(' OTC', '') ?? id;

function formatForexOpening(iso: string, locale: string): string {
  const brokerTime = new Date(Date.parse(iso) + 2 * 60 * 60 * 1000);
  return new Intl.DateTimeFormat(locale, {
    weekday: 'short',
    hour: '2-digit',
    minute: '2-digit',
    timeZone: 'UTC',
  }).format(brokerTime);
}

function PairDots({ id, size = 32 }: { id: string; size?: number }) {
  const inst = findInstrument(id);
  const fs = size < 30 ? 8.5 : 9.5;
  return (
    <div className="relative shrink-0" style={{ width: size * 1.62, height: size }} aria-hidden>
      <span className="absolute left-0 top-0 grid place-items-center rounded-full bg-white/[0.09] font-semibold tracking-tight" style={{ width: size, height: size, fontSize: fs, paddingRight: size * 0.3 }}>
        {inst?.base}
      </span>
      <span className="absolute top-0 grid place-items-center rounded-full border-2 border-card bg-[#26262b] font-semibold tracking-tight" style={{ left: size * 0.62, width: size, height: size, fontSize: fs }}>
        {inst?.quote}
      </span>
    </div>
  );
}

/** "15 s", "1 min" — in the interface language. */
function usePeriodLabel() {
  const { lang } = useApp();
  return useCallback(
    (sec: number) => new Intl.NumberFormat(LOCALE[lang], { style: 'unit', unit: sec < 60 ? 'second' : 'minute', unitDisplay: 'short' }).format(sec < 60 ? sec : sec / 60),
    [lang],
  );
}

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const id = setInterval(() => setNow(Date.now()), 250);
    return () => clearInterval(id);
  }, [active]);
  return now;
}

type Flow = { kind: 'idle' } | { kind: 'analyzing' } | { kind: 'result'; signal: Signal } | { kind: 'running'; signal: Signal } | { kind: 'done'; signal: Signal };

const MIN_ANALYSIS_MS = 1600;

export function SignalsScreen() {
  const { t, lang, config, botId, token, favorites } = useApp();
  const periodLabel = usePeriodLabel();
  const [cfg, setCfg] = useState<SignalConfig | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [instrument, setInstrument] = useState<string | null>(null);
  const [period, setPeriod] = useState<number | null>(null);
  const [picker, setPicker] = useState(false);
  const [flow, setFlow] = useState<Flow>({ kind: 'idle' });
  const [error, setError] = useState<string | null>(null);

  // Settings + the latest signal, so a relaunch during a trade continues where it was.
  useEffect(() => {
    if (!botId || !token) return;
    let alive = true;
    void (async () => {
      try {
        const [c, recent] = await Promise.all([api.signalConfig(botId, token), api.signals(botId, token, 1)]);
        if (!alive) return;
        setCfg(c);
        const all = c.categories.flatMap((x) => x.instruments);
        const last = recent.signals[0];
        setInstrument(last && all.includes(last.instrumentId) ? last.instrumentId : (all.find((id) => favorites.includes(id)) ?? all[0] ?? null));
        setPeriod(last && c.periods.includes(last.periodSec) ? last.periodSec : c.defaultPeriod);
        if (last?.status === 'open') setFlow({ kind: 'running', signal: last });
        else if (last?.status === 'issued' && Date.now() - Date.parse(last.createdAt) < 10 * 60_000) setFlow({ kind: 'result', signal: last });
      } catch (e) {
        if (alive) setLoadError(t(errorKey(e instanceof ApiError ? e.code : 'NETWORK')));
      }
    })();
    return () => {
      alive = false;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [botId, token]);

  const get = async () => {
    if (!botId || !token || !instrument || !period) return;
    setError(null);
    const started = Date.now();
    try {
      if (findInstrument(instrument)?.market === 'forex') {
        const freshConfig = await api.signalConfig(botId, token);
        setCfg(freshConfig);
        const session = freshConfig.forexSessions[instrument];
        if (session && !session.open) {
          setError(t('errors.forexMarketClosed', { time: formatForexOpening(session.nextChangeAt, LOCALE[lang]) }));
          setFlow({ kind: 'idle' });
          haptic('error');
          return;
        }
      }
      setFlow({ kind: 'analyzing' });
      haptic();
      const analysisStarted = Date.now();
      const { signal } = await api.createSignal(botId, token, instrument, period);
      // Short, honest pause for the transition; the decision itself is instant.
      await new Promise((r) => setTimeout(r, Math.max(0, MIN_ANALYSIS_MS - (Date.now() - analysisStarted))));
      setFlow({ kind: 'result', signal });
      haptic('success');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'NETWORK';
      const wait = e instanceof ApiError ? (e.payload as { error?: { retryAfterSec?: number } } | null)?.error?.retryAfterSec : undefined;
      let closedSession = code === 'FOREX_MARKET_CLOSED' ? cfg?.forexSessions?.[instrument] : null;
      if (code === 'FOREX_MARKET_CLOSED' && botId && token) {
        try {
          const latest = await api.signalConfig(botId, token);
          setCfg(latest);
          closedSession = latest.forexSessions[instrument] ?? closedSession;
        } catch {
          // Keep the most recent known opening time if a follow-up refresh fails.
        }
      }
      setError(code === 'FOREX_MARKET_CLOSED'
        ? t('errors.forexMarketClosed', { time: closedSession ? formatForexOpening(closedSession.nextChangeAt, LOCALE[lang]) : '—' })
        : t(errorKey(code), { seconds: wait ?? cfg?.cooldownSec ?? 30 }));
      setFlow({ kind: 'idle' });
      haptic('error');
    }
  };

  const open = async (signal: Signal) => {
    if (!botId || !token) return;
    try {
      const r = await api.openSignal(botId, token, signal.id);
      setFlow({ kind: 'running', signal: r.signal });
      haptic('success');
    } catch (e) {
      setError(t(errorKey(e instanceof ApiError ? e.code : 'NETWORK')));
    }
  };

  // Telegram BackButton closes the pair sheet.
  useEffect(() => {
    const bb = getWebApp()?.BackButton;
    if (!bb || !picker) return;
    const close = () => setPicker(false);
    bb.show();
    bb.onClick(close);
    return () => {
      bb.offClick(close);
      bb.hide();
    };
  }, [picker]);

  if (!config) return null;
  const training = cfg?.engine !== 'analysis';
  const busy = flow.kind !== 'idle';

  return (
    <div>
      <Header title={config.miniAppTitle} />
      <div className="flex flex-col gap-5 px-4 pt-3">
        {loadError ? (
          <p className="px-1 text-[14px] text-danger">{loadError}</p>
        ) : !cfg || !instrument || !period ? (
          <div className="grid h-64 place-items-center"><Spinner /></div>
        ) : flow.kind === 'analyzing' ? (
          <Analyzing instrument={instrument} period={period} training={training} />
        ) : flow.kind === 'result' ? (
          <Result signal={flow.signal} onOpen={() => void open(flow.signal)} onNew={() => setFlow({ kind: 'idle' })} />
        ) : flow.kind === 'running' ? (
          <Running signal={flow.signal} onDone={() => setFlow({ kind: 'done', signal: flow.signal })} />
        ) : flow.kind === 'done' ? (
          <Done signal={flow.signal} onNext={() => setFlow({ kind: 'idle' })} />
        ) : (
          <>
            <section aria-labelledby="pair-label">
              <h2 id="pair-label" className="mb-2 px-1 text-[13px] text-muted">{t('sig.pair')}</h2>
              <button
                type="button"
                onClick={() => setPicker(true)}
                className="os-panel flex w-full items-center gap-3 px-4 py-4 text-left transition-colors active:bg-white/[0.04]"
              >
                <PairDots id={instrument} />
                <span className="min-w-0 flex-1">
                  <span className="block text-[18px] font-semibold tracking-[-0.01em]">{symbolOf(instrument)}</span>
                  <span className="block text-[12px] text-muted">{findInstrument(instrument)?.market === 'otc' ? 'OTC' : 'Forex'}</span>
                </span>
                <span className="text-[13px] text-muted">{t('sig.change')}</span>
                <IconChevron size={18} className="text-muted" />
              </button>
            </section>

            <section aria-labelledby="time-label">
              <h2 id="time-label" className="mb-2 px-1 text-[13px] text-muted">{t('sig.time')}</h2>
              <div className="grid grid-cols-3 gap-2" role="radiogroup" aria-labelledby="time-label">
                {cfg.periods.map((p) => {
                  const on = p === period;
                  return (
                    <button
                      key={p}
                      type="button"
                      role="radio"
                      aria-checked={on}
                      onClick={() => {
                        if (!on) haptic();
                        setPeriod(p);
                      }}
                      className={cx(
                        'os-num h-12 rounded-2xl text-[15px] font-semibold transition-all duration-200',
                        on ? 'bg-fg text-bg shadow-[0_10px_30px_-12px_rgb(255_255_255/0.35)]' : 'bg-white/[0.06] text-fg/85 active:bg-white/[0.1]',
                      )}
                    >
                      {periodLabel(p)}
                    </button>
                  );
                })}
              </div>
            </section>

            <div>
              <Button size="lg" block disabled={busy} onClick={() => void get()}>{t('sig.get')}</Button>
              {error ? <p className="mt-2 px-1 text-[13px] text-danger">{error}</p> : null}
            </div>

            {training ? (
              <p className="flex items-start gap-2 px-1 pb-2 text-[12px] leading-relaxed text-muted/90">
                <IconInfo size={14} className="mt-0.5 shrink-0" />
                {t('sig.trainingNote')}
              </p>
            ) : null}
          </>
        )}
      </div>
      {picker && cfg ? (
        <PairSheet
          categories={cfg.categories}
          selected={instrument}
          onPick={(id) => {
            setInstrument(id);
            setPicker(false);
            haptic();
          }}
          onClose={() => setPicker(false)}
        />
      ) : null}
    </div>
  );
}

/** Full-height sheet: Forex / OTC / Favorites, search, a scrolling list that never leaves the screen. */
function PairSheet({ categories, selected, onPick, onClose }: { categories: SignalConfig['categories']; selected: string | null; onPick: (id: string) => void; onClose: () => void }) {
  const { t, favorites, toggleFavorite } = useApp();
  const initial = (findInstrument(selected ?? '')?.market as SignalCategory | undefined) ?? categories[0]?.id ?? 'forex';
  const [tab, setTab] = useState<SignalCategory | 'favorites'>(initial);
  const [q, setQ] = useState('');
  const all = useMemo(() => categories.flatMap((c) => c.instruments), [categories]);
  const list = useMemo(() => {
    const base = tab === 'favorites' ? all.filter((id) => favorites.includes(id)) : (categories.find((c) => c.id === tab)?.instruments ?? []);
    const needle = q.trim().toUpperCase().replace(/[\s/]/g, '');
    return needle ? base.filter((id) => id.replace('_OTC', '').includes(needle)) : base;
  }, [tab, q, all, categories, favorites]);

  return (
    <div className="fixed inset-0 z-40 flex flex-col bg-bg/95 backdrop-blur-xl" role="dialog" aria-modal="true" aria-label={t('sig.pair')}>
      <div className="app-shell-onb mx-auto flex min-h-0 w-full max-w-lg flex-1 flex-col px-4">
        <div className="flex items-center justify-between gap-3 pb-3 pt-4">
          <h2 className="text-[20px] font-semibold tracking-[-0.01em]">{t('sig.choosePair')}</h2>
          <button type="button" onClick={onClose} className="grid h-10 w-10 place-items-center rounded-full bg-white/[0.08]" aria-label={t('common.close')}>
            <IconClose size={18} />
          </button>
        </div>
        <Segmented
          block
          ariaLabel={t('sig.pair')}
          value={tab}
          onChange={setTab}
          options={[
            ...categories.map((c) => ({ value: c.id, label: c.id === 'forex' ? 'Forex' : 'OTC' })),
            { value: 'favorites' as const, label: <span className="inline-flex items-center gap-1"><IconStar size={14} filled /> {t('pairs.favorites')}</span> },
          ]}
        />
        <label className="relative mt-3 block">
          <span className="sr-only">{t('common.search')}</span>
          <IconSearch size={18} className="pointer-events-none absolute left-4 top-1/2 -translate-y-1/2 text-muted" />
          <input
            type="search"
            value={q}
            onChange={(e) => setQ(e.target.value)}
            placeholder={t('pairs.searchPlaceholder')}
            className="h-12 w-full rounded-2xl bg-white/[0.06] pl-11 pr-4 text-[15px] text-fg outline-none placeholder:text-muted/70 focus:bg-white/[0.09]"
          />
        </label>
        <div className="mt-3 min-h-0 flex-1 overflow-y-auto overscroll-contain pb-6">
          {list.length ? (
            <ul className="os-panel os-rows overflow-hidden">
              {list.map((id) => {
                const fav = favorites.includes(id);
                const on = id === selected;
                return (
                  <li key={id} className="flex items-center pr-2">
                    <button type="button" onClick={() => onPick(id)} aria-current={on ? 'true' : undefined} className="flex min-w-0 flex-1 items-center gap-3 px-4 py-3 text-left">
                      <PairDots id={id} size={28} />
                      <span className="min-w-0 flex-1">
                        <span className="block truncate text-[16px] font-semibold">{symbolOf(id)}</span>
                        <span className="block text-[12px] text-muted">{findInstrument(id)?.market === 'otc' ? 'OTC' : 'Forex'}</span>
                      </span>
                      {on ? <span className="h-2 w-2 shrink-0 rounded-full bg-primary" aria-hidden /> : null}
                    </button>
                    <button
                      type="button"
                      onClick={() => toggleFavorite(id)}
                      aria-pressed={fav}
                      aria-label={t(fav ? 'pairs.removeFavorite' : 'pairs.addFavorite', { symbol: symbolOf(id) })}
                      className={cx('grid h-10 w-10 shrink-0 place-items-center rounded-full', fav ? 'text-accent' : 'text-muted')}
                    >
                      <IconStar size={20} filled={fav} />
                    </button>
                  </li>
                );
              })}
            </ul>
          ) : (
            <p className="px-2 py-10 text-center text-[14px] text-muted">{tab === 'favorites' && !q ? t('pairs.favoritesEmpty') : t('pairs.nothingFound')}</p>
          )}
        </div>
      </div>
    </div>
  );
}

function Analyzing({ instrument, period, training }: { instrument: string; period: number; training: boolean }) {
  const { t } = useApp();
  const periodLabel = usePeriodLabel();
  return (
    <section className="os-enter flex flex-col items-center px-2 pt-10 text-center" aria-live="polite" aria-busy="true">
      <div className="relative grid h-36 w-36 place-items-center">
        <span className="absolute inset-0 rounded-full border border-white/[0.08]" />
        <span className="os-orbit absolute inset-0 rounded-full border-2 border-transparent border-t-primary" />
        <span className="os-orbit absolute inset-4 rounded-full border border-transparent border-b-white/40 [animation-direction:reverse] [animation-duration:2.4s]" />
        <PairDots id={instrument} size={30} />
      </div>
      <h1 className="os-display mt-8 text-[26px] leading-tight">{training ? t('sig.preparing') : t('sig.analyzing')}</h1>
      <p className="mt-2 text-[14px] text-muted">{symbolOf(instrument)}, {periodLabel(period)}</p>
      <div className="mt-8 h-1.5 w-full max-w-xs overflow-hidden rounded-full bg-white/[0.08]" role="progressbar" aria-label={t('sig.progress')}>
        <div className="os-fill h-full rounded-full bg-primary" style={{ ['--dur' as string]: `${MIN_ANALYSIS_MS}ms` }} />
      </div>
      {training ? <p className="mt-6 max-w-xs text-[12px] leading-relaxed text-muted">{t('sig.trainingShort')}</p> : null}
    </section>
  );
}

/**
 * Training RSI / MACD strength, 15–85 %. Random, not market data: derived from the
 * signal's random id, so each signal gets its own values and they stay the same on
 * every re-render and relaunch.
 */
function trainingIndicators(id: string): { rsi: number; macd: number } {
  let h = 2166136261;
  for (let i = 0; i < id.length; i++) h = Math.imul(h ^ id.charCodeAt(i), 16777619);
  const next = () => {
    h = Math.imul(h ^ (h >>> 15), 2246822507);
    h = Math.imul(h ^ (h >>> 13), 3266489909);
    h ^= h >>> 16;
    return h >>> 0;
  };
  return { rsi: 15 + (next() % 71), macd: 15 + (next() % 71) };
}

function DirectionCard({ signal }: { signal: Signal }) {
  const { t } = useApp();
  const periodLabel = usePeriodLabel();
  const buy = signal.direction === 'buy';
  const indicators = useMemo(() => trainingIndicators(signal.id), [signal.id]);
  return (
    <div
      data-dir={signal.direction}
      className={cx('os-signal os-signal-card relative overflow-hidden rounded-[28px] border px-6 pb-7 pt-6 text-center', buy ? 'border-success/30 bg-success/[0.07]' : 'border-primary/30 bg-primary/[0.07]')}
    >
      <div className="flex items-center justify-between text-[13px] text-muted">
        <span className="flex items-center gap-2"><PairDots id={signal.instrumentId} size={28} /> {symbolOf(signal.instrumentId)}</span>
        <span className="os-num">{periodLabel(signal.periodSec)}</span>
      </div>
      <div className={cx('os-signal-mark mx-auto mt-6 grid h-20 w-20 place-items-center rounded-full', buy ? 'bg-success/15 text-success' : 'bg-primary/15 text-primary')}>
        {buy ? <IconArrowUp size={38} strokeWidth={2.2} /> : <IconArrowDown size={38} strokeWidth={2.2} />}
      </div>
      <div className={cx('os-display mt-4 text-[64px] leading-none', buy ? 'text-success' : 'text-primary')}>{buy ? 'BUY' : 'SELL'}</div>
      <div className="mt-2 text-[14px] text-fg/80">{buy ? t('sig.buyHint') : t('sig.sellHint')}</div>
      <div className="mt-5 grid grid-cols-2 gap-2 text-left">
        {(['rsi', 'macd'] as const).map((k) => (
          <div key={k} className="rounded-2xl bg-white/[0.06] px-3.5 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[12px] font-semibold text-muted">{k.toUpperCase()}</span>
              <span className={cx('os-num text-[15px] font-semibold', buy ? 'text-success' : 'text-primary')}>{indicators[k]}%</span>
            </div>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/[0.08]" role="meter" aria-label={k.toUpperCase()} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indicators[k]}>
              <div className={cx('h-full rounded-full', buy ? 'bg-success' : 'bg-primary')} style={{ width: `${indicators[k]}%` }} />
            </div>
          </div>
        ))}
      </div>
      {signal.engine === 'training' ? <div className="mx-auto mt-4 w-fit rounded-full bg-white/[0.08] px-3 py-1 text-[12px] font-semibold text-fg/80">{t('sig.trainingBadge')}</div> : null}
    </div>
  );
}

function Result({ signal, onOpen, onNew }: { signal: Signal; onOpen: () => void; onNew: () => void }) {
  const { t } = useApp();
  return (
    <section className="flex flex-col gap-4 pt-2" aria-live="polite">
      <DirectionCard signal={signal} />
      <Button size="lg" block onClick={onOpen}>{t('sig.opened')}</Button>
      <Button variant="ghost" block onClick={onNew}>{t('sig.skip')}</Button>
      {signal.engine === 'training' ? <p className="px-1 text-[12px] leading-relaxed text-muted/90">{t('sig.trainingNote')}</p> : null}
    </section>
  );
}

function Running({ signal, onDone }: { signal: Signal; onDone: () => void }) {
  const now = useNow(true);
  const end = Date.parse(signal.expiresAt!);
  const start = Date.parse(signal.openedAt!);
  const left = Math.max(0, Math.ceil((end - now) / 1000));
  const progress = Math.min(1, Math.max(0, (now - start) / (end - start)));
  useEffect(() => {
    if (left === 0) {
      haptic('success');
      onDone();
    }
  }, [left, onDone]);
  const buy = signal.direction === 'buy';
  const R = 70;
  const C = 2 * Math.PI * R;
  const { t } = useApp();
  // Same values as on the signal card: both are derived from this signal's id.
  const indicators = useMemo(() => trainingIndicators(signal.id), [signal.id]);
  return (
    <section
      className="os-enter flex flex-col items-center justify-center pb-4 text-center"
      // Fills the space between the header and the bottom bar so the timer sits in the optical centre.
      style={{ minHeight: 'calc(var(--tg-viewport-stable-height, 100dvh) - var(--tg-safe-top) - var(--tg-content-top) - var(--tg-safe-bottom) - var(--tg-content-bottom) - 96px - 76px)' }}
      aria-live="polite"
    >
      <div className="relative grid h-48 w-48 place-items-center">
        <svg viewBox="0 0 160 160" className="absolute inset-0 -rotate-90" aria-hidden>
          <circle cx="80" cy="80" r={R} fill="none" stroke="currentColor" strokeWidth="6" className="text-white/[0.07]" />
          <circle cx="80" cy="80" r={R} fill="none" stroke="currentColor" strokeWidth="6" strokeLinecap="round" className={buy ? 'text-success' : 'text-primary'} strokeDasharray={C} strokeDashoffset={C * progress} style={{ transition: 'stroke-dashoffset 250ms linear' }} />
        </svg>
        <div>
          <div className="os-display os-num text-[46px] leading-none" role="timer">{`${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}`}</div>
          <div className={cx('mt-2 text-[14px] font-semibold', buy ? 'text-success' : 'text-primary')}>{buy ? 'BUY' : 'SELL'} {symbolOf(signal.instrumentId)}</div>
        </div>
      </div>
      <div className="mt-8 grid w-full max-w-xs grid-cols-2 gap-2 text-left">
        {(['rsi', 'macd'] as const).map((k) => (
          <div key={k} className="rounded-2xl bg-white/[0.06] px-3.5 py-3">
            <div className="flex items-baseline justify-between">
              <span className="text-[12px] font-semibold text-muted">{k.toUpperCase()}</span>
              <span className={cx('os-num text-[15px] font-semibold', buy ? 'text-success' : 'text-primary')}>{indicators[k]}%</span>
            </div>
            <div className="mt-2 h-1 w-full overflow-hidden rounded-full bg-white/[0.08]" role="meter" aria-label={k.toUpperCase()} aria-valuemin={0} aria-valuemax={100} aria-valuenow={indicators[k]}>
              <div className={cx('h-full rounded-full', buy ? 'bg-success' : 'bg-primary')} style={{ width: `${indicators[k]}%` }} />
            </div>
          </div>
        ))}
      </div>
      {signal.engine === 'training' ? <div className="mt-4 w-fit rounded-full bg-white/[0.08] px-3 py-1 text-[12px] font-semibold text-fg/80">{t('sig.trainingBadge')}</div> : null}
    </section>
  );
}

function Done({ signal, onNext }: { signal: Signal; onNext: () => void }) {
  const { t } = useApp();
  return (
    <section className="os-signal flex flex-col items-center pt-10 text-center" aria-live="polite">
      <div className="grid h-20 w-20 place-items-center rounded-full bg-white/[0.08] text-[30px]" aria-hidden>✓</div>
      <h1 className="os-display mt-6 text-[30px] leading-tight">{t('sig.doneTitle')}</h1>
      <p className="mt-3 max-w-xs text-[15px] leading-relaxed text-muted">{t('sig.doneText', { symbol: symbolOf(signal.instrumentId) })}</p>
      <Button className="mt-8" size="lg" block onClick={onNext}>{t('sig.next')}</Button>
    </section>
  );
}
