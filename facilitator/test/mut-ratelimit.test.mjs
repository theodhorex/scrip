// Tests added to kill surviving mutants in src/ratelimit.mjs (Stryker run 2026-10-30).
// Mutant ids come from .stryker-out/mutation-ratelimit-2026-10-30.json and each test
// names the ids it kills. All assertions use an injected clock (no sleeps) and target
// observable limiter behaviour: allowed / retryAfterMs / refund effect / bucket count.
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/ratelimit.mjs';

const mk = (overrides = {}) => {
  let t = 0;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  const rl = createRateLimiter({ capacity: 2, refillPerSecond: 1, now: clock.now, ...overrides });
  return { rl, clock };
};

const drain = (rl, id, times) => {
  for (let i = 0; i < times; i++) assert.equal(rl.tryTake(id).allowed, true, `${id} take ${i + 1}`);
};

// Deterministic PRNG so the property tests are reproducible and dependency-free.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('makeRoom: a bucket refilled exactly to capacity is reclaimed, not LRU-evicted (kills 9,10,12)', () => {
  const { rl, clock } = mk({ capacity: 3, refillPerSecond: 1, maxBuckets: 4 });
  for (const id of ['a', 'b', 'c', 'd']) rl.tryTake(id); // 3 -> 2 tokens each
  assert.equal(rl.size(), 4);

  clock.advance(1000); // +1 token: exactly 3 == capacity, the idle boundary
  rl.tryTake('e');

  // All four idle buckets are dropped (lossless), so only "e" remains tracked.
  // cond -> false / no delete (9, 12) only LRU-evicts one bucket, and `>` (10)
  // misses the exact-capacity boundary, leaving four buckets behind.
  assert.equal(rl.size(), 1);
});

test('makeRoom: busy buckets survive pressure; only the idle one is dropped (kills 8,11)', () => {
  // capacity 1, rate 1: "x" drained at t=0 is exactly full again at t=1000, while
  // "a" (created at t=1000) is still empty and is the most recently used bucket.
  const { rl, clock } = mk({ capacity: 1, refillPerSecond: 1, maxBuckets: 2 });
  drain(rl, 'x', 1);
  clock.advance(1000);
  drain(rl, 'a', 1);

  assert.equal(rl.tryTake('c').allowed, true); // hits maxBuckets -> makeRoom(1000)

  // "x" was idle and dropped; "a" is busy and must keep its empty bucket.
  // 8 drops every bucket, 11 drops the busy one and keeps the idle one, so both
  // reset "a" to a full bucket and hand out a token the limiter owes nobody.
  assert.equal(rl.tryTake('a').allowed, false);
});

test('tryTake: a hit on an existing bucket refreshes its LRU position (kills 21)', () => {
  const { rl } = mk({ capacity: 2, refillPerSecond: 0.001, maxBuckets: 2 });
  drain(rl, 'a', 2);
  drain(rl, 'b', 2);

  assert.equal(rl.tryTake('a').allowed, false); // denied, but "a" becomes most recent
  rl.tryTake('c'); // pressure: must evict "b" (LRU), not "a"

  // Without the delete+re-insert the map keeps its old order, "a" is evicted and
  // the next call mints a fresh full bucket for it.
  assert.equal(rl.tryTake('a').allowed, false);
});

test('tryTake: retryAfterMs is the missing tokens divided by the refill rate (kills 40)', () => {
  const { rl, clock } = mk({ capacity: 2, refillPerSecond: 4 });
  drain(rl, 'a', 2);

  // One token missing at 4 tokens/s is a 250 ms wait.
  assert.deepEqual(rl.tryTake('a'), { allowed: false, retryAfterMs: 250 });

  clock.advance(100); // 0.4 tokens accumulated -> 0.6 missing -> 150 ms
  assert.deepEqual(rl.tryTake('a'), { allowed: false, retryAfterMs: 150 });
});

test('refund: an unknown id is a no-op, never throws and never creates a bucket (kills 44)', () => {
  const { rl } = mk({ capacity: 2, refillPerSecond: 1 });
  assert.doesNotThrow(() => rl.refund('never-seen'));
  assert.equal(rl.size(), 0);
  // Still a no-op once other buckets exist.
  drain(rl, 'a', 1);
  assert.doesNotThrow(() => rl.refund('never-seen'));
  assert.equal(rl.size(), 1);
});

test('refund: returns exactly one token and never goes above capacity (kills 46)', () => {
  const { rl } = mk({ capacity: 2, refillPerSecond: 0.001 });
  drain(rl, 'a', 2);

  rl.refund('a');
  assert.equal(rl.tryTake('a').allowed, true, 'the refunded token is spendable');
  assert.equal(rl.tryTake('a').allowed, false, 'only one token came back');

  // Repeated refunds saturate at capacity instead of exceeding it.
  rl.refund('a');
  rl.refund('a');
  rl.refund('a');
  assert.equal(rl.tryTake('a').allowed, true);
  assert.equal(rl.tryTake('a').allowed, true);
  assert.equal(rl.tryTake('a').allowed, false);
});

test('property: a bucket never holds more than capacity and refill is monotonic (kills 2,3,4,5,6,30,33,41)', () => {
  const rand = rng(0x9a5);
  // 1) At a frozen instant a fresh bucket allows exactly `capacity` takes.
  for (let capacity = 1; capacity <= 8; capacity++) {
    const { rl } = mk({ capacity, refillPerSecond: 1 });
    for (let i = 0; i < capacity; i++) assert.equal(rl.tryTake('a').allowed, true, `capacity ${capacity} take ${i + 1}`);
    assert.equal(rl.tryTake('a').allowed, false, `capacity ${capacity} must not exceed the bucket`);
  }

  // 2) Ageing a drained bucket, the advertised wait never grows and never exceeds
  //    the time needed to earn one token from empty.
  const capacity = 4;
  const refillPerSecond = 2;
  let previous = Infinity;
  let elapsed = 0;
  for (let i = 0; i < 25; i++) {
    elapsed += Math.floor(rand() * 120);
    let t = 0;
    const probe = createRateLimiter({ capacity, refillPerSecond, now: () => t });
    for (let k = 0; k < capacity; k++) probe.tryTake('a'); // drained at t=0
    t = elapsed;
    const { allowed, retryAfterMs } = probe.tryTake('a');
    if (allowed) break; // the bucket caught up: every later sample is allowed too
    assert.ok(retryAfterMs <= previous, `wait must not grow: ${retryAfterMs} > ${previous}`);
    assert.ok(retryAfterMs <= Math.ceil(1000 / refillPerSecond), `wait bounded by one token: ${retryAfterMs}`);
    previous = retryAfterMs;
    // Waiting the advertised time (+1 ms for ceil rounding) admits the next take.
    t = elapsed + retryAfterMs + 1;
    assert.equal(probe.tryTake('a').allowed, true, `retryAfterMs=${retryAfterMs} must be enough to wait out`);
  }
  assert.ok(previous <= Math.ceil(1000 / refillPerSecond), 'the property sampled at least one denied state');
});
