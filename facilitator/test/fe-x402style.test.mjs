// F-E: x402-style facilitator endpoints (GET /supported, POST /verify, POST /settle).
// Source: https://github.com/x402-foundation/x402/blob/2aa22d3e6a38547a8232737599d9f519c9ac5533/specs/schemes/exact/scheme_exact_near.md
// Source: https://docs.x402.org/core-concepts/facilitator
import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../src/policy.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';
import { makeRelayer } from '../src/relay.mjs';
import { createKeyVerifier } from '../src/keycheck.mjs';
import { createServer } from '../src/server.mjs';
import { CONTRACT, AGENT, basePolicy, makeSigned, fakeProvider } from './helpers.mjs';

function makeEnv({
  height = 1000,
  keyNonce = 0n,
  outcomeLogs = [
    'EVENT_JSON:{"standard":"amanat","version":"1.0.0","event":"reserved","data":[{"mandate_id":1,"recipient":"bob.testnet","amount":"200000"}]}',
    'EVENT_JSON:{"standard":"amanat","version":"1.0.0","event":"settled","data":[{"mandate_id":1,"recipient":"bob.testnet","amount":"200000"}]}',
  ],
  onRelay,
  mandate = { id: 1, token: 'usdc.testnet' },
  onCallFunction,
} = {}) {
  const policy = loadPolicy(basePolicy);
  const calls = { broadcast: 0, viewBlock: 0, viewAccessKey: 0, callFunction: 0 };
  const base = fakeProvider({ height, mandate, onCallFunction });
  const provider = {
    ...base,
    viewBlock: async (args) => {
      calls.viewBlock++;
      return base.viewBlock(args);
    },
    viewAccessKey: async (args) => {
      calls.viewAccessKey++;
      const r = await base.viewAccessKey(args);
      return { ...r, nonce: keyNonce };
    },
    callFunction: async (args) => {
      calls.callFunction++;
      return base.callFunction(args);
    },
  };
  const relayerAccount = {
    accountId: 'relayer.testnet',
    relayMetaTransaction: async (sd) => {
      calls.broadcast++;
      if (onRelay) return onRelay(sd);
      return {
        transaction: { hash: `TX_FE_${calls.broadcast}` },
        status: { SuccessValue: '' },
        receipts_outcome: [{ outcome: { logs: outcomeLogs, status: { SuccessValue: '' } } }],
      };
    },
  };
  const limiter = createRateLimiter({ capacity: 20, refillPerSecond: 1 });
  const globalLimiter = createRateLimiter({ capacity: 50, refillPerSecond: 1 });
  const keyVerifier = createKeyVerifier({ provider, policy });
  const logs = [];
  const relayer = makeRelayer({
    provider,
    relayerAccount,
    policy,
    limiter,
    globalLimiter,
    keyVerifier,
  });
  const server = createServer({
    relayer,
    ipLimiter: createRateLimiter({ capacity: 100, refillPerSecond: 10 }),
    log: (e) => logs.push(e),
  });
  return { server, relayer, calls, logs, policy };
}

async function withEnv(opts, fn) {
  const env = makeEnv(opts);
  await new Promise((r) => env.server.listen(0, '127.0.0.1', r));
  const baseUrl = `http://127.0.0.1:${env.server.address().port}`;
  try {
    await fn(baseUrl, env);
  } finally {
    env.server.closeAllConnections();
    await new Promise((r) => env.server.close(r));
  }
}

test('F-E: GET /supported returns x402Version 2 amanat scheme on near:testnet and 405 on POST', async () => {
  await withEnv({}, async (baseUrl) => {
    const res = await fetch(`${baseUrl}/supported`);
    assert.equal(res.status, 200);
    assert.equal(res.headers.get('x-content-type-options'), 'nosniff');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.ok(Array.isArray(body.kinds));
    assert.equal(body.kinds.length, 1);
    assert.deepEqual(body.kinds[0], {
      x402Version: 2,
      scheme: 'amanat',
      network: 'near:testnet',
      extra: {
        contractId: CONTRACT,
        allowedMethods: ['request_payment'],
      },
    });

    const badMethod = await fetch(`${baseUrl}/supported`, { method: 'POST' });
    assert.equal(badMethod.status, 405);
    assert.equal(badMethod.headers.get('allow'), 'GET');
  });
});

function mkPaymentHeader(signedDelegateBase64, paymentRequirements, extraTop = {}) {
  const payload = {
    x402Version: 2,
    scheme: 'amanat',
    network: 'near:testnet',
    payload: { signedDelegateAction: signedDelegateBase64 },
    paymentRequirements,
    ...extraTop,
  };
  return Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');
}

const DEFAULT_REQS = Object.freeze({
  payTo: 'bob.testnet',
  amount: '200000',
  asset: 'usdc.testnet',
  mandate: 1,
});

async function makePaymentDelegate({
  mandateId = 1,
  recipient = 'bob.testnet',
  amount = '200000',
  reqNonce = 1,
  delegateNonce = 7n,
  maxBlockHeight = 1050n,
  ...rest
} = {}) {
  const { actions } = await import('near-api-js');
  return makeSigned({
    nonce: delegateNonce,
    maxBlockHeight,
    actions: [
      actions.functionCall(
        'request_payment',
        { mandate_id: mandateId, recipient, amount, nonce: reqNonce },
        100_000_000_000_000n,
        0n,
      ),
    ],
    ...rest,
  });
}

test('F-E: POST /verify succeeds for valid signature + matching requirements without broadcasting', async () => {
  await withEnv({}, async (baseUrl, env) => {
    const signed = await makePaymentDelegate();
    const hdr = mkPaymentHeader(signed.b64, DEFAULT_REQS);

    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': hdr },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.isValid, true);
    assert.equal(body.payer, AGENT);
    assert.equal(body.network, 'near:testnet');
    assert.equal(body.scheme, 'amanat');
    assert.deepEqual(body.call, {
      mandate_id: '1',
      recipient: 'bob.testnet',
      amount: '200000',
      nonce: '1',
    });
    // Must NEVER broadcast on /verify
    assert.equal(env.calls.broadcast, 0);
    assert.ok(env.calls.viewAccessKey >= 1);
    // Structured log must never leak header or delegate bytes
    const logBlob = JSON.stringify(env.logs);
    assert.ok(!logBlob.includes(signed.b64));
    assert.ok(!logBlob.includes(hdr));
  });
});

test('F-E: POST /verify rejects recipient mismatch before any RPC or broadcast', async () => {
  await withEnv({}, async (baseUrl, env) => {
    const signed = await makePaymentDelegate({ recipient: 'evil.testnet' });
    const hdr = mkPaymentHeader(signed.b64, DEFAULT_REQS);

    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': hdr },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.isValid, false);
    assert.equal(body.code, 'RECIPIENT_MISMATCH');
    assert.equal(body.invalidReason, 'RECIPIENT_MISMATCH');
    assert.equal(env.calls.broadcast, 0);
    assert.equal(env.calls.viewBlock, 0);
    assert.equal(env.calls.viewAccessKey, 0);
  });
});

test('F-E: POST /verify rejects amount mismatch and mandate mismatch before any RPC', async () => {
  await withEnv({}, async (baseUrl, env) => {
    const wrongAmt = await makePaymentDelegate({ amount: '999999' });
    const res1 = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': mkPaymentHeader(wrongAmt.b64, DEFAULT_REQS) },
    });
    assert.equal(res1.status, 400);
    const b1 = await res1.json();
    assert.equal(b1.ok, false);
    assert.equal(b1.code, 'AMOUNT_MISMATCH');

    const wrongMandate = await makePaymentDelegate({ mandateId: 2 });
    const res2 = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': mkPaymentHeader(wrongMandate.b64, DEFAULT_REQS) },
    });
    assert.equal(res2.status, 400);
    const b2 = await res2.json();
    assert.equal(b2.ok, false);
    assert.equal(b2.code, 'MANDATE_MISMATCH');

    assert.equal(env.calls.broadcast, 0);
    assert.equal(env.calls.viewAccessKey, 0);
  });
});

test('F-E: POST /verify rejects forged signature (BAD_SIGNATURE) offline', async () => {
  await withEnv({}, async (baseUrl, env) => {
    const signed = await makePaymentDelegate();
    const raw = Buffer.from(signed.b64, 'base64');
    raw[raw.length - 4] ^= 0xff; // flip signature byte
    const tamperedB64 = raw.toString('base64');

    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': mkPaymentHeader(tamperedB64, DEFAULT_REQS) },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.isValid, false);
    assert.equal(body.code, 'BAD_SIGNATURE');
    assert.equal(env.calls.broadcast, 0);
    assert.equal(env.calls.viewAccessKey, 0);
  });
});

test('F-E: POST /verify rejects missing or corrupted PAYMENT-SIGNATURE header', async () => {
  await withEnv({}, async (baseUrl, env) => {
    // 1. Missing header
    const rMissing = await fetch(`${baseUrl}/verify`, { method: 'POST' });
    assert.equal(rMissing.status, 400);
    assert.equal((await rMissing.json()).code, 'MISSING_PAYMENT_SIGNATURE');

    // 2. Non-base64 garbage
    const rGarbage = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': '!!!not-base64!!!' },
    });
    assert.equal(rGarbage.status, 400);
    assert.equal((await rGarbage.json()).code, 'BAD_PAYMENT_SIGNATURE');

    // 3. Valid base64 but non-JSON
    const rBadJson = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': Buffer.from('not-json', 'utf8').toString('base64') },
    });
    assert.equal(rBadJson.status, 400);
    assert.equal((await rBadJson.json()).code, 'BAD_PAYMENT_SIGNATURE');

    // 4. Valid JSON but missing paymentRequirements
    const signed = await makePaymentDelegate();
    const rNoReqs = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: {
        'PAYMENT-SIGNATURE': Buffer.from(
          JSON.stringify({ payload: { signedDelegateAction: signed.b64 } }),
          'utf8',
        ).toString('base64'),
      },
    });
    assert.equal(rNoReqs.status, 400);
    assert.equal((await rNoReqs.json()).code, 'BAD_PAYMENT_REQUIREMENTS');

    // 5. Wrong HTTP method
    const rGet = await fetch(`${baseUrl}/verify`, { method: 'GET' });
    assert.equal(rGet.status, 405);

    assert.equal(env.calls.broadcast, 0);
  });
});

test('F-E: POST /settle broadcasts, awaits inner status, and returns PAYMENT-RESPONSE header', async () => {
  await withEnv({}, async (baseUrl, env) => {
    const signed = await makePaymentDelegate();
    const hdr = mkPaymentHeader(signed.b64, DEFAULT_REQS);

    const res = await fetch(`${baseUrl}/settle`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': hdr },
    });
    assert.equal(res.status, 200);
    const payRespRaw = res.headers.get('payment-response');
    assert.ok(payRespRaw, 'must include PAYMENT-RESPONSE header');
    const payResp = JSON.parse(Buffer.from(payRespRaw, 'base64').toString('utf8'));
    assert.equal(payResp.ok, true);
    assert.equal(payResp.success, true);
    assert.equal(payResp.tx_hash, 'TX_FE_1');
    assert.equal(payResp.inner_status, 'Settled');

    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.tx_hash, 'TX_FE_1');
    assert.equal(body.inner_status, 'Settled');
    assert.equal(body.outer_tx_succeeded, true);
    assert.equal(env.calls.broadcast, 1);
  });
});

test('F-E: POST /settle rejects recipient/amount mismatch without broadcasting', async () => {
  await withEnv({}, async (baseUrl, env) => {
    const wrongRecipient = await makePaymentDelegate({ recipient: 'evil.testnet' });
    const r1 = await fetch(`${baseUrl}/settle`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': mkPaymentHeader(wrongRecipient.b64, DEFAULT_REQS) },
    });
    assert.equal(r1.status, 400);
    assert.equal((await r1.json()).code, 'RECIPIENT_MISMATCH');

    const wrongAmt = await makePaymentDelegate({ amount: '888888' });
    const r2 = await fetch(`${baseUrl}/settle`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': mkPaymentHeader(wrongAmt.b64, DEFAULT_REQS) },
    });
    assert.equal(r2.status, 400);
    assert.equal((await r2.json()).code, 'AMOUNT_MISMATCH');

    assert.equal(env.calls.broadcast, 0);
  });
});

test('F-E: POST /settle handles inner status Rejected from contract', async () => {
  const envOpts = {
    outcomeLogs: [
      'EVENT_JSON:{"standard":"amanat","version":"1.0.0","event":"rejected","data":[{"code":"OVER_PER_PAYMENT_CAP"}]}',
      'AMANAT_ERR:OVER_PER_PAYMENT_CAP',
    ],
  };
  await withEnv(envOpts, async (baseUrl, env) => {
    const signed = await makePaymentDelegate();
    const hdr = mkPaymentHeader(signed.b64, DEFAULT_REQS);

    const res = await fetch(`${baseUrl}/settle`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': hdr },
    });
    assert.equal(res.status, 200);
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.inner_status, 'Rejected');
    assert.equal(body.inner_code, 'OVER_PER_PAYMENT_CAP');
    assert.equal(body.success, false);
    assert.equal(env.calls.broadcast, 1);
  });
});

test('F-E: POST /settle rejects missing header or wrong method', async () => {
  await withEnv({}, async (baseUrl, env) => {
    const rMissing = await fetch(`${baseUrl}/settle`, { method: 'POST' });
    assert.equal(rMissing.status, 400);
    assert.equal((await rMissing.json()).code, 'MISSING_PAYMENT_SIGNATURE');

    const rGet = await fetch(`${baseUrl}/settle`, { method: 'GET' });
    assert.equal(rGet.status, 405);
    assert.equal(env.calls.broadcast, 0);
  });
});

test('N3-I1: POST /verify rejects asset mismatch against on-chain mandate token (ASSET_MISMATCH)', async () => {
  // Mandate token on-chain is 'usdc.testnet', but paymentRequirements asks for 'weth.testnet'
  await withEnv({ mandate: { id: 1, token: 'usdc.testnet' } }, async (baseUrl, env) => {
    const signed = await makePaymentDelegate();
    const mismatchedReqs = { ...DEFAULT_REQS, asset: 'weth.testnet' };
    const hdr = mkPaymentHeader(signed.b64, mismatchedReqs);

    const res = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': hdr },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.isValid, false);
    assert.equal(body.code, 'ASSET_MISMATCH');
    assert.equal(body.invalidReason, 'ASSET_MISMATCH');
    assert.equal(env.calls.broadcast, 0);
  });
});

test('N3-I1: POST /settle rejects asset mismatch against on-chain mandate token (ASSET_MISMATCH) without broadcasting', async () => {
  await withEnv({ mandate: { id: 1, token: 'usdc.testnet' } }, async (baseUrl, env) => {
    const signed = await makePaymentDelegate();
    const mismatchedReqs = { ...DEFAULT_REQS, asset: 'weth.testnet' };
    const hdr = mkPaymentHeader(signed.b64, mismatchedReqs);

    const res = await fetch(`${baseUrl}/settle`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': hdr },
    });
    assert.equal(res.status, 400);
    const body = await res.json();
    assert.equal(body.ok, false);
    assert.equal(body.code, 'ASSET_MISMATCH');
    assert.equal(body.invalidReason, 'ASSET_MISMATCH');
    assert.equal(env.calls.broadcast, 0, 'Must NOT broadcast when asset mismatches');
  });
});

test('N3-I1: POST /verify and /settle fail-closed with MANDATE_NOT_FOUND when mandate does not exist on-chain', async () => {
  // Mandate returns null from get_mandate
  await withEnv({ mandate: null }, async (baseUrl, env) => {
    const signed = await makePaymentDelegate();
    const hdr = mkPaymentHeader(signed.b64, DEFAULT_REQS);

    const rVerify = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': hdr },
    });
    assert.equal(rVerify.status, 400);
    const bVerify = await rVerify.json();
    assert.equal(bVerify.ok, false);
    assert.equal(bVerify.isValid, false);
    assert.equal(bVerify.code, 'MANDATE_NOT_FOUND');

    const rSettle = await fetch(`${baseUrl}/settle`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': hdr },
    });
    assert.equal(rSettle.status, 400);
    const bSettle = await rSettle.json();
    assert.equal(bSettle.ok, false);
    assert.equal(bSettle.code, 'MANDATE_NOT_FOUND');
    assert.equal(env.calls.broadcast, 0);
  });
});

test('N3-I1: POST /verify and /settle fail-closed with UPSTREAM_ERROR when get_mandate RPC fails', async () => {
  await withEnv({
    onCallFunction: (args) => {
      if (args?.method === 'get_mandate') throw new Error('RPC network connection reset');
      return null;
    },
  }, async (baseUrl, env) => {
    const signed = await makePaymentDelegate();
    const hdr = mkPaymentHeader(signed.b64, DEFAULT_REQS);

    const rVerify = await fetch(`${baseUrl}/verify`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': hdr },
    });
    assert.equal(rVerify.status, 502);
    const bVerify = await rVerify.json();
    assert.equal(bVerify.ok, false);
    assert.equal(bVerify.code, 'UPSTREAM_ERROR');

    const rSettle = await fetch(`${baseUrl}/settle`, {
      method: 'POST',
      headers: { 'PAYMENT-SIGNATURE': hdr },
    });
    assert.equal(rSettle.status, 502);
    const bSettle = await rSettle.json();
    assert.equal(bSettle.ok, false);
    assert.equal(bSettle.code, 'UPSTREAM_ERROR');
    assert.equal(env.calls.broadcast, 0);
  });
});

test('N3-I1: mandate token lookup is cached briefly (get_mandate not called repeatedly)', async () => {
  await withEnv({ mandate: { id: 1, token: 'usdc.testnet' } }, async (baseUrl, env) => {
    const signed1 = await makePaymentDelegate({ reqNonce: 1 });
    const signed2 = await makePaymentDelegate({ reqNonce: 2 });
    const hdr1 = mkPaymentHeader(signed1.b64, DEFAULT_REQS);
    const hdr2 = mkPaymentHeader(signed2.b64, DEFAULT_REQS);

    const r1 = await fetch(`${baseUrl}/verify`, { method: 'POST', headers: { 'PAYMENT-SIGNATURE': hdr1 } });
    assert.equal(r1.status, 200);

    const r2 = await fetch(`${baseUrl}/verify`, { method: 'POST', headers: { 'PAYMENT-SIGNATURE': hdr2 } });
    assert.equal(r2.status, 200);

    // Both calls used the same mandate 1, so get_mandate should only be fetched once thanks to caching
    assert.equal(env.calls.callFunction, 1, 'get_mandate should be cached across requests within TTL');
  });
});
