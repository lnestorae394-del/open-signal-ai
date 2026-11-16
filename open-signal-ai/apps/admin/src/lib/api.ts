/** Same-origin Admin API client. Session = HttpOnly cookie; mutations carry the CSRF header. */
/** Admin panel, Mini App and API are served from one origin, so API paths are relative. */
export const API_URL = '';

export class ApiError extends Error {
  readonly code: string;
  readonly status: number;
  readonly fields: Record<string, string>;
  constructor(code: string, status: number, fields: Record<string, string> = {}, message?: string) {
    super(message ?? code);
    this.code = code;
    this.status = status;
    this.fields = fields;
  }
}

export async function api<T>(method: 'GET' | 'POST' | 'PUT', path: string, body?: unknown): Promise<T> {
  let res: Response;
  try {
    res = await fetch(`${API_URL}/api/admin${path}`, {
      method,
      credentials: 'same-origin',
      headers: { 'content-type': 'application/json', ...(method === 'GET' ? {} : { 'x-os-admin': '1' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
  } catch {
    throw new ApiError('NETWORK', 0);
  }
  const json = (await res.json().catch(() => null)) as { error?: { code?: string; fields?: Record<string, string>; message?: string } } | null;
  if (!res.ok) throw new ApiError(json?.error?.code ?? 'INTERNAL', res.status, json?.error?.fields ?? {}, json?.error?.message);
  return json as T;
}

export function errorText(t: (k: string) => string, e: unknown): string {
  const code = e instanceof ApiError ? e.code : 'INTERNAL';
  const key = `admin.err.${code}`;
  const text = t(key);
  return text === key ? t('admin.err.INTERNAL') : text;
}

export interface Health {
  status: string;
  storage: string;
  persistentStorage: boolean;
}

export async function fileToBase64(file: File): Promise<string> {
  const buf = new Uint8Array(await file.arrayBuffer());
  let s = '';
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return btoa(s);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    return false;
  }
}
