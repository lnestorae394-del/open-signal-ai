/**
 * Simple Forex availability window used by OPEN SIGNAL AI.
 * Times are interpreted in the Pocket Option server timezone UTC+2.
 * Forex: Monday-Friday 02:00-22:45. OTC is not checked here.
 */
const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const UTC_PLUS_TWO_MS = 2 * HOUR;

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

export function forexSessionState(now: Date = new Date()): ForexSessionState {
  // Convert current UTC instant to the broker's fixed UTC+2 clock.
  const brokerNow = new Date(now.getTime() + UTC_PLUS_TWO_MS);
  const weekday = brokerNow.getUTCDay(); // Sunday=0 ... Saturday=6
  const minuteOfDay = brokerNow.getUTCHours() * 60 + brokerNow.getUTCMinutes();
  const brokerDayStartUtc = Date.UTC(brokerNow.getUTCFullYear(), brokerNow.getUTCMonth(), brokerNow.getUTCDate())
    - UTC_PLUS_TWO_MS;

  const weekdayOpen = weekday >= 1 && weekday <= 5;
  const open = weekdayOpen && minuteOfDay >= FOREX_OPEN_MINUTE && minuteOfDay < FOREX_CLOSE_MINUTE;

  let daysAhead = 0;
  if (open) {
    // Closes today at 22:45 broker time.
  } else if (weekday === 0) {
    daysAhead = 1; // Sunday -> Monday
  } else if (weekday === 6) {
    daysAhead = 2; // Saturday -> Monday
  } else if (minuteOfDay < FOREX_OPEN_MINUTE) {
    daysAhead = 0; // Before today's opening
  } else {
    daysAhead = weekday === 5 ? 3 : 1; // After close; Friday -> Monday
  }

  const transitionMinute = open ? FOREX_CLOSE_MINUTE : FOREX_OPEN_MINUTE;
  const nextChangeAt = new Date(brokerDayStartUtc + daysAhead * DAY + transitionMinute * MINUTE);
  return {
    open,
    nextChangeAt,
    opensAt: '02:00',
    closesAt: '22:45',
    timezone: POCKET_OPTION_TIMEZONE,
  };
}
