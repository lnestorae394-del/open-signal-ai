/**
 * In-memory token-bucket rate limiter. One process serves all bots, so keys
 * include the bucket name, tenant (botId / sourceId) and client IP.
 * For several server instances this would move to a shared store (documented).
 */
export interface RateLimitRule {
  capacity: number;
  refillPerSec: number;
}

export interface RateLimitResult {
  allowed: boolean;
  retryAfterSec: number;
}

interface Bucket {
  tokens: number;
  updatedAt: number;
}

export class TokenBucketLimiter {
  private readonly buckets = new Map<string, Bucket>();
  private readonly maxKeys: number;

  constructor(maxKeys = 50_000) {
    this.maxKeys = maxKeys;
  }

  take(key: string, rule: RateLimitRule, now = Date.now()): RateLimitResult {
    let b = this.buckets.get(key);
    if (!b) {
      if (this.buckets.size >= this.maxKeys) this.evictOldest();
      b = { tokens: rule.capacity, updatedAt: now };
      this.buckets.set(key, b);
    } else {
      const elapsed = (now - b.updatedAt) / 1000;
      b.tokens = Math.min(rule.capacity, b.tokens + elapsed * rule.refillPerSec);
      b.updatedAt = now;
      // refresh insertion order for LRU-ish eviction
      this.buckets.delete(key);
      this.buckets.set(key, b);
    }
    if (b.tokens >= 1) {
      b.tokens -= 1;
      return { allowed: true, retryAfterSec: 0 };
    }
    return { allowed: false, retryAfterSec: Math.max(1, Math.ceil((1 - b.tokens) / rule.refillPerSec)) };
  }

  private evictOldest(): void {
    const n = Math.ceil(this.maxKeys * 0.1);
    let i = 0;
    for (const k of this.buckets.keys()) {
      this.buckets.delete(k);
      if (++i >= n) break;
    }
  }
}

export const RATE_LIMITS = {
  public: { capacity: 60, refillPerSec: 2 },
  session: { capacity: 10, refillPerSec: 0.2 },
  miniapp: { capacity: 60, refillPerSec: 2 },
  market: { capacity: 120, refillPerSec: 4 },
  binding: { capacity: 8, refillPerSec: 0.1 },
  webhook: { capacity: 300, refillPerSec: 100 },
  postback: { capacity: 120, refillPerSec: 20 },
  login: { capacity: 10, refillPerSec: 1 / 60 },
  admin: { capacity: 120, refillPerSec: 4 },
  media: { capacity: 120, refillPerSec: 10 },
} satisfies Record<string, RateLimitRule>;

export type RateLimitBucket = keyof typeof RATE_LIMITS;
