/**
 * Conversion between plain JS documents and the Firestore REST `Value` format
 * (https://firebase.google.com/docs/firestore/reference/rest/v1/Value).
 *
 * Conventions kept identical to the local adapter so business logic never sees
 * a difference:
 *  - dates are stored as ISO strings, except TTL fields (see TIMESTAMP_FIELDS),
 *    which Firestore needs as real timestamps and which decode back to ISO strings;
 *  - integers ↔ integerValue (string on the wire), other numbers ↔ doubleValue.
 */
export type FsValue =
  | { nullValue: null }
  | { booleanValue: boolean }
  | { integerValue: string }
  | { doubleValue: number }
  | { timestampValue: string }
  | { stringValue: string }
  | { arrayValue: { values?: FsValue[] } }
  | { mapValue: { fields?: Record<string, FsValue> } };

export type FsFields = Record<string, FsValue>;

/** Top-level fields written as Firestore timestamps (required for TTL policies). */
export const TIMESTAMP_FIELDS = new Set(['expireAt']);

export function encodeValue(v: unknown, asTimestamp = false): FsValue {
  if (v === null || v === undefined) return { nullValue: null };
  if (typeof v === 'boolean') return { booleanValue: v };
  if (typeof v === 'number') {
    if (!Number.isFinite(v)) throw new Error('Firestore cannot store non-finite numbers');
    return Number.isSafeInteger(v) ? { integerValue: String(v) } : { doubleValue: v };
  }
  if (typeof v === 'string') {
    if (asTimestamp && !Number.isNaN(Date.parse(v))) return { timestampValue: new Date(v).toISOString() };
    return { stringValue: v };
  }
  if (Array.isArray(v)) return { arrayValue: { values: v.map((x) => encodeValue(x)) } };
  if (typeof v === 'object') return { mapValue: { fields: encodeFields(v as Record<string, unknown>, false) } };
  throw new Error(`Unsupported value type: ${typeof v}`);
}

export function encodeFields(doc: Record<string, unknown>, topLevel = true): FsFields {
  const out: FsFields = {};
  for (const [k, v] of Object.entries(doc)) {
    if (v === undefined) continue;
    out[k] = encodeValue(v, topLevel && TIMESTAMP_FIELDS.has(k));
  }
  return out;
}

export function decodeValue(v: FsValue): unknown {
  if ('nullValue' in v) return null;
  if ('booleanValue' in v) return v.booleanValue;
  if ('integerValue' in v) return Number(v.integerValue);
  if ('doubleValue' in v) return v.doubleValue;
  if ('timestampValue' in v) return new Date(v.timestampValue).toISOString();
  if ('stringValue' in v) return v.stringValue;
  if ('arrayValue' in v) return (v.arrayValue.values ?? []).map(decodeValue);
  if ('mapValue' in v) return decodeFields(v.mapValue.fields ?? {});
  return null;
}

export function decodeFields(fields: FsFields): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [k, v] of Object.entries(fields)) out[k] = decodeValue(v);
  return out;
}

/** Field path segment quoting (backticks for anything that is not a simple identifier). */
export function fieldPath(path: string): string {
  return path
    .split('.')
    .map((seg) => (/^[A-Za-z_][A-Za-z0-9_]*$/.test(seg) ? seg : `\`${seg.replace(/[`\\]/g, (m) => `\\${m}`)}\``))
    .join('.');
}
