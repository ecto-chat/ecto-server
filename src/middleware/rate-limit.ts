export interface IRateLimiter {
  check(key: string, limit: number, windowMs: number): boolean;
}

interface Bucket {
  tokens: number;
  lastRefill: number;
}

export class MemoryRateLimiter implements IRateLimiter {
  private buckets = new Map<string, Bucket>();
  private cleanupInterval: ReturnType<typeof setInterval>;

  constructor() {
    // Cleanup stale entries every 60 seconds
    this.cleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [key, bucket] of this.buckets) {
        if (now - bucket.lastRefill > 120_000) {
          this.buckets.delete(key);
        }
      }
    }, 60_000);
  }

  check(key: string, limit: number, windowMs: number): boolean {
    const now = Date.now();
    let bucket = this.buckets.get(key);

    if (!bucket) {
      bucket = { tokens: limit - 1, lastRefill: now };
      this.buckets.set(key, bucket);
      return true;
    }

    // Refill tokens based on elapsed time
    const elapsed = now - bucket.lastRefill;
    const refill = Math.floor((elapsed / windowMs) * limit);
    if (refill > 0) {
      bucket.tokens = Math.min(limit, bucket.tokens + refill);
      bucket.lastRefill = now;
    }

    if (bucket.tokens > 0) {
      bucket.tokens--;
      return true;
    }

    return false;
  }

  destroy() {
    clearInterval(this.cleanupInterval);
  }
}

let _rateLimiter: IRateLimiter = new MemoryRateLimiter();

export function setRateLimiter(impl: IRateLimiter) {
  _rateLimiter = impl;
}

export const rateLimiter: IRateLimiter = new Proxy({} as IRateLimiter, {
  get(_target, prop) {
    return (_rateLimiter as any)[prop];
  },
});
