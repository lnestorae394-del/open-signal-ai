import { useEffect, useState } from 'react';
import { findInstrument, type MarketMode } from '@open-signal/shared';
import { Segmented, cx } from '@open-signal/ui';
import type { Candle } from '../lib/api.ts';
import { useApp } from '../state.tsx';
import { haptic } from '../lib/telegram.ts';

/** Forex / OTC switch. Shown only for modes the bot has enabled. */
export function MarketSwitch() {
  const { t, config, marketMode, setMarketMode } = useApp();
  if (!config) return null;
  const modes = (['forex', 'otc'] as const).filter((m) => config.markets[m].enabled);
  if (modes.length < 2) return null;
  return (
    <Segmented
      block
      ariaLabel={t('market.mode')}
      value={marketMode}
      onChange={(m: MarketMode) => {
        if (m !== marketMode) haptic();
        setMarketMode(m);
      }}
      options={modes.map((m) => ({ value: m, label: m === 'forex' ? 'Forex' : 'OTC' }))}
    />
  );
}

/**
 * The DEMO / SIMULATED mark. It sits above every price, chart and signal so
 * synthetic numbers are never mistaken for real quotes.
 */
export function SimulatedStrip({ compact }: { compact?: boolean }) {
  const { t } = useApp();
  return (
    <div className="flex items-start gap-3 rounded-2xl border border-warning/35 bg-warning/[0.09] px-3.5 py-2.5" role="note">
      <span className="mt-[1px] shrink-0 rounded-md bg-warning px-1.5 py-0.5 text-[11px] font-bold text-black">DEMO / SIMULATED</span>
      {compact ? null : <span className="text-[13px] leading-snug text-fg/85">{t('market.simulatedText')}</span>}
    </div>
  );
}

export function PairDots({ id }: { id: string }) {
  const inst = findInstrument(id);
  return (
    <div className="relative h-8 w-[52px] shrink-0" aria-hidden>
      <span className="absolute left-0 top-0 grid h-8 w-8 place-items-center rounded-full bg-white/[0.08] pr-2.5 text-[9.5px] font-semibold tracking-tight">{inst?.base}</span>
      <span className="absolute left-5 top-0 grid h-8 w-8 place-items-center rounded-full border-2 border-card bg-[#26262b] text-[9.5px] font-semibold tracking-tight">{inst?.quote}</span>
    </div>
  );
}

export const symbolOf = (id: string) => findInstrument(id)?.symbol.replace(' OTC', '') ?? id;

export const fmtPrice = (v: number, decimals: number) => v.toFixed(decimals);

export function fmtPct(v: number): string {
  const s = v.toFixed(2);
  return v > 0 ? `+${s}%` : `${s}%`;
}

/** "30 s" / "1 min" / "15 min" in the interface language. */
export function periodLabel(sec: number, locale: string): string {
  const unit = sec < 60 ? 'second' : 'minute';
  const n = sec < 60 ? sec : sec / 60;
  return new Intl.NumberFormat(locale, { style: 'unit', unit, unitDisplay: 'short' }).format(n);
}

/** Re-renders every `ms` while mounted (countdowns). */
export function useTicker(ms: number): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(id);
  }, [ms]);
  return now;
}

/** Candlestick chart with an optional RSI strip. Pure SVG, scales to the container width. */
export function CandleChart({ candles, rsi, decimals, label }: { candles: Candle[]; rsi: (number | null)[] | null; decimals: number; label: string }) {
  const W = 360;
  const H = 168;
  const RSI_H = rsi ? 52 : 0;
  const GAP = rsi ? 10 : 0;
  if (!candles.length) return null;
  const hi = Math.max(...candles.map((c) => c.high));
  const lo = Math.min(...candles.map((c) => c.low));
  const span = hi - lo || hi * 0.0001 || 1;
  const pad = span * 0.08;
  const y = (v: number) => 6 + ((hi + pad - v) / (span + pad * 2)) * (H - 12);
  // Leave room on the right for the current-price label.
  const step = (W - 52) / candles.length;
  const body = Math.max(1.5, step * 0.62);
  const last = candles[candles.length - 1]!;
  const ry = (v: number) => H + GAP + 4 + ((100 - v) / 100) * (RSI_H - 8);
  const rsiPts = rsi
    ? rsi
        .map((v, i) => (v === null ? null : `${(i * step + step / 2).toFixed(1)},${ry(v).toFixed(1)}`))
        .filter(Boolean)
        .join(' ')
    : '';

  return (
    <svg viewBox={`0 0 ${W} ${H + GAP + RSI_H}`} className="block h-auto w-full" role="img" aria-label={label}>
      {[0.25, 0.5, 0.75].map((f) => (
        <line key={f} x1="0" x2={W} y1={6 + f * (H - 12)} y2={6 + f * (H - 12)} stroke="currentColor" className="text-white/[0.06]" strokeWidth="1" />
      ))}
      {candles.map((c, i) => {
        const up = c.close >= c.open;
        const x = i * step + step / 2;
        const top = y(Math.max(c.open, c.close));
        const h = Math.max(1, Math.abs(y(c.open) - y(c.close)));
        return (
          <g key={c.time} className={up ? 'text-success' : 'text-primary'}>
            <line x1={x} x2={x} y1={y(c.high)} y2={y(c.low)} stroke="currentColor" strokeWidth="1" />
            <rect x={x - body / 2} y={top} width={body} height={h} rx="0.8" fill="currentColor" />
          </g>
        );
      })}
      <line x1="0" x2={W} y1={y(last.close)} y2={y(last.close)} stroke="currentColor" className="text-fg/40" strokeDasharray="3 3" strokeWidth="1" />
      {(() => {
        const label = last.close.toFixed(decimals);
        const w = label.length * 5.6 + 10;
        const ly = Math.min(Math.max(y(last.close) - 8, 2), H - 18);
        return (
          <g>
            <rect x={W - w} y={ly} width={w} height="16" rx="4" className="fill-[var(--os-surface)] stroke-white/25" strokeWidth="0.75" />
            <text x={W - w / 2} y={ly + 11.5} textAnchor="middle" className="os-num fill-fg text-[9.5px] font-semibold">{label}</text>
          </g>
        );
      })()}
      {rsi ? (
        <g>
          <rect x="0" y={H + GAP} width={W} height={RSI_H} rx="6" className="fill-white/[0.03]" />
          <line x1="0" x2={W} y1={ry(70)} y2={ry(70)} stroke="currentColor" className="text-primary/45" strokeDasharray="2 3" strokeWidth="1" />
          <line x1="0" x2={W} y1={ry(30)} y2={ry(30)} stroke="currentColor" className="text-success/45" strokeDasharray="2 3" strokeWidth="1" />
          <polyline points={rsiPts} fill="none" stroke="currentColor" className="text-accent" strokeWidth="1.5" strokeLinejoin="round" />
          <text x="4" y={H + GAP + 12} className="fill-muted text-[9px]">RSI</text>
        </g>
      ) : null}
    </svg>
  );
}

export function OutcomeBadge({ outcome, label }: { outcome: 'open' | 'win' | 'loss' | 'draw'; label: string }) {
  const tone = { open: 'bg-white/[0.08] text-fg', win: 'bg-success/15 text-success', loss: 'bg-primary/15 text-primary', draw: 'bg-white/[0.08] text-muted' }[outcome];
  return <span className={cx('rounded-full px-2.5 py-1 text-[12px] font-semibold', tone)}>{label}</span>;
}
