import { useCallback, useEffect, useState } from 'react';
import { forexSessionState, type MarketMode } from '@open-signal/shared';
import { Button, IconChevron, IconInfo, Notice, Panel, Segmented, Spinner, cx } from '@open-signal/ui';
import { Header, LOCALE } from '../components/chrome.tsx';
import { CandleChart, MarketSwitch, OutcomeBadge, PairDots, SimulatedStrip, fmtPct, fmtPrice, periodLabel, symbolOf, useTicker } from '../components/market.tsx';
import { ApiError, api, errorKey, type CandlesResponse, type DemoSignal } from '../lib/api.ts';
import { haptic } from '../lib/telegram.ts';
import { useApp } from '../state.tsx';

/** Instrument shown on the Signals screen: the user's pick, else the first favorite of this mode, else the first instrument. */
export function useCurrentInstrument(mode: MarketMode): string | null {
  const { config, instrument, favorites } = useApp();
  const list = config?.markets[mode].instruments ?? [];
  const picked = instrument[mode];
  if (picked && list.includes(picked)) return picked;
  return list.find((id) => favorites.includes(id)) ?? list[0] ?? null;
}

export function SignalsScreen() {
  const { t, lang, config, guest, marketMode: mode, setTab, botId, token } = useApp();
  const locale = LOCALE[lang];
  const instrumentId = useCurrentInstrument(mode);
  const settings = config?.markets[mode];
  const [data, setData] = useState<CandlesResponse | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [period, setPeriod] = useState<number>(settings?.defaultPeriod ?? 60);
  const [signal, setSignal] = useState<DemoSignal | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (settings) setPeriod(settings.defaultPeriod);
    setSignal(null);
    setError(null);
  }, [mode, settings]);

  const load = useCallback(async () => {
    if (!botId || !token || !instrumentId) return;
    try {
      setData(await api.candles(botId, token, mode, instrumentId));
      setLoadError(null);
    } catch (e) {
      setLoadError(t(errorKey(e instanceof ApiError ? e.code : 'NETWORK')));
    }
  }, [botId, token, mode, instrumentId, t]);

  useEffect(() => {
    setData(null);
    void load();
    const id = setInterval(() => void load(), 5000);
    return () => clearInterval(id);
  }, [load]);

  const create = async () => {
    if (!botId || !token || !instrumentId) return;
    setBusy(true);
    setError(null);
    try {
      const r = await api.createSignal(botId, token, mode, instrumentId, period);
      setSignal(r.signal);
      haptic('success');
    } catch (e) {
      const code = e instanceof ApiError ? e.code : 'NETWORK';
      const wait = e instanceof ApiError ? (e.payload as { error?: { retryAfterSec?: number } } | null)?.error?.retryAfterSec : undefined;
      setError(code === 'RECHECK_TOO_SOON' ? t('demo.cooldown', { seconds: wait ?? 30 }) : t(errorKey(code)));
      haptic('error');
    } finally {
      setBusy(false);
    }
  };

  if (!config || !settings) return null;

  const quote = data?.quote;
  const closed = data ? !data.marketOpen : false;
  const session = forexSessionState(new Date());

  return (
    <div>
      <Header title={config.miniAppTitle} />
      <div className="flex flex-col gap-4 px-4 pt-2">
        <MarketSwitch />
        <SimulatedStrip />

        {guest ? (
          <Notice tone="info">{t('profile.guestText')}</Notice>
        ) : !instrumentId ? null : (
          <>
            <section className="os-enter px-1 pt-2" aria-live="polite">
              <button type="button" onClick={() => setTab('pairs')} className="flex items-center gap-3 rounded-2xl text-left">
                <PairDots id={instrumentId} />
                <span className="text-[17px] font-semibold tracking-[-0.01em]">{symbolOf(instrumentId)}</span>
                {mode === 'otc' ? <span className="text-[12px] font-semibold text-warning">OTC</span> : null}
                <IconChevron size={18} className="text-muted" />
              </button>
              <div className="mt-4 flex items-end gap-3">
                <h1 className="os-display os-num text-[46px] leading-none">{quote ? fmtPrice(quote.price, quote.decimals) : '—'}</h1>
                {quote ? (
                  <span className={cx('os-num mb-1.5 text-[15px] font-semibold', quote.changePct >= 0 ? 'text-success' : 'text-primary')}>{fmtPct(quote.changePct)}</span>
                ) : null}
              </div>
              <p className="mt-1.5 text-[13px] text-muted">{t('market.syntheticPrice', { tf: periodLabel(data?.timeframeSec ?? settings.timeframeSec, locale) })}</p>
            </section>

            <Panel className="px-3 pb-3 pt-4">
              {data ? (
                <CandleChart candles={data.candles} rsi={data.rsi} decimals={data.quote.decimals} label={t('market.chartLabel', { symbol: symbolOf(instrumentId) })} />
              ) : loadError ? (
                <p className="px-2 py-10 text-center text-[14px] text-muted">{loadError}</p>
              ) : (
                <div className="grid h-52 place-items-center"><Spinner /></div>
              )}
            </Panel>

            {closed ? (
              <Notice tone="neutral">{t('market.forexClosed', { time: new Intl.DateTimeFormat(locale, { weekday: 'long', hour: '2-digit', minute: '2-digit' }).format(session.nextChangeAt) })}</Notice>
            ) : null}

            <div>
              <div className="mb-2 px-1 text-[13px] text-muted">{t('demo.period')}</div>
              <Segmented block ariaLabel={t('demo.period')} value={String(period)} onChange={(v: string) => setPeriod(Number(v))} options={settings.periods.map((p) => ({ value: String(p), label: periodLabel(p, locale) }))} />
            </div>

            <Button size="lg" block busy={busy} disabled={closed || !data} onClick={() => void create()}>
              {t('demo.get')}
            </Button>
            {error ? <p className="-mt-1 px-1 text-[13px] text-danger">{error}</p> : null}

            {signal ? <SignalCard signal={signal} onResolved={setSignal} /> : null}
          </>
        )}

        <p className="flex items-start gap-2 px-1 pb-2 text-[12px] leading-relaxed text-muted/80">
          <IconInfo size={14} className="mt-0.5 shrink-0" />
          {t('demo.disclaimer')}
        </p>
      </div>
    </div>
  );
}

/** The demo signal just created: direction, why, countdown, then the simulated outcome. */
function SignalCard({ signal, onResolved }: { signal: DemoSignal; onResolved: (s: DemoSignal) => void }) {
  const { t, lang, botId, token, setTab } = useApp();
  const now = useTicker(1000);
  const left = Math.max(0, Math.ceil((Date.parse(signal.expiresAt) - now) / 1000));
  const decimals = signal.instrumentId.includes('JPY') ? 3 : 5;

  useEffect(() => {
    if (signal.outcome !== 'open' || left > 0 || !botId || !token) return;
    const id = setTimeout(() => {
      void api.signals(botId, token, signal.mode).then((r) => {
        const fresh = r.signals.find((s) => s.id === signal.id);
        if (fresh) onResolved(fresh);
      });
    }, 800);
    return () => clearTimeout(id);
  }, [left, signal, botId, token, onResolved]);

  const up = signal.direction === 'up';
  return (
    <Panel className="os-enter p-4">
      <div className="flex items-center justify-between gap-3">
        <span className="text-[13px] text-muted">{t('demo.signalTitle')}</span>
        <OutcomeBadge outcome={signal.outcome} label={t(`demo.outcome.${signal.outcome}`)} />
      </div>
      <div className="mt-3 flex items-center gap-4">
        <div className={cx('grid h-14 w-14 shrink-0 place-items-center rounded-2xl text-[26px] font-bold', up ? 'bg-success/15 text-success' : 'bg-primary/15 text-primary')} aria-hidden>
          {up ? '↑' : '↓'}
        </div>
        <div className="min-w-0">
          <div className="os-display text-[28px] leading-tight">{up ? t('demo.up') : t('demo.down')}</div>
          <div className="text-[14px] text-muted">{symbolOf(signal.instrumentId)}{signal.mode === 'otc' ? ' OTC' : ''}, {periodLabel(signal.periodSec, LOCALE[lang])}</div>
        </div>
      </div>
      <p className="mt-3 text-[14px] leading-relaxed text-fg/85">{t(`demo.basis.${signal.basis}`, { rsi: signal.rsi ?? '—' })}</p>
      <dl className="mt-4 grid grid-cols-2 gap-3 text-[14px]">
        <div>
          <dt className="text-[12px] text-muted">{t('demo.entry')}</dt>
          <dd className="os-num mt-0.5 font-semibold">{fmtPrice(signal.entryPrice, decimals)}</dd>
        </div>
        <div>
          <dt className="text-[12px] text-muted">{signal.outcome === 'open' ? t('demo.left') : t('demo.exit')}</dt>
          <dd className="os-num mt-0.5 font-semibold">
            {signal.outcome === 'open' ? `${Math.floor(left / 60)}:${String(left % 60).padStart(2, '0')}` : signal.exitPrice !== null ? fmtPrice(signal.exitPrice, decimals) : '—'}
          </dd>
        </div>
      </dl>
      <button type="button" onClick={() => setTab('history')} className="mt-4 text-[14px] font-semibold text-primary">{t('demo.toHistory')}</button>
    </Panel>
  );
}
