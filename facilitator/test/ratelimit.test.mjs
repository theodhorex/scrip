import test from 'node:test';
import assert from 'node:assert/strict';
import { createRateLimiter } from '../src/ratelimit.mjs';

const mk = (extra = {}) => {
  let t = 0;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  return { clock, rl: createRateLimiter({ capacity: 3, refillPerSecond: 1, now: clock.now, ...extra }) };
};

test('burst up to capacity then blocked with retryAfterMs', () => {
  const { rl } = mk();
  for (let i = 0; i < 3; i++) assert.equal(rl.tryTake('a').allowed, true);
  const r = rl.tryTake('a');
  assert.equal(r.allowed, false);
  assert.equal(r.retryAfterMs, 1000);
});

test('refills over time, capped at capacity', () => {
  const { rl, clock } = mk();
  for (let i = 0; i < 3; i++) rl.tryTake('a');
  clock.advance(500);
  assert.equal(rl.tryTake('a').retryAfterMs, 500);
  clock.advance(500);
  assert.equal(rl.tryTake('a').allowed, true);
  clock.advance(1_000_000);
  for (let i = 0; i < 3; i++) assert.equal(rl.tryTake('a').allowed, true);
  assert.equal(rl.tryTake('a').allowed, false);
});

test('agents are independent', () => {
  const { rl } = mk();
  for (let i = 0; i < 3; i++) rl.tryTake('a');
  assert.equal(rl.tryTake('a').allowed, false);
  assert.equal(rl.tryTake('b').allowed, true);
});

test('idle buckets are evicted; memory bounded by maxBuckets', () => {
  const { rl, clock } = mk({ maxBuckets: 4 });
  for (const id of ['a', 'b', 'c', 'd']) rl.tryTake(id);
  assert.equal(rl.size(), 4);
  clock.advance(10_000); // all refilled -> idle, safely evictable
  rl.tryTake('e');
  assert.ok(rl.size() <= 4);
  for (let i = 0; i < 100; i++) rl.tryTake('x' + i); // flood of ids at the same instant
  assert.ok(rl.size() <= 4);
});
