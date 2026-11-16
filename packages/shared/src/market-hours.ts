/**
 * Forex trading-week calendar.
 *
 * Retail spot FX trades continuously from Sunday ~22:00 UTC to Friday ~22:00 UTC.
 * This function is a deterministic calendar rule, not market data. It does NOT
 * know about bank holidays or liquidity gaps: the UI labels it accordingly and
 * the market-data provider's own market state (Stage 4) takes precedence.
 */
export const FOREX_OPEN_UTC = { weekday: 0, hour: 22 } as const; // Sunday 22:00 UTC
export const FOREX_CLOSE_UTC = { weekday: 5, hour: 22 } as const; // Friday 22:00 UTC

export interface ForexSessionState {
  open: boolean;
  /** Next change of state (open → close or close → open), UTC. */
  nextChangeAt: Date;
}

const HOUR = 3_600_000;
const WEEK = 7 * 24 * HOUR;

/** Milliseconds since Sunday 00:00 UTC of the current week. */
function weekOffset(d: Date): number {
  return (
    d.getUTCDay() * 24 * HOUR +
    d.getUTCHours() * HOUR +
    d.getUTCMinutes() * 60_000 +
    d.getUTCSeconds() * 1000 +
    d.getUTCMilliseconds()
  );
}

export function forexSessionState(now: Date = new Date()): ForexSessionState {
  const offset = weekOffset(now);
  const openAt = FOREX_OPEN_UTC.weekday * 24 * HOUR + FOREX_OPEN_UTC.hour * HOUR;
  const closeAt = FOREX_CLOSE_UTC.weekday * 24 * HOUR + FOREX_CLOSE_UTC.hour * HOUR;
  const weekStart = now.getTime() - offset;

  // Weeks start on Sunday 00:00 UTC, so the open window is [Sun 22:00, Fri 22:00).
  const open = offset >= openAt && offset < closeAt;
  let next: number;
  if (open) {
    next = weekStart + closeAt;
  } else if (offset < openAt) {
    next = weekStart + openAt; // Sunday before the open
  } else {
    next = weekStart + WEEK + openAt; // after Friday close → next Sunday
  }
  return { open, nextChangeAt: new Date(next) };
}
