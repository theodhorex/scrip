// F-C: stricter relay verification. Each rejection path is its own test.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actions } from 'near-api-js';
import { loadPolicy } from '../src/policy.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';
import { makeRelayer, createSerialQueue } from '../src/relay.mjs';
import { createKeyVerifier } from '../src/keycheck.mjs';
import { basePolicy, makeSigned, fakeProvider, goodPermission } from './helpers.mjs';

const MIN_BALANCE = BigInt(1e24); // 1 NEAR in yocto

function setup({ height = 1000, keyNonce = 0n, minBalance = MIN_BALANCE, balance = BigInt(10e24), capacity = 5 } = {}) {
  const calls = { submit: [], blockArgs: [], balance: 0 };
  const provider = fakeProvider({ height, permission: goodPermission() });
  const baseViewBlock = provider.viewBlock;
  provider.viewBlock = async (args) => (calls.blockArgs.push(args), baseViewBlock(args));
  const relayerAccount = { relayMetaTransaction: async (sd) => (calls.submit.push(sd), { transaction: { hash: 'HASHX' }, status: { SuccessValue: '' } }) };
  let t = 0;
  const policy = loadPolicy({ ...basePolicy, rateLimit: { capacity, refillPerSecond: 1 } });
  const limiter = createRateLimiter({ capacity, refillPerSecond: 1, now: () => t });
  const globalLimiter = createRateLimiter({ capacity: 1000, refillPerSecond: 1, now: () => t });
  const providerForKeys = { ...provider, viewAccessKey: async (a) => ({ nonce: keyNonce, permission: goodPermission() }) };
  const keyVerifier = createKeyVerifier({ provider: providerForKeys, policy, now: () => t });
  const relayer = makeRelayer({
    provider: providerForKeys, relayerAccount, policy, limiter, globalLimiter, keyVerifier,
    minBalance, relayerBalance: async () => (calls.balance++, balance), now: () => t, time: () => t,
    queue: createSerialQueue(),
  });
  return { calls, relayer, policy, limiter, providerForKeys, setTime: (x) => { t = x; } };
}

test('F-C: junk / non-canonical request_payment args are rejected as BAD_CALL_ARGS before any RPC', async () => {
  const cases = [
    Buffer.from('not json', 'utf8'),
    Buffer.from('{"mandate_id":"1","recipient":"bob.testnet"}', 'utf8'), // missing amount+nonce
    Buffer.from('{"mandate_id":"-1","recipient":"bob.testnet","amount":"1","nonce":1}', 'utf8'),
    Buffer.from('{"mandate_id":1,"recipient":"bob.testnet","amount":"01","nonce":1}', 'utf8'), // leading zero
    Buffer.from('{"mandate_id":1,"recipient":"bob.testnet","amount":"x","nonce":1}', 'utf8'),
    Buffer.from('{"mandate_id":[],"recipient":"bob.testnet","amount":"1","nonce":1}', 'utf8'),
    Buffer.from('{"mandate_id":1,"recipient":"Not A NEAR Account","amount":"1","nonce":1}', 'utf8'),
    Buffer.from('{"mandate_id":1,"recipient":"bob.testnet","amount":"99999999999999999999999999999999999999999","nonce":1}', 'utf8'), // > u128
  ];
  const s = setup();
  for (const arg of cases) {
    const r = await s.relayer.relay((await makeSigned({ actions: [actions.functionCall('request_payment', arg, 100_000_000_000_000n, 0n)] })).b64);
    assert.equal(r.ok, false, `expected reject for args ${arg}`);
    assert.equal(r.code, 'BAD_CALL_ARGS', `expected BAD_CALL_ARGS for args ${arg}, got ${JSON.stringify(r)}`);
  }
  assert.equal(s.calls.submit.length, 0);
  assert.equal(s.calls.balance, 0);
});

test('F-C: canonical args are accepted (u64 as string or number)', async () => {
  const s = setup();
  const arg = Buffer.from('{"mandate_id":"5","recipient":"shop.testnet","amount":"200000","nonce":3}', 'utf8');
  const r = await s.relayer.relay((await makeSigned({ actions: [actions.functionCall('request_payment', arg, 100_000_000_000_000n, 0n)] })).b64);
  assert.deepEqual([r.ok, r.txHash], [true, 'HASHX']);
});

test('F-C: delegate nonce <= on-chain access-key nonce is rejected (NONCE_TOO_LOW), no submit, no key cache write', async () => {
  const s = setup({ keyNonce: 5n });
  assert.equal((await s.relayer.relay((await makeSigned({ nonce: 5n })).b64)).code, 'NONCE_TOO_LOW');
  assert.equal((await s.relayer.relay((await makeSigned({ nonce: 3n })).b64)).code, 'NONCE_TOO_LOW');
  assert.equal(s.calls.submit.length, 0);
  const r = await s.relayer.relay((await makeSigned({ nonce: 6n })).b64); // strictly above the on-chain nonce
  assert.equal(r.ok, true);
});

test('F-C: block height is read with finality "final", not optimistic', async () => {
  const s = setup();
  await s.relayer.relay((await makeSigned({ nonce: 1n })).b64);
  assert.ok(s.calls.blockArgs.length >= 1);
  assert.ok(s.calls.blockArgs.every((a) => a && a.finality === 'final'), JSON.stringify(s.calls.blockArgs));
});

test('F-C: relayer balance below RELAYER_MIN_BALANCE is rejected (RELAYER_LOW_BALANCE) without submit or rate tokens', async () => {
  const s = setup({ balance: BigInt(1e24) }); // exactly the minimum -> below
  const r = await s.relayer.relay((await makeSigned({})).b64);
  assert.equal(r.code, 'RELAYER_LOW_BALANCE');
  assert.equal(s.calls.submit.length, 0);
  assert.equal(s.limiter.size(), 0);
  assert.equal(s.calls.balance, 1);
});

test('F-C: relayer balance cache refreshes after the TTL (failed -> funded mix)', async () => {
  let t = 0;
  let balance = BigInt(1e24) - 1n; // below the minimum
  const calls = { submit: 0, balance: 0 };
  const provider = fakeProvider({ height: 1000, permission: goodPermission() });
  const relayerAccount = { relayMetaTransaction: async () => (calls.submit++, { transaction: { hash: 'H' }, status: { SuccessValue: '' } }) };
  const policy = loadPolicy({ ...basePolicy, rateLimit: { capacity: 9, refillPerSecond: 1 } });
  const keyVerifier = createKeyVerifier({ provider, policy, now: () => t });
  const relayer = makeRelayer({
    provider, relayerAccount, policy,
    limiter: createRateLimiter({ capacity: 9, refillPerSecond: 1, now: () => t }),
    globalLimiter: createRateLimiter({ capacity: 99, refillPerSecond: 1, now: () => t }),
    keyVerifier, minBalance: BigInt(1e24), relayerBalance: async () => (calls.balance++, balance), now: () => t,
  });
  assert.equal((await relayer.relay((await makeSigned({})).b64)).code, 'RELAYER_LOW_BALANCE');
  assert.equal(calls.balance, 1);
  balance = BigInt(10e24);
  assert.equal((await relayer.relay((await makeSigned({ nonce: 2n })).b64)).code, 'RELAYER_LOW_BALANCE'); // cached, still low
  assert.equal(calls.balance, 1);
  t = 1500; // past the cache TTL
  const r = await relayer.relay((await makeSigned({ nonce: 3n })).b64);
  assert.equal(r.ok, true, `expected funded relay ok, got ${JSON.stringify(r)}`);
  assert.ok(calls.balance >= 2);
  assert.equal(calls.submit, 1);
});

test('F-C: relayer balance lookup failure is UPSTREAM_ERROR (never broadcasts without a health check)', async () => {
  const calls = { submit: 0 };
  const provider = fakeProvider({ height: 1000, permission: goodPermission() });
  const relayerAccount = { relayMetaTransaction: async () => (calls.submit++, { transaction: { hash: 'H' }, status: { SuccessValue: '' } }) };
  const policy = loadPolicy({ ...basePolicy, rateLimit: { capacity: 9, refillPerSecond: 1 } });
  const keyVerifier = createKeyVerifier({ provider, policy });
  const relayer = makeRelayer({
    provider, relayerAccount, policy,
    limiter: createRateLimiter({ capacity: 9, refillPerSecond: 1, now: () => 0 }),
    globalLimiter: createRateLimiter({ capacity: 99, refillPerSecond: 1, now: () => 0 }),
    keyVerifier, minBalance: BigInt(1e24), relayerBalance: async () => { throw new Error('rpc down'); }, now: () => 0,
  });
  const r = await relayer.relay((await makeSigned({})).b64);
  assert.equal(r.code, 'UPSTREAM_ERROR');
  assert.equal(calls.submit, 0);
});
