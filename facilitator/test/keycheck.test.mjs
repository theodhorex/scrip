import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { loadPolicy } from '../src/policy.mjs';
import { createKeyVerifier } from '../src/keycheck.mjs';
import { basePolicy, fakeProvider, goodPermission, AGENT, CONTRACT } from './helpers.mjs';

const policy = loadPolicy(basePolicy);
const pk = () => KeyPair.fromRandom('ed25519').getPublicKey();
const mk = (provider, extra = {}) => {
  let t = 0;
  const clock = { now: () => t, advance: (ms) => (t += ms) };
  return { clock, kv: createKeyVerifier({ provider, policy, now: clock.now, ...extra }) };
};
class AccessKeyDoesNotExistError extends Error {}
class AccountDoesNotExistError extends Error {}

test('accepts a FunctionCall key bound to the contract with allowed methods', async () => {
  const { kv } = mk(fakeProvider());
  const r = await kv.check(AGENT, pk());
  assert.equal(r.ok, true);
  assert.equal(r.nonce, 0n);
});

test('rejects FullAccess, wrong receiver, empty/foreign methods, zero allowance, missing key with KEY_NOT_ALLOWED', async () => {
  const cases = [
    'FullAccess',
    goodPermission({ receiver_id: 'evil.testnet' }),
    goodPermission({ method_names: [] }),
    goodPermission({ method_names: ['request_payment', 'withdraw'] }),
    goodPermission({ allowance: '0' }),
  ];
  for (const permission of cases) {
    const { kv } = mk(fakeProvider({ permission }));
    assert.equal((await kv.check(AGENT, pk())).code, 'KEY_NOT_ALLOWED', JSON.stringify(permission));
  }
  for (const E of [AccessKeyDoesNotExistError, AccountDoesNotExistError]) {
    const { kv } = mk(fakeProvider({ onKey: () => { throw new E('nope'); } }));
    assert.equal((await kv.check(AGENT, pk())).code, 'KEY_NOT_ALLOWED');
  }
});

test('null allowance (unlimited) is fine; allowance 0 is not', async () => {
  assert.equal((await mk(fakeProvider({ permission: goodPermission({ allowance: null }) })).kv.check(AGENT, pk())).ok, true);
});

test('RPC failure gives UPSTREAM_ERROR and is not cached', async () => {
  let fail = true;
  const p = fakeProvider({ onKey: () => { if (fail) throw new Error('rpc down'); return { permission: goodPermission() }; } });
  const { kv } = mk(p);
  const key = pk();
  assert.equal((await kv.check(AGENT, key)).code, 'UPSTREAM_ERROR');
  fail = false;
  assert.equal((await kv.check(AGENT, key)).ok, true);
});

test('positive cache 60 s, negative cache 10 s, per (account, key)', async () => {
  const p = fakeProvider();
  const { kv, clock } = mk(p);
  const key = pk();
  await kv.check(AGENT, key); await kv.check(AGENT, key);
  assert.equal(p.calls.viewAccessKey, 1);
  await kv.check('other.testnet', key);
  assert.equal(p.calls.viewAccessKey, 2);
  clock.advance(59_000); await kv.check(AGENT, key);
  assert.equal(p.calls.viewAccessKey, 2);
  clock.advance(2_000); await kv.check(AGENT, key);
  assert.equal(p.calls.viewAccessKey, 3);

  const pn = fakeProvider({ permission: 'FullAccess' });
  const n = mk(pn);
  const k2 = pk();
  await n.kv.check(AGENT, k2); await n.kv.check(AGENT, k2);
  assert.equal(pn.calls.viewAccessKey, 1);
  n.clock.advance(10_001); await n.kv.check(AGENT, k2);
  assert.equal(pn.calls.viewAccessKey, 2);
});

test('cache is bounded', async () => {
  const { kv } = mk(fakeProvider(), { maxEntries: 3 });
  for (let i = 0; i < 20; i++) await kv.check(AGENT, pk());
  assert.ok(kv.size() <= 3);
});

test('N-L4: forged random keys cannot evict valid positive entries; negatives are bounded separately', async () => {
  const { KeyPair } = await import('near-api-js');
  const { createKeyVerifier } = await import('../src/keycheck.mjs');
  const { loadPolicy } = await import('../src/policy.mjs');
  const policy = loadPolicy(basePolicy);
  const missing = class AccessKeyDoesNotExistError extends Error {};
  const good = KeyPair.fromRandom('ed25519').getPublicKey();
  let calls = 0;
  const provider = { viewAccessKey: async ({ publicKey }) => { calls++; if (publicKey.toString() === good.toString()) return { permission: goodPermission() }; throw new missing('x'); } };
  const kv = createKeyVerifier({ provider, policy, maxEntries: 3, maxNegEntries: 4 });
  assert.equal((await kv.check(AGENT, good)).ok, true);
  for (let i = 0; i < 50; i++) assert.equal((await kv.check(AGENT, KeyPair.fromRandom('ed25519').getPublicKey())).code, 'KEY_NOT_ALLOWED');
  assert.deepEqual(kv.sizes(), { pos: 1, neg: 4 });
  const before = calls;
  assert.equal((await kv.check(AGENT, good)).ok, true);
  assert.equal(calls, before); // still cached
});
