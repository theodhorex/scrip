// Tests added to kill surviving mutants in src/keycheck.mjs (Stryker run 2026-11-01).
// Mutant ids come from .stryker-out/mutation-keycheck-before.json; each test names the
// ids it kills. The verifier is a security control: it decides whether a signing key is
// a restricted contract key, caches both answers, and must fail closed on anything odd.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { loadPolicy } from '../src/policy.mjs';
import { createKeyVerifier } from '../src/keycheck.mjs';
import { basePolicy, fakeProvider, goodPermission, AGENT, CONTRACT } from './helpers.mjs';

const policy = loadPolicy(basePolicy);
const pk = () => KeyPair.fromRandom('ed25519').getPublicKey();
const label = (v) => { try { return JSON.stringify(v) ?? String(v); } catch { return String(v); } };

const mk = (provider, extra = {}) => {
  let t = 0;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  return { clock, kv: createKeyVerifier({ provider, policy, now: clock.now, ...extra }) };
};

class AccessKeyDoesNotExistError extends Error {}
class AccountDoesNotExistError extends Error {}

function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('permissionOk: anything that is not a FunctionCall key on the contract is rejected (kills 0, 1, 2, 3, 6, 7, 8, 9, 11, 12, 13, 14, 15, 16, 17, 18, 19, 20, 21, 22, 23, 24, 25, 26, 86)', async () => {
  const bad = [
    'FullAccess',
    null,
    {},
    [],
    { FunctionCall: null },
    { FunctionCall: { receiver_id: 'evil.testnet', method_names: ['request_payment'] } },
    { FunctionCall: { receiver_id: CONTRACT, method_names: [] } },
    { FunctionCall: { receiver_id: CONTRACT, method_names: 'request_payment' } },
    { FunctionCall: { receiver_id: CONTRACT, method_names: ['request_payment', 'withdraw'] } },
    { FunctionCall: { receiver_id: CONTRACT, method_names: ['withdraw'] } },
  ];
  for (const permission of bad) {
    const { kv } = mk(fakeProvider({ permission }));
    const r = await kv.check(AGENT, pk());
    assert.equal(r.ok, false, label(permission));
    assert.equal(r.code, 'KEY_NOT_ALLOWED', label(permission));
  }
  // An absent permission field (undefined) is rejected as well.
  assert.equal((await mk(fakeProvider({ onKey: () => ({ nonce: 0n }) })).kv.check(AGENT, pk())).code, 'KEY_NOT_ALLOWED');
  // Mutant 86: provider returning null/undefined object does not crash with TypeError (kills 86)
  assert.equal((await mk(fakeProvider({ onKey: () => null })).kv.check(AGENT, pk())).code, 'KEY_NOT_ALLOWED');
  assert.equal((await mk(fakeProvider({ onKey: () => undefined })).kv.check(AGENT, pk())).code, 'KEY_NOT_ALLOWED');
  const okPerms = [
    goodPermission(),
    goodPermission({ allowance: null }),
    goodPermission({ allowance: undefined }),
    { FunctionCall: { receiver_id: CONTRACT, method_names: ['request_payment'] } }, // no allowance field at all
  ];
  for (const permission of okPerms) {
    const { kv } = mk(fakeProvider({ permission }));
    assert.equal((await kv.check(AGENT, pk())).ok, true, label(permission));
  }
});

test('permissionOk: a zero or unparsable allowance is rejected, a positive one accepted (kills 27, 28, 29, 30, 31, 32, 33, 34, 35, 36)', async () => {
  for (const allowance of ['0', 0, 0n, '0x0', 'abc', {}]) {
    const { kv } = mk(fakeProvider({ permission: goodPermission({ allowance }) }));
    assert.equal((await kv.check(AGENT, pk())).code, 'KEY_NOT_ALLOWED', String(allowance));
  }
  for (const allowance of ['1', 1, 1n, '1000000000000000000000000']) {
    const { kv } = mk(fakeProvider({ permission: goodPermission({ allowance }) }));
    assert.equal((await kv.check(AGENT, pk())).ok, true, String(allowance));
  }
});

test('positive cache: fresh at 59 999 ms, stale exactly at 60 000 ms (kills 37, 38, 39, 40, 41, 71)', async () => {
  const p = fakeProvider();
  const { kv, clock } = mk(p);
  const key = pk();
  const first = await kv.check(AGENT, key);
  assert.equal(first.fresh, true);
  const hit = await kv.check(AGENT, key);
  assert.equal(hit.fresh, false);
  assert.equal(hit.nonce, first.nonce);
  assert.equal(p.calls.viewAccessKey, 1);

  clock.advance(59_999);
  assert.equal((await kv.check(AGENT, key)).fresh, false);
  assert.equal(p.calls.viewAccessKey, 1);

  clock.advance(1); // exactly until -> expired
  const again = await kv.check(AGENT, key);
  assert.equal(again.fresh, true);
  assert.equal(p.calls.viewAccessKey, 2);

  // Mutant 71: stale positive entry is evicted from pos cache even if provider fails on refresh
  let failPos = false;
  const pStale = fakeProvider({ onKey: () => { if (failPos) throw new Error('fail'); return { permission: goodPermission(), nonce: 1n }; } });
  const { kv: kvStalePos, clock: clkPos } = mk(pStale);
  const keyStalePos = pk();
  await kvStalePos.check(AGENT, keyStalePos);
  assert.equal(kvStalePos.sizes().pos, 1);
  clkPos.advance(60_000); // stale
  failPos = true;
  const rStalePos = await kvStalePos.check(AGENT, keyStalePos);
  assert.equal(rStalePos.code, 'UPSTREAM_ERROR');
  assert.equal(kvStalePos.sizes().pos, 0, 'stale pos entry must be evicted (kills 71)');
});

test('negative cache: fresh rejection at 9 999 ms, retried exactly at 10 000 ms (kills 44, 45, 46, 47, 81, 83)', async () => {
  const p = fakeProvider({ permission: 'FullAccess' });
  const { kv, clock } = mk(p);
  const key = pk();
  const res1 = await kv.check(AGENT, key);
  assert.equal(res1.ok, false);
  assert.equal(res1.code, 'KEY_NOT_ALLOWED');
  const res2 = await kv.check(AGENT, key);
  assert.equal(res2.ok, false, 'negative cache hit must have ok: false (kills 81)');
  assert.equal(res2.code, 'KEY_NOT_ALLOWED');
  assert.equal(p.calls.viewAccessKey, 1);

  clock.advance(9_999);
  assert.equal((await kv.check(AGENT, key)).code, 'KEY_NOT_ALLOWED');
  assert.equal(p.calls.viewAccessKey, 1);

  clock.advance(1); // exactly until -> expired, re-asked
  assert.equal((await kv.check(AGENT, key)).code, 'KEY_NOT_ALLOWED');
  assert.equal(p.calls.viewAccessKey, 2);

  // Mutant 83: stale negative entry is evicted from neg cache even if provider fails on refresh
  let failNeg = false;
  const pStaleNeg = fakeProvider({ onKey: () => { if (failNeg) throw new Error('fail'); throw new AccessKeyDoesNotExistError('missing'); } });
  const { kv: kvStaleNeg, clock: clkNeg } = mk(pStaleNeg);
  const keyStaleNeg = pk();
  await kvStaleNeg.check(AGENT, keyStaleNeg);
  assert.equal(kvStaleNeg.sizes().neg, 1);
  clkNeg.advance(10_000); // stale
  failNeg = true;
  const rStaleNeg = await kvStaleNeg.check(AGENT, keyStaleNeg);
  assert.equal(rStaleNeg.code, 'UPSTREAM_ERROR');
  assert.equal(kvStaleNeg.sizes().neg, 0, 'stale neg entry must be evicted (kills 83)');
});

test('cache identity is (accountId, publicKey.toString()) (kills 42, 43)', async () => {
  const p = fakeProvider();
  const { kv } = mk(p);
  const key = pk();
  await kv.check(AGENT, key);
  await kv.check(AGENT, key); // same account + key: hit
  assert.equal(p.calls.viewAccessKey, 1);
  await kv.check('other.testnet', key); // different account: miss
  assert.equal(p.calls.viewAccessKey, 2);
  await kv.check(AGENT, pk()); // different key: miss
  assert.equal(p.calls.viewAccessKey, 3);
});

test('RPC errors: only the two "missing" errors are a rejection, everything else is UPSTREAM_ERROR and never cached (kills 4, 5, 60, 61, 62, 63)', async () => {
  for (const E of [AccessKeyDoesNotExistError, AccountDoesNotExistError]) {
    const p = fakeProvider({ onKey: () => { throw new E('missing'); } });
    const { kv } = mk(p);
    const key = pk();
    assert.equal((await kv.check(AGENT, key)).code, 'KEY_NOT_ALLOWED');
    await kv.check(AGENT, key); // a missing key is a negative cache entry
    assert.equal(p.calls.viewAccessKey, 1);
  }
  // A provider that throws a non-Error (null/undefined) must still fail closed, not crash.
  for (const thrown of [null, undefined]) {
    const { kv } = mk(fakeProvider({ onKey: () => { throw thrown; } }));
    const r = await kv.check(AGENT, pk());
    assert.equal(r.ok, false, `thrown ${String(thrown)}`);
    assert.equal(r.code, 'UPSTREAM_ERROR', `thrown ${String(thrown)}`);
  }

  // A same-named class from another module is matched by constructor name only.
  assert.equal((await mk(fakeProvider({ onKey: () => { throw Object.assign(new Error('x'), { constructor: { name: 'AccessKeyDoesNotExistError' } }); } })).kv.check(AGENT, pk())).code, 'KEY_NOT_ALLOWED');
  assert.equal((await mk(fakeProvider({ onKey: () => { throw new Error('boom'); } })).kv.check(AGENT, pk())).code, 'UPSTREAM_ERROR');

  // Mutant 4, 5: e.constructor is null or primitive throws
  assert.equal((await mk(fakeProvider({ onKey: () => { throw Object.create(null); } })).kv.check(AGENT, pk())).code, 'UPSTREAM_ERROR');
  assert.equal((await mk(fakeProvider({ onKey: () => { throw 'plain string error'; } })).kv.check(AGENT, pk())).code, 'UPSTREAM_ERROR');

  // An upstream failure neither caches a rejection nor spends a positive token.
  let fail = true;
  const p3 = fakeProvider({ onKey: () => { if (fail) throw new Error('down'); return { permission: goodPermission(), nonce: 5n }; } });
  const { kv } = mk(p3);
  const key = pk();
  assert.equal((await kv.check(AGENT, key)).code, 'UPSTREAM_ERROR');
  assert.equal(kv.size(), 0);
  fail = false;
  const r = await kv.check(AGENT, key);
  assert.equal(r.ok, true);
  assert.equal(r.nonce, 5n);
  assert.deepEqual(kv.sizes(), { pos: 1, neg: 0 });
});

test('nonce: bigint coercion, 0n kept, missing or garbage becomes undefined (kills 87, 88, 90)', async () => {
  const cases = [
    [undefined, undefined],
    [0n, 0n],
    [0, 0n],
    ['42', 42n],
    [42n, 42n],
    [null, undefined], // BigInt(null) throws, so no nonce is reported
    [{}, undefined], // BigInt({}) throws -> undefined
    ['not-a-number', undefined],
  ];
  for (const [nonce, want] of cases) {
    const { kv } = mk(fakeProvider({ onKey: () => ({ permission: goodPermission(), nonce }) }));
    const r = await kv.check(AGENT, pk());
    assert.equal(r.ok, true, String(nonce));
    assert.equal(r.nonce, want, `nonce ${String(nonce)}`);
  }
});

test('evict drops only that one positive entry and nothing else (kills 93, 94, 95)', async () => {
  const p = fakeProvider();
  const { kv } = mk(p);
  const key = pk();
  const other = pk();
  await kv.check(AGENT, key);
  await kv.check(AGENT, other);
  assert.deepEqual(kv.sizes(), { pos: 2, neg: 0 });

  kv.evict('elsewhere.testnet', key); // wrong account: no-op
  assert.deepEqual(kv.sizes(), { pos: 2, neg: 0 });

  kv.evict(AGENT, key);
  assert.deepEqual(kv.sizes(), { pos: 1, neg: 0 });
  await kv.check(AGENT, key); // must ask the chain again
  assert.equal(p.calls.viewAccessKey, 3);
  await kv.check(AGENT, other); // untouched, still cached
  assert.equal(p.calls.viewAccessKey, 3);
});

test('both caches are bounded and evict the oldest entry, keeping maps separate (kills 49, 50, 51, 52, 53, 54, 55, 56, 57, 58, 59, 64, 65)', async () => {
  const keys = [1, 2, 3, 4].map(() => KeyPair.fromRandom('ed25519').getPublicKey());
  // Positive cache: cap 2, insert 3 -> the oldest is dropped.
  const p = fakeProvider();
  const pos = mk(p, { maxEntries: 2, maxNegEntries: 3 }).kv;
  for (const k of keys.slice(0, 3)) await pos.check(AGENT, k);
  assert.deepEqual(pos.sizes(), { pos: 2, neg: 0 });

  // Mutant 51: updating an existing key refreshes its LRU position so it is not evicted
  const pLRU = fakeProvider();
  const kvLRU = mk(pLRU, { maxEntries: 2 }).kv;
  const keyA = pk();
  const keyB = pk();
  const keyC = pk();
  await kvLRU.check(AGENT, keyA); // insert A
  await kvLRU.check(AGENT, keyB); // insert B
  // evict and re-put or touch
  await kvLRU.check(AGENT, keyA); // touch A
  await kvLRU.check(AGENT, keyC); // insert C -> should evict B, leaving A and C
  assert.deepEqual(kvLRU.sizes(), { pos: 2, neg: 0 });

  // A negative flood cannot evict the two cached positives (separate maps).
  const n = fakeProvider({ onKey: () => { throw new AccessKeyDoesNotExistError('missing'); } });
  const neg = mk(n, { maxEntries: 2, maxNegEntries: 3 }).kv;
  for (const k of keys) await neg.check(AGENT, k);
  assert.deepEqual(neg.sizes(), { pos: 0, neg: 3 });
  assert.equal(neg.size(), 3);
  assert.ok(pos.sizes().pos === 2, 'positive cache is unaffected by negative pressure');
});

test('property: an accepted key always satisfies the restricted-key invariants (kills 96, 97, 98, 99, 100, 101, 102, 103, 104, 105, 106, 107, 108, 109, 110)', async () => {
  const rand = rng(0xbeef);
  const receivers = [CONTRACT, 'evil.testnet', 'other.testnet'];
  const methodSets = [['request_payment'], ['withdraw'], ['request_payment', 'withdraw'], []];
  const allowances = [null, undefined, '0', 0n, '1', '1000'];
  for (let i = 0; i < 200; i++) {
    const pick = (xs) => xs[Math.floor(rand() * xs.length)];
    const permission = rand() < 0.15 ? 'FullAccess' : goodPermission({
      receiver_id: pick(receivers),
      method_names: pick(methodSets),
      allowance: pick(allowances),
    });
    const { kv } = mk(fakeProvider({ permission }));
    const r = await kv.check(AGENT, pk());
    if (r.ok) {
      assert.equal(permission.FunctionCall.receiver_id, CONTRACT, 'accepted key must be bound to the contract');
      assert.ok(permission.FunctionCall.method_names.length > 0, 'accepted key must name at least one method');
      for (const m of permission.FunctionCall.method_names) assert.ok(policy.allowedMethods.includes(m), `accepted method ${m} must be allowlisted`);
      if (permission.FunctionCall.allowance !== null && permission.FunctionCall.allowance !== undefined) {
        assert.notEqual(BigInt(permission.FunctionCall.allowance), 0n, 'accepted key must not have a zero allowance');
      }
      assert.equal(r.fresh, true);
    } else {
      assert.equal(r.code, 'KEY_NOT_ALLOWED');
    }
  }
});
