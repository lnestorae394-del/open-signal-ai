import { createHmac } from 'node:crypto';
import { AppError } from '../lib/errors.ts';
import { safeEqual } from '../lib/crypto.ts';

/**
 * Stateless Mini App session token: base64url(payload).base64url(HMAC-SHA256).
 * Bound to one bot: a token issued for bot A is rejected by bot B's routes.
 * User state lives in the database, so sessions survive server restarts;
 * after expiry the Mini App silently re-authenticates with Telegram initData.
 */
export interface SessionPayload {
  v: 1;
  botId: string;
  tgId: number;
  iat: number;
  exp: number;
}

export class SessionService {
  private readonly secret: string;
  private readonly ttlSec: number;

  constructor(secret: string, ttlSec: number) {
    if (secret.length < 32) throw new Error('SESSION_SECRET too short');
    this.secret = secret;
    this.ttlSec = ttlSec;
  }

  issue(botId: string, tgId: number, now = new Date()): { token: string; expiresAt: string } {
    const iat = Math.floor(now.getTime() / 1000);
    const payload: SessionPayload = { v: 1, botId, tgId, iat, exp: iat + this.ttlSec };
    const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
    return { token: `${body}.${this.sign(body)}`, expiresAt: new Date(payload.exp * 1000).toISOString() };
  }

  verify(token: string | null, expectedBotId: string, now = new Date()): SessionPayload {
    if (!token) throw new AppError('UNAUTHORIZED', 'session missing');
    const [body, sig, extra] = token.split('.');
    if (!body || !sig || extra !== undefined || !safeEqual(this.sign(body), sig)) {
      throw new AppError('UNAUTHORIZED', 'session invalid');
    }
    let p: SessionPayload;
    try {
      p = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as SessionPayload;
    } catch {
      throw new AppError('UNAUTHORIZED', 'session invalid');
    }
    if (p.v !== 1 || p.botId !== expectedBotId) throw new AppError('UNAUTHORIZED', 'session belongs to another bot');
    if (Math.floor(now.getTime() / 1000) >= p.exp) throw new AppError('SESSION_EXPIRED');
    return p;
  }

  private sign(body: string): string {
    return createHmac('sha256', this.secret).update(`session.v1.${body}`).digest('base64url');
  }
}
