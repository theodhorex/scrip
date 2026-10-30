import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../src/policy.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';
import { makeRelayer } from '../src/relay.mjs';
import { createKeyVerifier } from '../src/keycheck.mjs';
import { makeRelayer as mk, createSerialQueue } from '../src/relay.mjs';
import { basePolicy, makeSigned, fakeProvider, goodPermission } from './helpers.mjs';

function setup({ capacity = 3, height = 1000, permission, globalCapacity = 1000 } = {}) {
  const calls = { submit: [] };
  const provider = fakeProvider({ height, permission });
  calls.provider = provider.calls;
  const relayerAccount = { relayMetaTransaction: async (sd) => (calls.submit.push(sd), { transaction: { hash: 'HASH1' }, status: { SuccessValue: '' } }) };
  const policy = loadPolicy({ ...basePolicy, rateLimit: { capacity, refillPerSecond: 1 } });
  const limiter = createRateLimiter({ capacity, refillPerSecond: 1, now: () => 0 });
  const globalLimiter = createRateLimiter({ capacity: globalCapacity, refillPerSecond: 1, now: () => 0 });
  const keyVerifier = createKeyVerifier({ provider, policy });
  return { calls, relayer: makeRelayer({ provider, relayerAccount, policy, limiter, globalLimiter, keyVerifier }), provider, relayerAccount, policy, limiter, globalLimiter };
}

test('accepted request: exactly one submit, returns txHash', async () => {
  const s = setup();
  const r = await s.relayer.relay((await makeSigned({})).b64);
  assert.deepEqual([r.ok, r.txHash], [true, 'HASH1']);
  assert.equal(s.calls.submit.length, 1);
  assert.equal(s.calls.provider.viewBlock, 1);
  assert.equal(s.calls.provider.viewAccessKey, 1);
  assert.equal(r.outerSuccess, true);
});

test('rejected requests make zero submit calls; offline rejects never read the block', async () => {
  const s = setup();
  for (const o of [{ method: 'other' }, { deposit: 1n }, { receiverId: 'evil.testnet' }, { maxBlockHeight: 5000n }]) {
    const r = await s.relayer.relay((await makeSigned(o)).b64);
    assert.equal(r.ok, false);
  }
  assert.equal((await s.relayer.relay('garbage')).code, 'BAD_ENCODING');
  assert.equal(s.calls.submit.length, 0);
  assert.equal(s.calls.provider.viewBlock, 1); // N-M1: only the expiry case needs the network
  assert.equal(s.calls.provider.viewAccessKey, 0); // key lookups only for requests that passed validation
});

test('rate-limited request is not submitted; bad signatures do not consume tokens', async () => {
  const s = setup({ capacity: 1 });
  const good = (await makeSigned({})).b64;
  assert.equal((await s.relayer.relay(good)).ok, true);
  const r = await s.relayer.relay((await makeSigned({ nonce: 8n })).b64);
  assert.equal(r.code, 'RATE_LIMITED');
  assert.ok(r.retryAfterMs > 0);
  assert.equal(s.calls.submit.length, 1);
  const raw = Buffer.from(good, 'base64');
  raw[raw.length - 1] ^= 1;
  assert.equal((await s.relayer.relay(raw.toString('base64'))).code, 'BAD_SIGNATURE');
  assert.equal(s.limiter.size(), 1);
});

test('upstream and submit failures map to codes without leaking details', async () => {
  const s = setup();
  s.provider.viewBlock = async () => { throw new Error('secret rpc detail'); };
  assert.deepEqual(await s.relayer.relay((await makeSigned({})).b64), { ok: false, code: 'UPSTREAM_ERROR' });
  const s2 = setup();
  s2.relayerAccount.relayMetaTransaction = async () => { throw new Error('boom'); };
  const r = await s2.relayer.relay((await makeSigned({})).b64);
  assert.equal(r.code, 'RELAY_FAILED');
  assert.ok(!JSON.stringify(r).includes('boom'));
});

test('F2: junk key as a real agent gets KEY_NOT_ALLOWED and never charges the agent bucket', async () => {
  const s = setup({ capacity: 1, permission: 'FullAccess' });
  for (let i = 0; i < 5; i++) assert.equal((await s.relayer.relay((await makeSigned({})).b64)).code, 'KEY_NOT_ALLOWED');
  assert.equal(s.limiter.size(), 0);
  assert.equal(s.globalLimiter.size(), 0);
  assert.equal(s.calls.submit.length, 0);
});

test('F2: wrong-receiver key and missing key are rejected before limiter', async () => {
  const s = setup({ permission: goodPermission({ receiver_id: 'evil.testnet' }) });
  assert.equal((await s.relayer.relay((await makeSigned({})).b64)).code, 'KEY_NOT_ALLOWED');
  const s2 = setup();
  s2.provider.viewAccessKey = async () => { throw new (class AccessKeyDoesNotExistError extends Error {})('gone'); };
  assert.equal((await s2.relayer.relay((await makeSigned({})).b64)).code, 'KEY_NOT_ALLOWED');
  assert.equal(s.limiter.size() + s2.limiter.size(), 0);
});

test('F2: access-key RPC failure gives UPSTREAM_ERROR and consumes no token', async () => {
  const s = setup();
  s.provider.viewAccessKey = async () => { throw new Error('rpc secret'); };
  const r = await s.relayer.relay((await makeSigned({})).b64);
  assert.equal(r.code, 'UPSTREAM_ERROR');
  assert.equal(s.limiter.size(), 0);
  assert.equal(s.calls.submit.length, 0);
});

test('global limiter caps total relays across agents', async () => {
  const s = setup({ globalCapacity: 2 });
  assert.equal((await s.relayer.relay((await makeSigned({})).b64)).ok, true);
  assert.equal((await s.relayer.relay((await makeSigned({ nonce: 8n })).b64)).ok, true);
  const r = await s.relayer.relay((await makeSigned({ nonce: 9n })).b64);
  assert.equal(r.code, 'RATE_LIMITED');
  assert.equal(s.calls.submit.length, 2);
});

test('GAS_TOO_LOW is rejected without any key lookup or submit', async () => {
  const s = setup();
  const r = await s.relayer.relay((await makeSigned({ gas: 30_000_000_000_000n })).b64);
  assert.equal(r.code, 'GAS_TOO_LOW');
  assert.equal(s.calls.provider.viewAccessKey, 0);
  assert.equal(s.calls.submit.length, 0);
});

test('F8: ok:true reports only the outer tx outcome', async () => {
  const s = setup();
  const r = await s.relayer.relay((await makeSigned({})).b64);
  assert.equal(r.outerSuccess, true);
  assert.match(r.note, /inner/i);
});

test('N-M1: offline-invalid input never touches the network', async () => {
  const s = setup();
  for (const o of [{ method: 'other' }, { senderId: 'evil.testnet' }, { gas: 1n }]) await s.relayer.relay((await makeSigned(o)).b64);
  await s.relayer.relay('garbage');
  assert.equal(s.calls.provider.viewBlock, 0);
  assert.equal(s.calls.provider.viewAccessKey, 0);
});

test('N-M1: block height cached ~1 s, refreshed after, failures not cached', async () => {
  let t = 0;
  const s = setup();
  const relayer = mk({ provider: s.provider, relayerAccount: s.relayerAccount, policy: s.policy, limiter: createRateLimiter({ capacity: 99, refillPerSecond: 1, now: () => 0 }), now: () => t });
  for (let i = 0; i < 3; i++) await relayer.relay((await makeSigned({ nonce: BigInt(i + 1) })).b64);
  assert.equal(s.calls.provider.viewBlock, 1);
  t = 1500;
  await relayer.relay((await makeSigned({ nonce: 50n })).b64);
  assert.equal(s.calls.provider.viewBlock, 2);
  const s2 = setup();
  let fail = true;
  s2.provider.viewBlock = async () => { if (fail) throw new Error('x'); return { header: { height: 1000 } }; };
  const sd = (await makeSigned({})).b64;
  assert.equal((await s2.relayer.relay(sd)).code, 'UPSTREAM_ERROR');
  fail = false;
  assert.equal((await s2.relayer.relay(sd)).ok, true);
});

test('N-M2: concurrent submissions are serialized through one queue', async () => {
  const s = setup({ capacity: 10 });
  let active = 0, maxActive = 0;
  s.relayerAccount.relayMetaTransaction = async () => {
    active++; maxActive = Math.max(maxActive, active);
    await new Promise((r) => setTimeout(r, 5));
    active--;
    return { transaction: { hash: 'H' }, status: { SuccessValue: '' } };
  };
  const bs = await Promise.all([1n, 2n, 3n, 4n].map(async (n) => (await makeSigned({ nonce: n })).b64));
  const rs = await Promise.all(bs.map((b) => s.relayer.relay(b)));
  assert.ok(rs.every((r) => r.ok));
  assert.equal(maxActive, 1);
});

test('N-M2: 20 parallel relays serialize nonces, no duplicates, one failure does not stall queue', async () => {
  const s = setup({ capacity: 30, globalCapacity: 100 });
  let active = 0;
  let maxActive = 0;
  let relayerKeyNonce = 100n;
  const recordedNonces = [];
  const assignedTxHashes = [];

  s.relayerAccount.relayMetaTransaction = async (sd) => {
    active++;
    maxActive = Math.max(maxActive, active);
    // Simulate fetching the next relayer nonce
    relayerKeyNonce++;
    const assignedNonce = relayerKeyNonce;
    recordedNonces.push(assignedNonce);
    await new Promise((r) => setTimeout(r, 4));
    active--;
    if (assignedNonce === 110n) {
      throw new Error('Simulated transient RPC broadcast failure on tx 10');
    }
    const txHash = `TX_NONCE_${assignedNonce}`;
    assignedTxHashes.push(txHash);
    return { transaction: { hash: txHash }, status: { SuccessValue: '' } };
  };

  const delegates = await Promise.all(
    Array.from({ length: 20 }, (_, i) => makeSigned({ nonce: BigInt(i + 10) }))
  );
  const results = await Promise.all(delegates.map((d) => s.relayer.relay(d.b64)));

  assert.equal(maxActive, 1, 'Broadcasting must be strictly serialized (maxActive === 1)');
  assert.equal(recordedNonces.length, 20, 'All 20 attempts reached RPC');
  assert.equal(new Set(recordedNonces).size, 20, 'Every transaction must get a unique nonce (no collisions)');

  const succeeded = results.filter((r) => r.ok);
  const failed = results.filter((r) => !r.ok);
  assert.equal(succeeded.length, 19, '19 transactions must succeed');
  assert.equal(failed.length, 1, 'Exactly 1 transaction failed');
  assert.equal(failed[0].code, 'RELAY_FAILED', 'Failed transaction returns RELAY_FAILED');

  // Verify that failure on tx 10 did not stall tx 11..20
  const afterFailure = results.slice(10);
  assert.ok(afterFailure.every((r) => r.ok), 'Transactions after the failed task must succeed without stalling');
});

test('N-M2: serial queue rejects with BUSY when max queue length is reached and recovers', async () => {
  const q = createSerialQueue(2);
  let finished = 0;
  const runTask = (ms) => q.run(async () => {
    await new Promise((r) => setTimeout(r, ms));
    finished++;
    return finished;
  });

  const p1 = runTask(20);
  const p2 = runTask(20);

  // 3rd task exceeds maxLength = 2
  await assert.rejects(
    async () => { await q.run(async () => 'overflow'); },
    (err) => err.code === 'BUSY'
  );

  assert.equal(await p1, 1);
  assert.equal(await p2, 2);

  // Once drained, queue accepts new work again
  const p3 = await q.run(async () => 'recovered');
  assert.equal(p3, 'recovered');
});

test('N-M2: relayer rejects with BUSY when queue limit is reached, refunds tokens and dedupe', async () => {
  const s = setup({ capacity: 20 });
  const smallQueueRelayer = mk({
    provider: s.provider,
    relayerAccount: s.relayerAccount,
    policy: s.policy,
    limiter: s.limiter,
    globalLimiter: s.globalLimiter,
    maxQueueLength: 2,
  });

  s.relayerAccount.relayMetaTransaction = async () => {
    await new Promise((r) => setTimeout(r, 25));
    return { transaction: { hash: 'HASH_SLOW' }, status: { SuccessValue: '' } };
  };

  const bs = await Promise.all([1n, 2n, 3n, 4n].map(async (n) => (await makeSigned({ nonce: n })).b64));
  const results = await Promise.all(bs.map((b) => smallQueueRelayer.relay(b)));

  const busyResults = results.filter((r) => r.code === 'BUSY');
  assert.ok(busyResults.length >= 1, 'At least one request should be rejected as BUSY');
  assert.ok(results.some((r) => r.ok), 'At least one request should succeed');
});

test('serial queue survives a failing task', async () => {
  const q = createSerialQueue();
  await assert.rejects(q.run(async () => { throw new Error('a'); }));
  assert.equal(await q.run(async () => 7), 7);
});

test('N-M2: failure before broadcast refunds agent and global token and allows retry', async () => {
  const s = setup({ capacity: 1 });
  let n = 0;
  s.relayerAccount.relayMetaTransaction = async () => { if (n++ === 0) throw new Error('InvalidNonce'); return { transaction: { hash: 'H2' }, status: {} }; };
  const b = (await makeSigned({})).b64;
  assert.equal((await s.relayer.relay(b)).code, 'RELAY_FAILED');
  const r = await s.relayer.relay(b); // same delegate, token was refunded, dedupe entry cleared
  assert.deepEqual([r.ok, r.txHash], [true, 'H2']);
});

test('N-M2: timeout after broadcast is RELAY_PENDING, keeps token and blocks re-submit', async () => {
  const s = setup({ capacity: 5 });
  s.relayerAccount.relayMetaTransaction = async () => { throw Object.assign(new Error('request timed out'), { name: 'TimeoutError' }); };
  const b = (await makeSigned({})).b64;
  assert.equal((await s.relayer.relay(b)).code, 'RELAY_PENDING');
  assert.equal((await s.relayer.relay(b)).code, 'DUPLICATE_DELEGATE');
  assert.equal(s.calls.submit.length, 0);
});

test('N-L2: replay of a relayed delegate short-circuits with no RPC, token or gas', async () => {
  const s = setup({ capacity: 5 });
  const b = (await makeSigned({})).b64;
  const first = await s.relayer.relay(b);
  assert.equal(first.ok, true);
  const blocks = s.calls.provider.viewBlock, keys = s.calls.provider.viewAccessKey;
  const r = await s.relayer.relay(b);
  assert.deepEqual([r.ok, r.code, r.txHash], [false, 'DUPLICATE_DELEGATE', 'HASH1']);
  assert.equal(s.calls.submit.length, 1);
  assert.equal(s.calls.provider.viewBlock, blocks);
  assert.equal(s.calls.provider.viewAccessKey, keys);
});

test('N-L2: parallel identical requests submit once; dedupe store is bounded and pruned', async () => {
  const s = setup({ capacity: 5 });
  const b = (await makeSigned({})).b64;
  const rs = await Promise.all([s.relayer.relay(b), s.relayer.relay(b), s.relayer.relay(b)]);
  assert.equal(rs.filter((r) => r.ok).length, 1);
  assert.equal(s.calls.submit.length, 1);
  const relayer = mk({ provider: s.provider, relayerAccount: s.relayerAccount, policy: s.policy, limiter: createRateLimiter({ capacity: 99, refillPerSecond: 1, now: () => 0 }), dedupeMax: 2 });
  const bs = await Promise.all([11n, 12n, 13n].map(async (n) => (await makeSigned({ nonce: n })).b64));
  for (const x of bs) assert.equal((await relayer.relay(x)).ok, true);
  assert.equal((await relayer.relay(bs[0])).ok, true); // oldest evicted (bounded), so it is relayed again
  assert.equal((await relayer.relay(bs[2])).code, 'DUPLICATE_DELEGATE');
});

test('N3-M2: getTxStatus with hanging RPC times out and returns UPSTREAM_ERROR', async () => {
  const policy = loadPolicy(basePolicy);
  const hangingProvider = {
    ...fakeProvider(),
    viewTransactionStatusWithReceipts: () => new Promise(() => {}), // never resolves
  };
  const relayer = makeRelayer({
    provider: hangingProvider,
    relayerAccount: { accountId: 'relayer.testnet' },
    policy,
    limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    keyVerifier: createKeyVerifier({ provider: hangingProvider, policy }),
    rpcTimeoutMs: 50,
  });

  relayer.store.set('delegate_hash_1', 1000n, 'TX_HANGING', 'PENDING');

  const start = Date.now();
  const res = await relayer.getTxStatus('TX_HANGING');
  const elapsed = Date.now() - start;

  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPSTREAM_ERROR');
  assert.ok(elapsed >= 40 && elapsed < 500, `elapsed ${elapsed}ms should be around 50ms`);
});

test('N3-M2: getTxStatus with hanging txStatus times out and returns UPSTREAM_ERROR', async () => {
  const policy = loadPolicy(basePolicy);
  const hangingProvider = {
    txStatus: () => new Promise(() => {}),
  };
  const relayer = makeRelayer({
    provider: hangingProvider,
    relayerAccount: { accountId: 'relayer.testnet' },
    policy,
    limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    keyVerifier: createKeyVerifier({ provider: hangingProvider, policy }),
    rpcTimeoutMs: 50,
  });

  relayer.store.set('delegate_hash_2', 1000n, 'TX_HANGING_2', 'PENDING');

  const start = Date.now();
  const res = await relayer.getTxStatus('TX_HANGING_2');
  const elapsed = Date.now() - start;

  assert.equal(res.ok, false);
  assert.equal(res.code, 'UPSTREAM_ERROR');
  assert.ok(elapsed >= 40 && elapsed < 500, `elapsed ${elapsed}ms should be around 50ms`);
});

test('N3-M1: getTxStatus for unknown hash returns TX_NOT_FOUND without calling RPC', async () => {
  let rpcCalled = false;
  const provider = {
    ...fakeProvider(),
    viewTransactionStatusWithReceipts: async () => {
      rpcCalled = true;
      return { status: { SuccessValue: '' } };
    },
    txStatus: async () => {
      rpcCalled = true;
      return { status: { SuccessValue: '' } };
    },
  };
  const policy = loadPolicy(basePolicy);
  const relayer = makeRelayer({
    provider,
    relayerAccount: { accountId: 'relayer.testnet' },
    policy,
    limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    keyVerifier: createKeyVerifier({ provider, policy }),
  });

  const res = await relayer.getTxStatus('UNKNOWN_HASH_123');
  assert.equal(res.ok, false);
  assert.equal(res.code, 'TX_NOT_FOUND');
  assert.equal(rpcCalled, false, 'RPC provider must NOT be called for unknown txHash');
});



