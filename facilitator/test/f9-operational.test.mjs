// F9 Step 2: Operational resilience tests (~25+ cases).
// Covers IP limiter flooding, /status random hashes, low relayer balance,
// RPC slow/down/garbage/truncated, persistent dedupe replay across restart,
// and queue resilience on failing jobs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createServer } from '../src/server.mjs';
import { makeRelayer } from '../src/relay.mjs';
import { makeSigned, basePolicy, fakeProvider, goodPermission } from './helpers.mjs';
import { loadPolicy } from '../src/policy.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';

const policy = loadPolicy(basePolicy);

async function withServer(relayer, fn, serverOpts = {}) {
  const server = createServer({ relayer, ...serverOpts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, server);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

const postJson = (url, body, headers = {}) =>
  fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json', ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  });

test('F9 Step 2: Operational - Flood per IP (limiter)', async (t) => {
  const ipLimiter = createRateLimiter({ capacity: 3, refillPerSecond: 0.1 });
  const provider = fakeProvider();
  const relayer = makeRelayer({
    provider,
    relayerAccount: { accountId: 'relayer.testnet' },
    policy,
    limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
  });

  await withServer(relayer, async (base) => {
    const { b64 } = await makeSigned();

    await t.test('single IP bursts up to capacity (3 requests allowed)', async () => {
      for (let i = 0; i < 3; i++) {
        const res = await postJson(`${base}/relay`, { signed_delegate: b64 });
        assert.notEqual(res.status, 429, `Req ${i} should not be IP rate limited`);
      }
    });

    await t.test('single IP exceeds capacity on /relay -> 429 IP_RATE_LIMITED + Retry-After', async () => {
      const res = await postJson(`${base}/relay`, { signed_delegate: b64 });
      assert.equal(res.status, 429);
      const json = await res.json();
      assert.equal(json.code, 'IP_RATE_LIMITED');
      assert.ok(Number(res.headers.get('retry-after')) >= 1);
    });

    await t.test('single IP exceeds capacity on /verify -> 429 IP_RATE_LIMITED', async () => {
      const res = await postJson(`${base}/verify`, {}, { 'payment-signature': 'AAAA' });
      assert.equal(res.status, 429);
      const json = await res.json();
      assert.equal(json.code, 'IP_RATE_LIMITED');
    });

    await t.test('single IP exceeds capacity on /settle -> 429 IP_RATE_LIMITED', async () => {
      const res = await postJson(`${base}/settle`, {}, { 'payment-signature': 'AAAA' });
      assert.equal(res.status, 429);
      const json = await res.json();
      assert.equal(json.code, 'IP_RATE_LIMITED');
    });

    await t.test('single IP exceeds capacity on /status/:hash -> 429 IP_RATE_LIMITED', async () => {
      const res = await fetch(`${base}/status/anyhash`);
      assert.equal(res.status, 429);
      const json = await res.json();
      assert.equal(json.code, 'IP_RATE_LIMITED');
    });

    await t.test('independent IP via X-Forwarded-For with trustProxy allowed when IP1 is blocked', async () => {
      const proxyLimiter = createRateLimiter({ capacity: 2, refillPerSecond: 0.1 });
      const proxyServer = createServer({
        relayer,
        ipLimiter: proxyLimiter,
        trustProxy: true,
      });
      await new Promise((r) => proxyServer.listen(0, '127.0.0.1', r));
      const pbase = `http://127.0.0.1:${proxyServer.address().port}`;
      try {
        // IP 1 fills bucket
        await postJson(`${pbase}/relay`, { signed_delegate: b64 }, { 'x-forwarded-for': '192.168.1.100' });
        await postJson(`${pbase}/relay`, { signed_delegate: b64 }, { 'x-forwarded-for': '192.168.1.100' });
        const blocked = await postJson(`${pbase}/relay`, { signed_delegate: b64 }, { 'x-forwarded-for': '192.168.1.100' });
        assert.equal(blocked.status, 429);

        // IP 2 is distinct, should not be blocked
        const fresh = await postJson(`${pbase}/relay`, { signed_delegate: b64 }, { 'x-forwarded-for': '192.168.1.200' });
        assert.notEqual(fresh.status, 429);
      } finally {
        proxyServer.closeAllConnections();
        await new Promise((r) => proxyServer.close(r));
      }
    });

    await t.test('IP limiter bucket refills over time', async () => {
      let tNow = 1000;
      const stepLimiter = createRateLimiter({ capacity: 1, refillPerSecond: 1, now: () => tNow });
      assert.equal(stepLimiter.tryTake('test-ip').allowed, true);
      assert.equal(stepLimiter.tryTake('test-ip').allowed, false);
      tNow += 1050; // After 1s, bucket refills
      assert.equal(stepLimiter.tryTake('test-ip').allowed, true);
    });
  }, { ipLimiter });
});

test('F9 Step 2: Operational - Random tx hash to /status', async (t) => {
  const provider = fakeProvider();
  let rpcCalls = 0;
  provider.viewTransactionStatusWithReceipts = async () => {
    rpcCalls++;
    return null;
  };
  provider.txStatus = async () => {
    rpcCalls++;
    return null;
  };

  const relayer = makeRelayer({
    provider,
    relayerAccount: { accountId: 'relayer.testnet' },
    policy,
    limiter: createRateLimiter({ capacity: 50, refillPerSecond: 10 }),
  });

  await withServer(relayer, async (base) => {
    await t.test('random base58 hash -> 404 TX_NOT_FOUND without touching RPC', async () => {
      const beforeCalls = rpcCalls;
      const res = await fetch(`${base}/status/9xQeWvG816bUx9EPjHmaT23yvVM2ZWbrrpZb9PusVFin`);
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.code, 'TX_NOT_FOUND');
      assert.equal(rpcCalls, beforeCalls, 'Must make zero RPC calls for unknown hash');
    });

    await t.test('random arbitrary string hash -> 404 TX_NOT_FOUND without touching RPC', async () => {
      const beforeCalls = rpcCalls;
      const res = await fetch(`${base}/status/not-a-real-hash-123456789`);
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.code, 'TX_NOT_FOUND');
      assert.equal(rpcCalls, beforeCalls);
    });

    await t.test('SQL injection attempt in hash parameter -> 404 TX_NOT_FOUND safely', async () => {
      const res = await fetch(`${base}/status/%27%20OR%201=1--`);
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.code, 'TX_NOT_FOUND');
    });

    await t.test('1000-character long hash string -> 404 TX_NOT_FOUND without crash', async () => {
      const longHash = 'A'.repeat(1000);
      const res = await fetch(`${base}/status/${longHash}`);
      assert.equal(res.status, 404);
      const json = await res.json();
      assert.equal(json.code, 'TX_NOT_FOUND');
    });

    await t.test('registered PENDING hash reconciles from local store', async () => {
      relayer.store.set('delegate_hash_1', 1100n, 'tx_pending_1', 'PENDING');
      const res = await fetch(`${base}/status/tx_pending_1`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.ok, true);
      assert.equal(json.status, 'PENDING');
    });

    await t.test('on-chain FINAL status returned when outcome present', async () => {
      relayer.store.set('delegate_hash_2', 1100n, 'tx_final_1', 'PENDING');
      provider.viewTransactionStatusWithReceipts = async () => ({
        status: { SuccessValue: '' },
        receipts_outcome: [{ outcome: { logs: ['EVENT_JSON:{"standard":"scrip","version":"1.0.0","event":"settled","data":[{"request_nonce":1,"amount":"1"}]}'] } }],
      });
      const res = await fetch(`${base}/status/tx_final_1`);
      assert.equal(res.status, 200);
      const json = await res.json();
      assert.equal(json.status, 'FINAL');
      assert.equal(json.inner_status, 'Settled');
    });

    await t.test('on-chain Failure outcome maps to 502 TX_FAILED', async () => {
      relayer.store.set('delegate_hash_3', 1100n, 'tx_failed_1', 'PENDING');
      provider.viewTransactionStatusWithReceipts = async () => ({
        status: { Failure: { ActionError: {} } },
        receipts_outcome: [],
      });
      const res = await fetch(`${base}/status/tx_failed_1`);
      assert.equal(res.status, 502);
      const json = await res.json();
      assert.equal(json.code, 'TX_FAILED');
    });
  });
});

test('F9 Step 2: Operational - Low relayer balance', async (t) => {
  const minBalance = 1_000_000_000_000_000_000_000_000n; // 1 NEAR
  let currentBalance = 500_000_000_000_000_000_000_000n; // 0.5 NEAR (low)
  let balanceLookups = 0;
  let submitCalls = 0;

  const provider = fakeProvider();
  const limiter = createRateLimiter({ capacity: 10, refillPerSecond: 1 });
  const relayer = makeRelayer({
    provider,
    relayerAccount: {
      accountId: 'relayer.testnet',
      relayMetaTransaction: async () => {
        submitCalls++;
        return { transaction: { hash: 'tx123' }, receipts_outcome: [] };
      },
    },
    policy,
    limiter,
    minBalance,
    relayerBalance: async () => {
      balanceLookups++;
      return currentBalance;
    },
  });

  const { b64 } = await makeSigned();

  await t.test('balance below minBalance is rejected with RELAYER_LOW_BALANCE and no submit', async () => {
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'RELAYER_LOW_BALANCE');
    assert.equal(submitCalls, 0, 'Must not submit when balance is low');
    // limiter tokens should not be deducted (bucket not even touched)
    assert.equal(limiter.size(), 0);
  });

  await t.test('balance exactly equal to minBalance is rejected (<= minBalance)', async () => {
    currentBalance = minBalance;
    const { b64: b64_2 } = await makeSigned({ nonce: 8n });
    const res = await relayer.relay(b64_2);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'RELAYER_LOW_BALANCE');
    assert.equal(submitCalls, 0);
  });

  await t.test('balance lookup failure maps to UPSTREAM_ERROR without broadcasting', async () => {
    let nowTime = 1000;
    const failingRelayer = makeRelayer({
      provider,
      relayerAccount: {
        accountId: 'relayer.testnet',
        relayMetaTransaction: async () => { submitCalls++; return {}; },
      },
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      minBalance,
      relayerBalance: async () => { throw new Error('RPC balance failure'); },
      now: () => nowTime,
    });
    const { b64: b64_err } = await makeSigned({ nonce: 9n });
    const res = await failingRelayer.relay(b64_err);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'UPSTREAM_ERROR');
    assert.equal(submitCalls, 0);
  });

  await t.test('balance cache refreshes after BAL_TTL_MS and allows relay when funded', async () => {
    let simTime = 10_000;
    const fundedRelayer = makeRelayer({
      provider,
      relayerAccount: {
        accountId: 'relayer.testnet',
        relayMetaTransaction: async () => ({ transaction: { hash: 'tx_funded_1' }, receipts_outcome: [] }),
      },
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      minBalance,
      relayerBalance: async () => currentBalance,
      now: () => simTime,
    });

    currentBalance = 100n; // low
    const { b64: b1 } = await makeSigned({ nonce: 10n });
    const r1 = await fundedRelayer.relay(b1);
    assert.equal(r1.code, 'RELAYER_LOW_BALANCE');

    // Fund the account and advance time beyond 1000ms TTL
    currentBalance = 10_000_000_000_000_000_000_000_000n; // 10 NEAR
    simTime += 1500;

    const { b64: b2 } = await makeSigned({ nonce: 11n });
    const r2 = await fundedRelayer.relay(b2);
    assert.equal(r2.ok, true);
    assert.equal(r2.txHash, 'tx_funded_1');
  });
});

test('F9 Step 2: Operational - RPC slow, dead, returns garbage, truncated', async (t) => {
  await t.test('RPC viewBlock times out -> UPSTREAM_ERROR', async () => {
    const hangProvider = {
      ...fakeProvider(),
      viewBlock: () => new Promise(() => {}), // never resolves
    };
    const r = makeRelayer({
      provider: hangProvider,
      relayerAccount: { accountId: 'relayer.testnet' },
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      rpcTimeoutMs: 20,
    });
    const { b64 } = await makeSigned();
    const res = await r.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'UPSTREAM_ERROR');
  });

  await t.test('RPC viewBlock returns malformed header/garbage -> UPSTREAM_ERROR', async () => {
    const garbageProvider = {
      ...fakeProvider(),
      viewBlock: async () => ({ header: { height: 'garbage_not_int' } }),
    };
    const r = makeRelayer({
      provider: garbageProvider,
      relayerAccount: { accountId: 'relayer.testnet' },
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    });
    const { b64 } = await makeSigned();
    const res = await r.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'UPSTREAM_ERROR');
  });

  for (const [label, height] of [['null', null], ['negative', -10], ['zero', 0], ['numeric string', '1000'], ['float', 1000.5], ['missing', undefined]]) {
    await t.test(`RPC viewBlock height ${label} is not an honest final height -> UPSTREAM_ERROR`, async () => {
      const r = makeRelayer({
        provider: { ...fakeProvider(), viewBlock: async () => ({ header: { height } }) },
        relayerAccount: { accountId: 'relayer.testnet' },
        policy,
        limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      });
      const { b64 } = await makeSigned();
      const res = await r.relay(b64);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'UPSTREAM_ERROR');
    });
  }

  await t.test('RPC viewAccessKey times out -> UPSTREAM_ERROR', async () => {
    const hangKeyProvider = {
      ...fakeProvider(),
      viewAccessKey: () => new Promise(() => {}),
    };
    const r = makeRelayer({
      provider: hangKeyProvider,
      relayerAccount: { accountId: 'relayer.testnet' },
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      rpcTimeoutMs: 20,
    });
    const { b64 } = await makeSigned();
    const res = await r.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'UPSTREAM_ERROR');
  });

  await t.test('RPC viewAccessKey socket hangup error -> UPSTREAM_ERROR', async () => {
    const netErrProvider = {
      ...fakeProvider(),
      viewAccessKey: async () => {
        const err = new Error('socket hang up');
        err.code = 'ECONNRESET';
        throw err;
      },
    };
    const r = makeRelayer({
      provider: netErrProvider,
      relayerAccount: { accountId: 'relayer.testnet' },
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    });
    const { b64 } = await makeSigned();
    const res = await r.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'UPSTREAM_ERROR');
  });

  await t.test('RPC broadcast timeout triggers RELAY_PENDING (token kept, dedupe kept)', async () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001 });
    const r = makeRelayer({
      provider: fakeProvider(),
      relayerAccount: {
        accountId: 'relayer.testnet',
        relayMetaTransaction: () => new Promise(() => {}),
      },
      policy,
      limiter,
      rpcTimeoutMs: 20,
    });
    const { b64 } = await makeSigned();
    const res = await r.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'RELAY_PENDING');
    // Token must remain spent because tx may have landed
    assert.equal(limiter.tryTake(policy.allowedAgents[0]).allowed, false);
    // Re-submission immediately hits DUPLICATE_DELEGATE
    const res2 = await r.relay(b64);
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'DUPLICATE_DELEGATE');
  });

  await t.test('RPC broadcast abort/econnreset triggers RELAY_PENDING', async () => {
    const r = makeRelayer({
      provider: fakeProvider(),
      relayerAccount: {
        accountId: 'relayer.testnet',
        relayMetaTransaction: async () => {
          const err = new Error('ECONNRESET');
          err.code = 'ECONNRESET';
          throw err;
        },
      },
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    });
    const { b64 } = await makeSigned();
    const res = await r.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'RELAY_PENDING');
  });

  await t.test('RPC broadcast fatal error refunds token and allows retry (RELAY_FAILED)', async () => {
    const limiter = createRateLimiter({ capacity: 1, refillPerSecond: 0.001 });
    let attempts = 0;
    const r = makeRelayer({
      provider: fakeProvider(),
      relayerAccount: {
        accountId: 'relayer.testnet',
        relayMetaTransaction: async () => {
          attempts++;
          if (attempts === 1) throw new Error('Invalid nonce or rejected');
          return { transaction: { hash: 'tx_retry_ok' }, receipts_outcome: [] };
        },
      },
      policy,
      limiter,
    });
    const { b64 } = await makeSigned();
    const r1 = await r.relay(b64);
    assert.equal(r1.ok, false);
    assert.equal(r1.code, 'RELAY_FAILED');
    // Token refunded: bucket should have 1 token available again
    assert.equal(limiter.tryTake(policy.allowedAgents[0]).allowed, true);
    // Refund it so retry can take it
    limiter.refund(policy.allowedAgents[0]);
    // Dedupe removed, retry of same delegate allowed
    const r2 = await r.relay(b64);
    assert.equal(r2.ok, true);
    assert.equal(r2.txHash, 'tx_retry_ok');
  });

  await t.test('RPC get_mandate corrupted JSON or failure -> UPSTREAM_ERROR', async () => {
    const corruptMandateProvider = {
      ...fakeProvider(),
      callFunction: async () => { throw new Error('truncated JSON'); },
    };
    const r = makeRelayer({
      provider: corruptMandateProvider,
      relayerAccount: { accountId: 'relayer.testnet' },
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    });
    const res = await r.checkMandateAsset(1, 'usdc.testnet');
    assert.equal(res.ok, false);
    assert.equal(res.code, 'UPSTREAM_ERROR');
  });
});

test('F9 Step 2: Operational - Replay after restart (persistent dedupe)', async (t) => {
  const tmpDir = mkdtempSync(join(tmpdir(), 'f9-dedupe-'));
  const dbPath = join(tmpDir, 'test-persistent.db');

  try {
    const { b64 } = await makeSigned();

    await t.test('initial relay succeeds and persists to sqlite db', async () => {
      const r1 = makeRelayer({
        provider: fakeProvider(),
        relayerAccount: {
          accountId: 'relayer.testnet',
          relayMetaTransaction: async () => ({ transaction: { hash: 'tx_persisted_1' }, receipts_outcome: [] }),
        },
        policy,
        limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
        dbPath,
      });
      const res = await r1.relay(b64);
      assert.equal(res.ok, true);
      assert.equal(res.txHash, 'tx_persisted_1');
      r1.store.close();
    });

    await t.test('after relayer restart, same delegate is rejected as DUPLICATE_DELEGATE offline', async () => {
      let rpcAttempted = false;
      const r2 = makeRelayer({
        provider: {
          ...fakeProvider(),
          viewBlock: async () => { rpcAttempted = true; return { header: { height: 1000 } }; },
        },
        relayerAccount: {
          accountId: 'relayer.testnet',
          relayMetaTransaction: async () => { rpcAttempted = true; return {}; },
        },
        policy,
        limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
        dbPath,
      });

      const res = await r2.relay(b64);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'DUPLICATE_DELEGATE');
      assert.equal(res.txHash, 'tx_persisted_1');
      assert.equal(rpcAttempted, false, 'Dedupe replay check must run offline before any RPC call');
      r2.store.close();
    });

    await t.test('new fresh delegate is accepted after restart', async () => {
      const r3 = makeRelayer({
        provider: fakeProvider(),
        relayerAccount: {
          accountId: 'relayer.testnet',
          relayMetaTransaction: async () => ({ transaction: { hash: 'tx_persisted_2' }, receipts_outcome: [] }),
        },
        policy,
        limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
        dbPath,
      });
      const { b64: freshB64 } = await makeSigned({ nonce: 99n });
      const res = await r3.relay(freshB64);
      assert.equal(res.ok, true);
      assert.equal(res.txHash, 'tx_persisted_2');
      r3.store.close();
    });
  } finally {
    rmSync(tmpDir, { recursive: true, force: true });
  }
});

test('F9 Step 2: Operational - Failed relay job does not stall queue', async (t) => {
  let submitCount = 0;
  const r = makeRelayer({
    provider: fakeProvider(),
    relayerAccount: {
      accountId: 'relayer.testnet',
      relayMetaTransaction: async () => {
        submitCount++;
        if (submitCount === 1) throw new Error('Fatal error on task 1');
        return { transaction: { hash: `tx_${submitCount}` }, receipts_outcome: [] };
      },
    },
    policy,
    limiter: createRateLimiter({ capacity: 50, refillPerSecond: 10 }),
    maxQueueLength: 10,
  });

  const { b64: b1 } = await makeSigned({ nonce: 101n });
  const { b64: b2 } = await makeSigned({ nonce: 102n });
  const { b64: b3 } = await makeSigned({ nonce: 103n });

  // Launch parallel submissions
  const [res1, res2, res3] = await Promise.all([
    r.relay(b1),
    r.relay(b2),
    r.relay(b3),
  ]);

  assert.equal(res1.ok, false, 'First relay should fail');
  assert.equal(res1.code, 'RELAY_FAILED');
  assert.equal(res2.ok, true, 'Second relay should succeed without stalling');
  assert.equal(res3.ok, true, 'Third relay should succeed without stalling');
});
