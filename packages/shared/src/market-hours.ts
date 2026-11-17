/**
 * Simple Forex availability window used by OPEN SIGNAL AI.
 * Pocket Option server time is treated as fixed UTC+2.
 * Forex: Monday-Friday, 02:00-22:45. OTC is not checked here.
 */
const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const OFFSET_MS = 2 * HOUR;

export const POCKET_OPTION_TIMEZONE = 'UTC+2';
export const FOREX_OPEN_MINUTE = 2 * 60;
export const FOREX_CLOSE_MINUTE = 22 * 60 + 45;

export interface ForexSessionState {
  open: boolean;
  nextChangeAt: Date;
  opensAt: string;
  closesAt: string;
  timezone: typeof POCKET_OPTION_TIMEZONE;
}

export function forexSessionState(now: Date = new Date(), _instrumentId?: string): ForexSessionState {
  const serverNow = new Date(now.getTime() + OFFSET_MS);
  const weekday = serverNow.getUTCDay();
  const minuteOfDay = serverNow.getUTCHours() * 60 + serverNow.getUTCMinutes();
  const serverDayStartUtc = Date.UTC(serverNow.getUTCFullYear(), serverNow.getUTCMonth(), serverNow.getUTCDate()) - OFFSET_MS;
  const weekdayOpen = weekday >= 1 && weekday <= 5;
  const open = weekdayOpen && minuteOfDay >= FOREX_OPEN_MINUTE && minuteOfDay < FOREX_CLOSE_MINUTE;

  let nextChangeAt: Date;
  if (open) {
    nextChangeAt = new Date(serverDayStartUtc + FOREX_CLOSE_MINUTE * MINUTE);
  } else {
    let daysAhead: number;
    if (weekday === 0) daysAhead = 1; // Sunday -> Monday
    else if (weekday === 6) daysAhead = 2; // Saturday -> Monday
    else if (minuteOfDay < FOREX_OPEN_MINUTE) daysAhead = 0; // before today's opening
    else daysAhead = weekday === 5 ? 3 : 1; // after close; Friday -> Monday
    nextChangeAt = new Date(serverDayStartUtc + daysAhead * DAY + FOREX_OPEN_MINUTE * MINUTE);
  }

  return {
    open,
    nextChangeAt,
    opensAt: '02:00',
    closesAt: '22:45',
    timezone: POCKET_OPTION_TIMEZONE,
  };
}
