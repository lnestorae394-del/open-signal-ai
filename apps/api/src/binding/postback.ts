import type { PartnerSource, PostbackEventType } from '@open-signal/shared';
import { AppError } from '../lib/errors.ts';
import { hmacSha256Hex, safeEqual, sha256Hex } from '../lib/crypto.ts';
import type { SecretBox } from '../lib/crypto.ts';
import { CLICK_ID_PATTERN, normalizeClickId } from '../lib/ids.ts';

/**
 * Postback adapter: authenticates the source and normalizes a partner request
 * into a platform event. Partner-specific details (parameter names, event
 * names, auth method) live in the `partner_sources` document, so a new
 * partner program needs configuration, not code.
 */
export interface PostbackRequest {
  method: string;
  /** Raw query string without "?". */
  rawQuery: string;
  headers: Record<string, string>;
  rawBody: string;
  ip: string;
}

export interface NormalizedEvent {
  /** Idempotency key derived from the partner event. */
  eventKey: string;
  eventType: PostbackEventType;
  /** Deposit amount and currency, when the partner sends them (FTD / redeposit). */
  amount: number | null;
  currency: string | null;
  partnerId: string | null;
  rawEventType: string;
  traderIdNorm: string;
  clickId: string | null;
  partnerEventId: string | null;
  occurredAt: string | null;
  /**
   * The event has no natural unique key: a repeat deposit without a partner event id
   * or timestamp (Pocket Partners documents no such macro). A re-delivery and a second
   * real deposit of the same amount are then indistinguishable, so every delivery is
   * stored and COUNTED (a real deposit is never dropped); a delivery that matches
   * `similarKey` within SIMILAR_WINDOW_MS is flagged as a possible duplicate for an admin.
   */
  noNaturalKey: boolean;
  /** type + Trader ID + amount + currency: used only to flag possible duplicates. */
  similarKey: string;
}

/** Deliveries with the same Trader ID, type, amount and currency within this window are flagged (never dropped). */
export const SIMILAR_WINDOW_MS = 10 * 60 * 1000;

export const secretAad = (sourceId: string) => `postback:${sourceId}:secret`;

export function authenticateSource(source: PartnerSource, req: PostbackRequest, box: SecretBox): void {
  if (source.ipAllowlist.length > 0 && !source.ipAllowlist.includes(req.ip)) {
    throw new AppError('UNAUTHORIZED', 'source ip not allowed');
  }
  const auth = source.auth;
  const secret = box.decrypt(auth.secretEnc, secretAad(source.id));
  if (auth.method === 'hmac_sha256') {
    const sig = req.headers[auth.signatureHeader.toLowerCase()];
    const signed = req.method === 'GET' ? req.rawQuery : req.rawBody;
    if (!sig || !safeEqual(hmacSha256Hex(secret, signed), sig.toLowerCase())) {
      throw new AppError('UNAUTHORIZED', 'signature mismatch');
    }
    return;
  }
  const provided =
    auth.location === 'header'
      ? req.headers[auth.name.toLowerCase()]
      : new URLSearchParams(req.rawQuery).get(auth.name) ?? undefined;
  if (!provided || !safeEqual(sha256Hex(provided), sha256Hex(secret))) {
    throw new AppError('UNAUTHORIZED', 'shared secret mismatch');
  }
}

/** Collects parameters from the query string and a JSON or form body. */
export function collectParams(req: PostbackRequest): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of new URLSearchParams(req.rawQuery)) out[k] = v;
  const ct = req.headers['content-type'] ?? '';
  if (req.rawBody) {
    if (ct.includes('application/json')) {
      let body: unknown;
      try {
        body = JSON.parse(req.rawBody);
      } catch {
        throw new AppError('BAD_REQUEST', 'invalid JSON body');
      }
      if (body && typeof body === 'object' && !Array.isArray(body)) {
        for (const [k, v] of Object.entries(body)) if (v !== null && typeof v !== 'object') out[k] = String(v);
      }
    } else if (ct.includes('application/x-www-form-urlencoded')) {
      for (const [k, v] of new URLSearchParams(req.rawBody)) out[k] = v;
    }
  }
  return out;
}

export function normalizeEvent(source: PartnerSource, params: Record<string, string>, traderIdPattern: RegExp): NormalizedEvent {
  const m = source.mapping;
  const rawType = (params[m.eventType] ?? '').trim();
  if (!rawType) throw new AppError('BAD_REQUEST', 'event type missing');
  const eventType: PostbackEventType = source.eventTypeMap[rawType] ?? 'other';

  const traderIdNorm = (params[m.traderId] ?? '').trim();
  if (!traderIdPattern.test(traderIdNorm)) throw new AppError('BAD_REQUEST', 'trader id invalid');

  const clickRaw = m.clickId ? normalizeClickId(params[m.clickId] ?? '') : '';
  const clickId = clickRaw && CLICK_ID_PATTERN.test(clickRaw) ? clickRaw : null;

  const partnerEventId = m.eventId ? (params[m.eventId] ?? '').trim().slice(0, 128) || null : null;
  const occurredAt = m.occurredAt ? (params[m.occurredAt] ?? '').trim().slice(0, 64) || null : null;

  const amountRaw = m.amount ? (params[m.amount] ?? '').trim().replace(',', '.') : '';
  const amountNum = amountRaw && /^\d{1,12}(\.\d{1,8})?$/.test(amountRaw) ? Number(amountRaw) : null;
  const currencyRaw = m.currency ? (params[m.currency] ?? '').trim().toUpperCase() : '';
  const currency = /^[A-Z]{3,5}$/.test(currencyRaw) ? currencyRaw : null;
  const partnerRaw = m.partnerId ? (params[m.partnerId] ?? '').trim() : '';
  const partnerId = /^[A-Za-z0-9_.:-]{1,64}$/.test(partnerRaw) ? partnerRaw : null;

  // Idempotency key. Registration and the first deposit happen once per Trader ID, so the
  // Trader ID itself is their key — even when the partner also sends an event id (two
  // different ids can never make a second FTD). Repeat deposits need a partner event id
  // or a timestamp; without them every delivery is its own event (see `noNaturalKey`).
  const tid = traderIdNorm.toLowerCase();
  const similarKey = `${eventType}:${tid}:${amountNum ?? ''}:${currency ?? ''}`;
  let eventKey: string;
  let noNaturalKey = false;
  if (eventType === 'registration') eventKey = `reg:${tid}`;
  else if (eventType === 'ftd') eventKey = `ftd:${tid}`;
  else if (partnerEventId) eventKey = `id:${partnerEventId}`; // same key format as before: stored events stay recognisable
  else if (occurredAt) eventKey = `nat:${eventType}:${tid}:${occurredAt}`;
  else {
    eventKey = `dlv:${similarKey}`;
    noNaturalKey = true;
  }

  return { eventKey, eventType, rawEventType: rawType, traderIdNorm, clickId, partnerEventId, occurredAt, amount: amountNum, currency, partnerId, noNaturalKey, similarKey };
}

export function postbackEventDocId(sourceId: string, eventKey: string): string {
  return `${sourceId}_${sha256Hex(eventKey).slice(0, 40)}`;
}
