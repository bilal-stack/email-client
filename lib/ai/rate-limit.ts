// In-memory sliding-window rate limiter, keyed on `${userId}:${key}`.
//
// Process-local — fine for the eval-mode single-tenant deploy and dev. The
// architectural rule in CLAUDE.md #10 explicitly admits in-memory at this
// stage; a distributed limiter is only worthwhile if real traffic warrants
// it. Resets on server restart.

const buckets = new Map<string, number[]>();

export interface RateLimitResult {
  ok: boolean;
  retryAfterSeconds?: number;
}

export function checkRateLimit(
  userId: string,
  key: string,
  opts: { max?: number; windowMs?: number } = {},
): RateLimitResult {
  const max = opts.max ?? 30;
  const windowMs = opts.windowMs ?? 60_000;
  const now = Date.now();
  const cutoff = now - windowMs;
  const bucketKey = `${userId}:${key}`;
  const stamps = (buckets.get(bucketKey) ?? []).filter((t) => t > cutoff);
  if (stamps.length >= max) {
    const oldest = stamps[0]!;
    const retryAfterMs = oldest + windowMs - now;
    return {
      ok: false,
      retryAfterSeconds: Math.max(1, Math.ceil(retryAfterMs / 1000)),
    };
  }
  stamps.push(now);
  buckets.set(bucketKey, stamps);
  return { ok: true };
}

// For tests only — clears the in-memory bucket map between cases.
export function _resetRateLimit() {
  buckets.clear();
}
