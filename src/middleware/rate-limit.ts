export class RateLimiter {
  // TODO: Token bucket or sliding window rate limiter
  check(_key: string, _limit: number, _windowMs: number): boolean {
    return true; // TODO
  }
}
