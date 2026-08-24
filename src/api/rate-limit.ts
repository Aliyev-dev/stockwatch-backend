/**
 * Fixed-window rate limiter keyed by an arbitrary string (we key on link_code).
 * In-memory on purpose: this process is the only thing serving /api/notify, and
 * the limiter must never add a database round-trip to the hot path.
 */
export interface RateLimitResult {
  allowed: boolean;
  remaining: number;
  /** Seconds until the current window resets. */
  retryAfter: number;
}

interface Window {
  count: number;
  resetAt: number;
}

export class RateLimiter {
  private readonly windows = new Map<string, Window>();
  private lastSweep = 0;

  constructor(
    private readonly limit: number,
    private readonly windowMs: number,
    private readonly maxKeys = 20_000,
  ) {}

  check(key: string, now = Date.now()): RateLimitResult {
    this.sweep(now);

    const existing = this.windows.get(key);
    if (!existing || existing.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.windowMs });
      return { allowed: true, remaining: this.limit - 1, retryAfter: 0 };
    }

    if (existing.count >= this.limit) {
      return { allowed: false, remaining: 0, retryAfter: Math.max(1, Math.ceil((existing.resetAt - now) / 1000)) };
    }

    existing.count += 1;
    return { allowed: true, remaining: this.limit - existing.count, retryAfter: 0 };
  }

  private sweep(now: number): void {
    if (now - this.lastSweep < this.windowMs && this.windows.size <= this.maxKeys) return;
    this.lastSweep = now;
    for (const [key, window] of this.windows) {
      if (window.resetAt <= now) this.windows.delete(key);
    }
    // Hard cap so a flood of unknown codes cannot grow the map without bound.
    while (this.windows.size > this.maxKeys) {
      const oldest = this.windows.keys().next();
      if (oldest.done) break;
      this.windows.delete(oldest.value);
    }
  }
}
