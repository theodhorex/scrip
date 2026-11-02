// F-B: honest final results (wait for FINAL, parse inner status from EVENT_JSON and SCRIP_ERR).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../src/policy.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';
import { makeRelayer } from '../src/relay.mjs';
import { createKeyVerifier } from '../src/keycheck.mjs';
import { extractInnerStatus } from '../src/inner_status.mjs';
import { basePolicy, makeSigned, fakeProvider, goodPermission } from './helpers.mjs';

function mkOutcomeWithLogs(logs, status = { SuccessValue: '' }) {
  return {
    transaction: { hash: 'TX_HASH_FINAL' },
    status,
    receipts_outcome: [
      {
        outcome: {
          logs,
          status: { SuccessValue: '' },
        },
      },
    ],
  };
}

test('extractInnerStatus: correctly identifies Settled', () => {
  const o = mkOutcomeWithLogs([
    'EVENT_JSON:{"standard":"scrip","version":"1.0.0","event":"reserved","data":[{"mandate_id":1,"recipient":"bob.testnet","amount":"100"}]}',
    'EVENT_JSON:{"standard":"scrip","version":"1.0.0","event":"settled","data":[{"mandate_id":1,"recipient":"bob.testnet","amount":"100"}]}',
  ]);
  assert.deepEqual(extractInnerStatus(o), { inner_status: 'Settled' });
});

test('extractInnerStatus: correctly identifies Refunded', () => {
  const o = mkOutcomeWithLogs([
    'EVENT_JSON:{"standard":"scrip","version":"1.0.0","event":"reserved","data":[{"mandate_id":1,"recipient":"bob.testnet","amount":"100"}]}',
    'EVENT_JSON:{"standard":"scrip","version":"1.0.0","event":"refunded","data":[{"mandate_id":1,"recipient":"bob.testnet","amount":"100"}]}',
  ]);
  assert.deepEqual(extractInnerStatus(o), { inner_status: 'Refunded' });
});

test('extractInnerStatus: correctly identifies Rejected from EVENT_JSON', () => {
  const o = mkOutcomeWithLogs([
    'EVENT_JSON:{"standard":"scrip","version":"1.0.0","event":"rejected","data":[{"mandate_id":1,"recipient":"bob.testnet","amount":"100","code":"OVER_BUDGET"}]}',
  ]);
  assert.deepEqual(extractInnerStatus(o), { inner_status: 'Rejected', inner_code: 'OVER_BUDGET' });
});

test('extractInnerStatus: correctly identifies Rejected from SCRIP_ERR', () => {
  const o = mkOutcomeWithLogs([
    'SCRIP_ERR:RECIPIENT_NOT_ALLOWED',
  ]);
  assert.deepEqual(extractInnerStatus(o), { inner_status: 'Rejected', inner_code: 'RECIPIENT_NOT_ALLOWED' });
});

test('extractInnerStatus: correctly identifies Reserved when callback not yet finalized', () => {
  const o = mkOutcomeWithLogs([
    'EVENT_JSON:{"standard":"scrip","version":"1.0.0","event":"reserved","data":[{"mandate_id":1,"recipient":"bob.testnet","amount":"100"}]}',
  ]);
  assert.deepEqual(extractInnerStatus(o), { inner_status: 'Reserved' });
});

test('F-B: relay returns inner_status from mocked receipts', async () => {
  const policy = loadPolicy(basePolicy);
  const provider = fakeProvider();
  const limiter = createRateLimiter({ capacity: 10, refillPerSecond: 1 });
  const globalLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 1 });
  const keyVerifier = createKeyVerifier({ provider, policy });

  const outcome = mkOutcomeWithLogs([
    'EVENT_JSON:{"standard":"scrip","version":"1.0.0","event":"reserved","data":[{"mandate_id":1,"recipient":"bob.testnet","amount":"100"}]}',
    'EVENT_JSON:{"standard":"scrip","version":"1.0.0","event":"settled","data":[{"mandate_id":1,"recipient":"bob.testnet","amount":"100"}]}',
  ]);

  const relayerAccount = {
    relayMetaTransaction: async () => outcome,
  };

  const relayer = makeRelayer({
    provider,
    relayerAccount,
    policy,
    limiter,
    globalLimiter,
    keyVerifier,
  });

  const signed = await makeSigned({ nonce: 5n });
  const res = await relayer.relay(signed.b64);
  assert.equal(res.ok, true);
  assert.equal(res.txHash, 'TX_HASH_FINAL');
  assert.equal(res.inner_status, 'Settled');
});

test('F-B: relay waits for FINAL via viewTransactionStatusWithReceipts if outcome lacks receipts', async () => {
  const policy = loadPolicy(basePolicy);
  let statusCall = null;
  const provider = {
    ...fakeProvider(),
    viewTransactionStatusWithReceipts: async (args) => {
      statusCall = args;
      return mkOutcomeWithLogs([
        'SCRIP_ERR:OVER_PER_PAYMENT_CAP',
      ]);
    },
  };
  const limiter = createRateLimiter({ capacity: 10, refillPerSecond: 1 });
  const globalLimiter = createRateLimiter({ capacity: 10, refillPerSecond: 1 });
  const keyVerifier = createKeyVerifier({ provider, policy });

  const relayerAccount = {
    accountId: 'relayer.testnet',
    relayMetaTransaction: async () => ({
      transaction: { hash: 'HASH_OPT' },
      status: { SuccessValue: '' },
    }),
  };

  const relayer = makeRelayer({
    provider,
    relayerAccount,
    policy,
    limiter,
    globalLimiter,
    keyVerifier,
  });

  const signed = await makeSigned({ nonce: 5n });
  const res = await relayer.relay(signed.b64);
  assert.equal(res.ok, true);
  assert.equal(res.txHash, 'HASH_OPT');
  assert.equal(statusCall?.waitUntil, 'FINAL');
  assert.equal(res.inner_status, 'Rejected');
  assert.equal(res.inner_code, 'OVER_PER_PAYMENT_CAP');
});
