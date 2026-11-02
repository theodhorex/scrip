// F-D: operational tests (timeout, request_id, JSON logs without secrets, /metrics, security headers, key eviction).
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../src/policy.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';
import { makeRelayer } from '../src/relay.mjs';
import { createKeyVerifier } from '../src/keycheck.mjs';
import { createServer } from '../src/server.mjs';
import { basePolicy, makeSigned, fakeProvider, goodPermission } from './helpers.mjs';

test('F-D: request_id is propagated or generated, and security headers are present', async () => {
  const policy = loadPolicy(basePolicy);
  const provider = fakeProvider();
  const relayer = makeRelayer({
    provider,
    relayerAccount: { relayMetaTransaction: async () => ({ transaction: { hash: 'H' }, status: { SuccessValue: '' } }) },
    policy,
    limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    keyVerifier: createKeyVerifier({ provider, policy }),
  });

  const server = createServer({ relayer });
  try {
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    // Custom x-request-id
    const res1 = await fetch(`http://127.0.0.1:${port}/health`, {
      headers: { 'x-request-id': 'custom-req-id-123' },
    });
    assert.equal(res1.status, 200);
    assert.equal(res1.headers.get('x-request-id'), 'custom-req-id-123');
    assert.equal(res1.headers.get('x-content-type-options'), 'nosniff');
    assert.equal(res1.headers.get('x-frame-options'), 'DENY');
    assert.ok(res1.headers.get('content-security-policy'));
    assert.ok(res1.headers.get('strict-transport-security'));

    // Generated x-request-id
    const res2 = await fetch(`http://127.0.0.1:${port}/health`);
    assert.ok(res2.headers.get('x-request-id'));
    assert.notEqual(res2.headers.get('x-request-id'), '');
  } finally {
    server.close();
  }
});

test('F-D: /metrics returns count per code in text and json format', async () => {
  const policy = loadPolicy(basePolicy);
  const provider = fakeProvider();
  const relayer = makeRelayer({
    provider,
    relayerAccount: { relayMetaTransaction: async () => ({ transaction: { hash: 'H' }, status: { SuccessValue: '' } }) },
    policy,
    limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    keyVerifier: createKeyVerifier({ provider, policy }),
  });

  const server = createServer({ relayer });
  try {
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    await fetch(`http://127.0.0.1:${port}/health`);

    // Plain text / prometheus format
    const resText = await fetch(`http://127.0.0.1:${port}/metrics`);
    assert.equal(resText.status, 200);
    const text = await resText.text();
    assert.ok(text.includes('facilitator_requests_total'));

    // JSON format
    const resJson = await fetch(`http://127.0.0.1:${port}/metrics`, {
      headers: { accept: 'application/json' },
    });
    assert.equal(resJson.status, 200);
    const json = await resJson.json();
    assert.equal(json.ok, true);
    assert.ok(typeof json.metrics === 'object');
  } finally {
    server.close();
  }
});

test('F-D: log JSON contains structured fields and request_id without body secrets', async () => {
  const logs = [];
  const policy = loadPolicy(basePolicy);
  const provider = fakeProvider();
  const relayer = makeRelayer({
    provider,
    relayerAccount: { relayMetaTransaction: async () => ({ transaction: { hash: 'TX_H' }, status: { SuccessValue: '' } }) },
    policy,
    limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    keyVerifier: createKeyVerifier({ provider, policy }),
  });

  const server = createServer({
    relayer,
    log: (entry) => logs.push(entry),
  });

  try {
    await new Promise((resolve) => server.listen(0, resolve));
    const port = server.address().port;

    const signed = await makeSigned({ nonce: 5n });
    await fetch(`http://127.0.0.1:${port}/relay`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-request-id': 'req-999' },
      body: JSON.stringify({ signed_delegate: signed.b64 }),
    });

    assert.equal(logs.length, 1);
    const entry = logs[0];
    assert.equal(entry.request_id, 'req-999');
    assert.equal(entry.path, '/relay');
    assert.equal(entry.code, 'OK');
    assert.equal(entry.tx, 'TX_H');
    // Ensure no raw delegate or secrets leaked
    assert.equal(entry.signed_delegate, undefined);
    assert.equal(entry.body, undefined);
  } finally {
    server.close();
  }
});

test('F-D: RPC timeout on broadcast triggers RELAY_PENDING', async () => {
  const policy = loadPolicy(basePolicy);
  const provider = fakeProvider();
  const relayerAccount = {
    accountId: 'relayer.testnet',
    relayMetaTransaction: async () => {
      // Hangs longer than rpcTimeoutMs
      await new Promise((r) => setTimeout(r, 100));
      return { transaction: { hash: 'H_TIMEOUT' }, status: { SuccessValue: '' } };
    },
  };

  const relayer = makeRelayer({
    provider,
    relayerAccount,
    policy,
    limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    keyVerifier: createKeyVerifier({ provider, policy }),
    rpcTimeoutMs: 20, // 20ms timeout
  });

  const signed = await makeSigned({ nonce: 5n });
  const res = await relayer.relay(signed.b64);
  assert.equal(res.ok, false);
  assert.equal(res.code, 'RELAY_PENDING');
});

test('F-D: evict revoked key drops positive cache', async () => {
  const policy = loadPolicy(basePolicy);
  const provider = fakeProvider();
  const keyVerifier = createKeyVerifier({ provider, policy });

  const signed = await makeSigned({ nonce: 5n });
  // Pre-populate keyVerifier cache
  await keyVerifier.check(signed.signedDelegate.delegateAction.senderId, signed.signedDelegate.delegateAction.publicKey);
  assert.equal(keyVerifier.sizes().pos, 1);

  // Outcome with SCRIP_ERR:REVOKED
  const outcome = {
    transaction: { hash: 'TX_REV' },
    status: { SuccessValue: '' },
    receipts_outcome: [{ outcome: { logs: ['SCRIP_ERR:REVOKED'] } }],
  };

  const relayer = makeRelayer({
    provider,
    relayerAccount: { relayMetaTransaction: async () => outcome },
    policy,
    limiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    globalLimiter: createRateLimiter({ capacity: 10, refillPerSecond: 1 }),
    keyVerifier,
  });

  await relayer.relay(signed.b64);
  // Key must be evicted from pos cache!
  assert.equal(keyVerifier.sizes().pos, 0);
});
