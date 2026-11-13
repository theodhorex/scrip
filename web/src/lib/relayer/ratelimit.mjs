// Token bucket per agent id, injected clock, bounded memory.
export function createRateLimiter({ capacity, refillPerSecond, now = Date.now, maxBuckets = 10_000 }) {
  const buckets = new Map(); // id -> { tokens, last }; Map order = least recently used first
  const refill = (b, t) => Math.min(capacity, b.tokens + ((t - b.last) * refillPerSecond) / 1000);

  function makeRoom(t) {
    // 1) idle buckets are full again, so dropping them is lossless.
    for (const [id, b] of buckets) if (refill(b, t) >= capacity) buckets.delete(id);
    // 2) still full of busy buckets: evict least recently used (bounded memory beats perfect fairness).
    while (buckets.size >= maxBuckets) buckets.delete(buckets.keys().next().value);
  }

  return {
    tryTake(agentId) {
      const t = now();
      let b = buckets.get(agentId);
      if (b) buckets.delete(agentId); // re-insert below to keep LRU order
      else {
        if (buckets.size >= maxBuckets) makeRoom(t);
        b = { tokens: capacity, last: t };
      }
      b.tokens = refill(b, t);
      b.last = t;
      buckets.set(agentId, b);
      if (b.tokens >= 1) {
        b.tokens -= 1;
        return { allowed: true, retryAfterMs: 0 };
      }
      return { allowed: false, retryAfterMs: Math.ceil(((1 - b.tokens) * 1000) / refillPerSecond) };
    },
    /** Give back one token (failure before broadcast). No-op if the bucket was already dropped (it is full then). */
    refund(agentId) {
      const b = buckets.get(agentId);
      if (b) b.tokens = Math.min(capacity, b.tokens + 1);
    },
    size: () => buckets.size,
  };
}
