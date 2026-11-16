/**
 * Instrument catalogue. This is static reference data (names and categories),
 * NOT market data: no prices live here.
 *
 * OTC instruments are a separate market with their own marker. They have no
 * data source until a licensed OTC provider is connected, and must never be
 * filled with regular Forex quotes.
 */
export type MarketType = 'forex' | 'otc';

export interface Instrument {
  /** Stable id, e.g. "EURUSD" or "EURUSD_OTC". */
  id: string;
  /** Display symbol, e.g. "EUR/USD". */
  symbol: string;
  base: string;
  quote: string;
  market: MarketType;
  /** Provider symbol, null when no verified source exists. */
  providerSymbol: string | null;
}

const FOREX_PAIRS = [
  'EUR/USD', 'GBP/USD', 'USD/JPY', 'USD/CAD', 'USD/CHF', 'AUD/USD', 'EUR/JPY',
  'GBP/JPY', 'EUR/GBP', 'EUR/AUD', 'EUR/CAD', 'EUR/CHF', 'GBP/CAD', 'GBP/CHF',
  'GBP/AUD', 'AUD/CAD', 'AUD/CHF', 'AUD/JPY', 'CAD/JPY', 'CAD/CHF', 'CHF/JPY',
] as const;

function forex(symbol: string): Instrument {
  const [base = '', quote = ''] = symbol.split('/');
  return { id: `${base}${quote}`, symbol, base, quote, market: 'forex', providerSymbol: symbol };
}

function otc(symbol: string): Instrument {
  const [base = '', quote = ''] = symbol.split('/');
  // providerSymbol stays null: there is no verified OTC source yet.
  return { id: `${base}${quote}_OTC`, symbol: `${symbol} OTC`, base, quote, market: 'otc', providerSymbol: null };
}

export const FOREX_INSTRUMENTS: readonly Instrument[] = FOREX_PAIRS.map(forex);
export const OTC_INSTRUMENTS: readonly Instrument[] = FOREX_PAIRS.map(otc);
export const ALL_INSTRUMENTS: readonly Instrument[] = [...FOREX_INSTRUMENTS, ...OTC_INSTRUMENTS];

export function findInstrument(id: string): Instrument | undefined {
  return ALL_INSTRUMENTS.find((i) => i.id === id);
}
