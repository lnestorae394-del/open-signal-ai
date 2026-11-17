/**
 * Pocket Option Forex asset schedule.
 *
 * The Pocket Option asset schedule is published in fixed server time UTC+2.
 * Most Forex pairs: Mon-Fri 02:00-22:45. GBP/CAD and GBP/CHF: Mon-Fri
 * 04:10-22:45. Regular Forex pairs are closed on Saturday and Sunday.
 *
 * This is a schedule gate, not a live broker-status feed: exceptional holidays,
 * asset suspensions and temporary broker maintenance can still differ.
 * OTC instruments deliberately do not use this calendar.
 */
const HOUR = 3_600_000;
const MINUTE = 60_000;
const DAY = 24 * HOUR;
const POCKET_OPTION_UTC_OFFSET_MS = 2 * HOUR;

export const POCKET_OPTION_TIMEZONE = 'UTC+2';
export const FOREX_OPEN_MINUTE = 2 * 60;
export const FOREX_LATE_OPEN_MINUTE = 4 * 60 + 10;
export const FOREX_CLOSE_MINUTE = 22 * 60 + 45;

const LATE_OPENING_INSTRUMENTS = new Set(['GBPCAD', 'GBPCHF']);

export interface ForexSessionState {
  open: boolean;
  /** Next open/close transition, returned as an absolute UTC Date. */
  nextChangeAt: Date;
  /** Pocket Option server-clock opening time, HH:mm. */
  opensAt: string;
  /** Pocket Option server-clock closing time, HH:mm. */
  closesAt: string;
  timezone: typeof POCKET_OPTION_TIMEZONE;
}

function clockLabel(totalMinutes: number): string {
  const h = Math.floor(totalMinutes / 60).toString().padStart(2, '0');
  const m = (totalMinutes % 60).toString().padStart(2, '0');
  return `${h}:${m}`;
}

function nextWeekdayOffset(day: number): number {
  // day: Sunday=0 ... Saturday=6. Return the next Monday-Friday offset.
  for (let offset = 1; offset <= 7; offset++) {
    const candidate = (day + offset) % 7;
    if (candidate >= 1 && candidate <= 5) return offset;
  }
  return 1;
}

/**
 * Returns the market session for a Forex instrument using Pocket Option's
 * published UTC+2 server clock. Unknown Forex instruments use the standard
 * 02:00 opening time; known GBP/CAD and GBP/CHF use 04:10.
 */
export function forexSessionState(now: Date = new Date(), instrumentId = 'EURUSD'): ForexSessionState {
  const openMinute = LATE_OPENING_INSTRUMENTS.has(instrumentId.toUpperCase())
    ? FOREX_LATE_OPEN_MINUTE
    : FOREX_OPEN_MINUTE;

  // Shift the instant into Pocket Option's fixed UTC+2 wall clock. Using a fixed
  // offset is intentional: the broker labels its schedule as server time UTC+2.
  const serverNow = new Date(now.getTime() + POCKET_OPTION_UTC_OFFSET_MS);
  const weekday = serverNow.getUTCDay();
  const minuteOfDay = serverNow.getUTCHours() * 60 + serverNow.getUTCMinutes();
  const serverDayStartUtc = Date.UTC(serverNow.getUTCFullYear(), serverNow.getUTCMonth(), serverNow.getUTCDate())
    - POCKET_OPTION_UTC_OFFSET_MS;

  const weekdayOpen = weekday >= 1 && weekday <= 5;
  const open = weekdayOpen && minuteOfDay >= openMinute && minuteOfDay < FOREX_CLOSE_MINUTE;

  let nextChangeAt: Date;
  if (open) {
    nextChangeAt = new Date(serverDayStartUtc + FOREX_CLOSE_MINUTE * MINUTE);
  } else {
    let daysAhead: number;
    if (weekday === 0) {
      daysAhead = 1; // Sunday -> Monday
    } else if (weekday === 6) {
      daysAhead = 2; // Saturday -> Monday
    } else if (minuteOfDay < openMinute) {
      daysAhead = 0; // before today's opening
    } else {
      daysAhead = nextWeekdayOffset(weekday); // after close -> next weekday
    }
    nextChangeAt = new Date(serverDayStartUtc + daysAhead * DAY + openMinute * MINUTE);
  }

  return {
    open,
    nextChangeAt,
    opensAt: clockLabel(openMinute),
    closesAt: clockLabel(FOREX_CLOSE_MINUTE),
    timezone: POCKET_OPTION_TIMEZONE,
  };
}
