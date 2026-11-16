import { FOREX_CLOSE_UTC, FOREX_OPEN_UTC } from '@open-signal/shared';
import { cx } from '@open-signal/ui';

const HOUR = 3_600_000;

/**
 * The Forex trading week as a tape: Sunday 22:00 UTC → Friday 22:00 UTC,
 * with a playhead at the current moment. Pure calendar data — no prices.
 */
export function WeekTape({ now, locale, open }: { now: Date; locale: string; open: boolean }) {
  const dayOfWeek = now.getUTCDay();
  const sinceSunday = dayOfWeek * 24 * HOUR + (now.getTime() % (24 * HOUR));
  const openAt = FOREX_OPEN_UTC.weekday * 24 * HOUR + FOREX_OPEN_UTC.hour * HOUR;
  const closeAt = FOREX_CLOSE_UTC.weekday * 24 * HOUR + FOREX_CLOSE_UTC.hour * HOUR;
  const span = closeAt - openAt;
  const progress = open ? Math.min(1, Math.max(0, (sinceSunday - openAt) / span)) : sinceSunday >= closeAt ? 1 : 0;

  // Five trading days, labelled in the user's language (Monday … Friday).
  const monday = new Date(Date.UTC(2024, 0, 1)); // a Monday
  const fmt = new Intl.DateTimeFormat(locale, { weekday: 'short', timeZone: 'UTC' });
  const days = Array.from({ length: 5 }, (_, i) => fmt.format(new Date(monday.getTime() + i * 24 * HOUR)));

  return (
    <div className="select-none" aria-hidden>
      <div className="relative h-10">
        <div className="absolute inset-x-0 top-1/2 h-px -translate-y-1/2 bg-white/[0.12]" />
        {days.map((_, i) => (
          <div key={i} className="absolute top-1/2 h-3 w-px -translate-y-1/2 bg-white/25" style={{ left: `${(((i + 1) * 24 * HOUR) / span) * 100}%` }} />
        ))}
        <div
          className={cx('absolute left-0 top-1/2 h-[3px] -translate-y-1/2 rounded-full', open ? 'bg-gradient-to-r from-primary/30 to-primary' : 'bg-white/20')}
          style={{ width: `${progress * 100}%` }}
        />
        <div className="absolute top-1/2 -translate-x-1/2 -translate-y-1/2" style={{ left: `${progress * 100}%` }}>
          <span className={cx('block h-3.5 w-3.5 rounded-full border-2 border-bg', open ? 'os-live-dot bg-primary' : 'bg-muted')} />
        </div>
      </div>
      <div className="grid grid-cols-5 text-[12px] capitalize text-muted">
        {days.map((d, i) => (
          <span key={i} className="text-center">{d}</span>
        ))}
      </div>
    </div>
  );
}
