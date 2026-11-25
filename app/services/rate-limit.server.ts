/**
 * In-process sliding-window rate limiter for login and signup.
 * Its state is per instance. With several Fly machines the effective limit is
 * N × max, which is acceptable as a brute-force brake. Move it to Upstash once
 * the Redis service exists if you need a hard global limit.
 */
const buckets = new Map<string, number[]>();

export function rateLimit(key: string, max: number, windowMs: number): { allowed: boolean; retryAfterSec: number } {
  const now = Date.now();
  const hits = (buckets.get(key) ?? []).filter((t) => now - t < windowMs);

  if (hits.length >= max) {
    buckets.set(key, hits);
    return { allowed: false, retryAfterSec: Math.ceil((windowMs - (now - hits[0])) / 1000) };
  }

  hits.push(now);
  buckets.set(key, hits);

  // Opportunistic cleanup, so the map can't grow without bound.
  if (buckets.size > 10_000) {
    for (const [k, v] of buckets) if (v.every((t) => now - t >= windowMs)) buckets.delete(k);
  }
  return { allowed: true, retryAfterSec: 0 };
}

export function clearRateLimit(key: string) {
  buckets.delete(key);
}
