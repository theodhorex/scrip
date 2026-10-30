// F-A: Persistent deduplication (node:sqlite) + pending reconciliation (GET /status/:hash).
import test from 'node:test';
import assert from 'node:assert/strict';
import { rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { loadPolicy } from '../src/policy.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';
import { makeRelayer } from '../src/relay.mjs';
import { createKeyVerifier } from '../src/keycheck.mjs';
import { createServer } from '../src/server.mjs';
import { basePolicy, makeSigned, fakeProvider } from './helpers.mjs';

function mkDbPath(name) {
  return join(tmpdir(), `amanat-test-${name}-${Date.now()}-${Math.random().toString(36).slice(2)}.db`);
}

test('F-A: replay dedupe survives restart with persistent sqlite db', async () => {
  const dbPath = mkDbPath('restart');
  const policy = loadPolicy(basePolicy);
  const provider = fakeProvider();
  const relayerAccount = {
    accountId: 'relayer.testnet',
    relayMetaTransaction: async () => ({
      transaction: { hash: 'HASH_PERSIST_1' },
      status: { SuccessValue: '' },
      receipts_outcome: [{ outcome: { logs: ['EVENT_JSON:{"standard":"amanat","version":"1.0.0","event":"settled","data":[]}'] } }],
    }),
  };

  try {
    // Instance 1: relay delegate
    const r1 = makeRelayer({
      provider,
      relayerAccount,
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      keyVerifier: createKeyVerifier({ provider, policy }),
      dbPath,
    });

    const b = (await makeSigned({ nonce: 5n })).b64;
    const res1 = await r1.relay(b);
    assert.equal(res1.ok, true);
    assert.equal(res1.txHash, 'HASH_PERSIST_1');
    r1.store.close();

    // Instance 2 (simulated restart): same dbPath, new relayer
    const r2 = makeRelayer({
      provider,
      relayerAccount,
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      keyVerifier: createKeyVerifier({ provider, policy }),
      dbPath,
    });

    // Submitting the same delegate after restart must be rejected as DUPLICATE_DELEGATE
    const res2 = await r2.relay(b);
    assert.equal(res2.ok, false);
    assert.equal(res2.code, 'DUPLICATE_DELEGATE');
    assert.equal(res2.txHash, 'HASH_PERSIST_1');
    r2.store.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch {}
  }
});

test('F-A: GET /status/:hash reconciles chain status for pending tx', async () => {
  const dbPath = mkDbPath('status');
  const policy = loadPolicy(basePolicy);
  let statusCall = null;
  const provider = {
    ...fakeProvider(),
    viewTransactionStatusWithReceipts: async (args) => {
      statusCall = args;
      return {
        transaction: { hash: args.txHash },
        status: { SuccessValue: '' },
        receipts_outcome: [{ outcome: { logs: ['EVENT_JSON:{"standard":"amanat","version":"1.0.0","event":"settled","data":[]}'] } }],
      };
    },
  };

  const relayerAccount = {
    accountId: 'relayer.testnet',
    relayMetaTransaction: async () => {
      const err = new Error('connection reset');
      err.code = 'ECONNRESET';
      throw err;
    },
  };

  try {
    const relayer = makeRelayer({
      provider,
      relayerAccount,
      policy,
      limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
      keyVerifier: createKeyVerifier({ provider, policy }),
      dbPath,
    });

    // Seed pending tx in dedupe store for reconciliation
    relayer.store.set('dh_pending_1', 1000n, 'SOME_TX_HASH', 'PENDING');

    // Query status on chain
    const st = await relayer.getTxStatus('SOME_TX_HASH');
    assert.equal(st.ok, true);
    assert.equal(st.status, 'FINAL');
    assert.equal(st.inner_status, 'Settled');
    assert.equal(statusCall?.txHash, 'SOME_TX_HASH');
    assert.equal(statusCall?.waitUntil, 'FINAL');
    relayer.store.close();
  } finally {
    try { rmSync(dbPath, { force: true }); } catch {}
  }
});

test('F-A: HTTP GET /status/:hash returns 200 with inner_status', async () => {
  const dbPath = mkDbPath('http-status');
  const policy = loadPolicy(basePolicy);
  const provider = {
    ...fakeProvider(),
    viewTransactionStatusWithReceipts: async ({ txHash }) => ({
      transaction: { hash: txHash },
      status: { SuccessValue: '' },
      receipts_outcome: [{ outcome: { logs: ['AMANAT_ERR:OVER_BUDGET'] } }],
    }),
  };

  const relayerAccount = {
    accountId: 'relayer.testnet',
    relayMetaTransaction: async () => ({ transaction: { hash: 'H1' }, status: { SuccessValue: '' } }),
  };

  const relayer = makeRelayer({
    provider,
    relayerAccount,
    policy,
    limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    keyVerifier: createKeyVerifier({ provider, policy }),
    dbPath,
  });

  relayer.store.set('dh_pending_2', 1000n, 'TEST_HASH_REJECTED', 'PENDING');
  const server = createServer({ relayer });

  try {
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const res = await fetch(`http://127.0.0.1:${port}/status/TEST_HASH_REJECTED`);
    assert.equal(res.status, 200);
    const json = await res.json();
    assert.equal(json.ok, true);
    assert.equal(json.inner_status, 'Rejected');
    assert.equal(json.inner_code, 'OVER_BUDGET');

    const resNotFound = await fetch(`http://127.0.0.1:${port}/status/`);
    assert.equal(resNotFound.status, 400); // Empty hash
  } finally {
    server.close();
    relayer.store.close();
    try { rmSync(dbPath, { force: true }); } catch {}
  }
});
