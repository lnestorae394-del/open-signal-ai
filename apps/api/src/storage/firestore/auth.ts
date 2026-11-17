import { createSign } from 'node:crypto';

/**
 * Google OAuth2 for a service account (JWT bearer grant, RFC 7523) using only
 * node:crypto — no SDK. The service-account JSON comes from the environment
 * (Render secret) and never leaves the server.
 */
export interface ServiceAccount {
  project_id: string;
  client_email: string;
  private_key: string;
  token_uri?: string;
}

export function parseServiceAccount(raw: string): ServiceAccount {
  const text = raw.trim().startsWith('{') ? raw : Buffer.from(raw.trim(), 'base64').toString('utf8');
  let json: Partial<ServiceAccount> & { type?: string };
  try {
    json = JSON.parse(text) as Partial<ServiceAccount> & { type?: string };
  } catch {
    throw new Error('FIREBASE_SERVICE_ACCOUNT is not valid JSON (paste the whole key file, or its base64)');
  }
  if (json.type !== 'service_account' || !json.project_id || !json.client_email || !json.private_key) {
    throw new Error('FIREBASE_SERVICE_ACCOUNT must be a Firebase service account key (type "service_account")');
  }
  return {
    project_id: json.project_id,
    client_email: json.client_email,
    // Keys pasted through some UIs arrive with literal "\n"
    private_key: json.private_key.replace(/\\n/g, '\n'),
    token_uri: json.token_uri ?? 'https://oauth2.googleapis.com/token',
  };
}

export const SCOPES = ['https://www.googleapis.com/auth/datastore', 'https://www.googleapis.com/auth/cloud-platform'];

export interface TokenProvider {
  getToken(): Promise<string | null>;
}

export class ServiceAccountTokenProvider implements TokenProvider {
  private cached: { token: string; expiresAt: number } | null = null;
  private inflight: Promise<string> | null = null;
  private readonly sa: ServiceAccount;
  private readonly fetchImpl: typeof fetch;

  constructor(sa: ServiceAccount, fetchImpl: typeof fetch = fetch) {
    this.sa = sa;
    this.fetchImpl = fetchImpl;
  }

  async getToken(): Promise<string> {
    if (this.cached && this.cached.expiresAt - 120_000 > Date.now()) return this.cached.token;
    this.inflight ??= this.fetchToken().finally(() => (this.inflight = null));
    return this.inflight;
  }

  private async fetchToken(): Promise<string> {
    const now = Math.floor(Date.now() / 1000);
    const b64 = (o: object) => Buffer.from(JSON.stringify(o)).toString('base64url');
    const unsigned = `${b64({ alg: 'RS256', typ: 'JWT' })}.${b64({
      iss: this.sa.client_email,
      scope: SCOPES.join(' '),
      aud: this.sa.token_uri,
      iat: now,
      exp: now + 3600,
    })}`;
    const signature = createSign('RSA-SHA256').update(unsigned).sign(this.sa.private_key).toString('base64url');
    const res = await this.fetchImpl(this.sa.token_uri!, {
      method: 'POST',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion: `${unsigned}.${signature}` }),
      signal: AbortSignal.timeout(10_000),
    });
    const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number; error_description?: string };
    if (!res.ok || !body.access_token) {
      throw new Error(`Google OAuth token request failed (${res.status}): ${body.error_description ?? 'check FIREBASE_SERVICE_ACCOUNT'}`);
    }
    this.cached = { token: body.access_token, expiresAt: Date.now() + (body.expires_in ?? 3600) * 1000 };
    return body.access_token;
  }
}

/** Firestore emulator / tests: no authentication. */
export class NoAuthTokenProvider implements TokenProvider {
  async getToken(): Promise<null> {
    return null;
  }
}
