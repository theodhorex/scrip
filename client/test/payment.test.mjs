// C-A: Tests for buildPaymentSignature and parsePaymentResponse with fixed vectors.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { buildPaymentSignature, parsePaymentResponse } from '../src/index.mjs';
import { parsePaymentSignatureHeader, validateSignedDelegate } from '../../facilitator/src/validate.mjs';
import { loadPolicy } from '../../facilitator/src/policy.mjs';
import { basePolicy } from '../../facilitator/test/helpers.mjs';

// Fixed, made-up key pair for deterministic vector tests only. It is not derived from a seed and
// controls no account or funds.
const TEST_KEY = KeyPair.fromString('ed25519:2wy9q8uUbNV8ob41pL9Gf7Lz7kR2PzWkQk3vV5z5M8rBqYvR2wy9q8uUbNV8ob41pL9Gf7Lz7kR2PzWkQk3vV5z5M8rB');
const AGENT = 'agent.testnet';
const CONTRACT = 'amanat.testnet';

const FIXED_REQUIREMENTS = Object.freeze({
  payTo: 'merchant.testnet',
  amount: '500000',
  asset: 'usdc.testnet',
  mandate: 1,
  maxTimeoutSeconds: 60,
});

test('C-A: buildPaymentSignature builds canonical x402 v2 payment header accepted by facilitator', async () => {
  const sig = await buildPaymentSignature(FIXED_REQUIREMENTS, {
    agentId: AGENT,
    contractId: CONTRACT,
    keyPair: TEST_KEY,
    nonce: 10n,
    maxBlockHeight: 1000n,
    requestNonce: 42n,
  });

  assert.ok(sig, 'must return signature');
  const b64 = String(sig);
  assert.equal(sig.base64, b64);
  assert.equal(sig.header, b64);

  // Validate with facilitator parser
  const parsed = parsePaymentSignatureHeader(b64);
  assert.equal(parsed.ok, true, `facilitator failed to parse header: ${parsed.code}`);
  assert.equal(parsed.requirements.payTo, 'merchant.testnet');
  assert.equal(parsed.requirements.amount, '500000');
  assert.equal(parsed.requirements.asset, 'usdc.testnet');
  assert.equal(parsed.requirements.expectedMandateId, 1n);

  // Validate delegate action
  const policy = loadPolicy({
    ...basePolicy,
    contractId: CONTRACT,
    allowedAgents: [AGENT],
  });
  const val = validateSignedDelegate(parsed.signedDelegateBase64, policy);
  assert.equal(val.ok, true, `delegate validation failed: ${val.code}`);
  assert.equal(val.agentId, AGENT);
  assert.equal(val.call.mandateId, 1n);
  assert.equal(val.call.recipient, 'merchant.testnet');
  assert.equal(val.call.amount, '500000');
  assert.equal(val.call.nonce, 42n);
});

test('C-A: buildPaymentSignature rejects invalid requirements or missing credentials', async () => {
  await assert.rejects(
    () => buildPaymentSignature(null, { agentId: AGENT, keyPair: TEST_KEY, nonce: 1n, maxBlockHeight: 100n }),
    /requirements must be an object/,
  );

  await assert.rejects(
    () => buildPaymentSignature({ ...FIXED_REQUIREMENTS, payTo: '' }, { agentId: AGENT, keyPair: TEST_KEY, nonce: 1n, maxBlockHeight: 100n }),
    /payTo/,
  );

  await assert.rejects(
    () => buildPaymentSignature({ ...FIXED_REQUIREMENTS, amount: 'not-a-number' }, { agentId: AGENT, keyPair: TEST_KEY, nonce: 1n, maxBlockHeight: 100n }),
    /amount/,
  );

  await assert.rejects(
    () => buildPaymentSignature(FIXED_REQUIREMENTS, { agentId: '', keyPair: TEST_KEY, nonce: 1n, maxBlockHeight: 100n }),
    /agentId/,
  );

  await assert.rejects(
    () => buildPaymentSignature(FIXED_REQUIREMENTS, { agentId: AGENT, keyPair: null, nonce: 1n, maxBlockHeight: 100n }),
    /keyPair/,
  );
});

test('C-A: parsePaymentResponse parses header string, JSON string, and response objects', () => {
  const successObj = {
    ok: true,
    success: true,
    tx_hash: 'TX_SUCCESS_123',
    inner_status: 'Settled',
    outer_tx_succeeded: true,
  };
  const b64Hdr = Buffer.from(JSON.stringify(successObj), 'utf8').toString('base64');

  // 1. Base64 header string
  const r1 = parsePaymentResponse(b64Hdr);
  assert.equal(r1.ok, true);
  assert.equal(r1.success, true);
  assert.equal(r1.txHash, 'TX_SUCCESS_123');
  assert.equal(r1.inner_status, 'Settled');

  // 2. JSON string
  const r2 = parsePaymentResponse(JSON.stringify(successObj));
  assert.equal(r2.ok, true);
  assert.equal(r2.txHash, 'TX_SUCCESS_123');

  // 3. Response-like object with headers
  const mockResponse = {
    status: 200,
    headers: {
      get: (name) => (name.toLowerCase() === 'payment-response' ? b64Hdr : null),
    },
    body: successObj,
  };
  const r3 = parsePaymentResponse(mockResponse);
  assert.equal(r3.ok, true);
  assert.equal(r3.txHash, 'TX_SUCCESS_123');
  assert.equal(r3.inner_status, 'Settled');

  // 4. Failure response with inner_status: Rejected
  const rejObj = {
    ok: true,
    success: false,
    tx_hash: 'TX_FAIL_456',
    inner_status: 'Rejected',
    inner_code: 'OVER_PER_PAYMENT_CAP',
  };
  const r4 = parsePaymentResponse(rejObj);
  assert.equal(r4.ok, true);
  assert.equal(r4.success, false);
  assert.equal(r4.inner_status, 'Rejected');
  assert.equal(r4.inner_code, 'OVER_PER_PAYMENT_CAP');

  // 5. Error response (status 400 with code)
  const errObj = { status: 400, body: { ok: false, code: 'RECIPIENT_MISMATCH' } };
  const r5 = parsePaymentResponse(errObj);
  assert.equal(r5.ok, false);
  assert.equal(r5.code, 'RECIPIENT_MISMATCH');

  // 6. Invalid input throws RangeError/TypeError
  assert.throws(() => parsePaymentResponse('!!!not-valid-base64-or-json!!!'), /invalid/i);
});

test('C-A: buildPaymentSignature negative vectors for amounts, recipients, mandates', async () => {
  const badAmounts = ['10.5', '-100', '0123', ' 100 ', 'notadollar', '', '340282366920938463463374607431768211456'];
  for (const amount of badAmounts) {
    await assert.rejects(
      () => buildPaymentSignature({ ...FIXED_REQUIREMENTS, amount }, { agentId: AGENT, keyPair: TEST_KEY, nonce: 1n, maxBlockHeight: 100n }),
      /amount/i,
      `amount ${amount} should be rejected`,
    );
  }

  const badRecipients = ['UPPERCASE.testnet', 'has space.testnet', '', 'a'.repeat(65)];
  for (const payTo of badRecipients) {
    await assert.rejects(
      () => buildPaymentSignature({ ...FIXED_REQUIREMENTS, payTo }, { agentId: AGENT, keyPair: TEST_KEY, nonce: 1n, maxBlockHeight: 100n }),
      /recipient|payTo/i,
      `recipient ${payTo} should be rejected`,
    );
  }

  const badMandates = [-1, 'invalid', null, undefined, 18446744073709551616n];
  for (const mandate of badMandates) {
    await assert.rejects(
      () => buildPaymentSignature({ ...FIXED_REQUIREMENTS, mandate }, { agentId: AGENT, keyPair: TEST_KEY, nonce: 1n, maxBlockHeight: 100n }),
      /mandate/i,
      `mandate ${mandate} should be rejected`,
    );
  }
});

test('C-A: parsePaymentResponse handles x402 standard errorReason and transaction field', () => {
  const r1 = parsePaymentResponse({
    success: false,
    errorReason: 'delegate_action_expired',
    transaction: null,
  });
  assert.equal(r1.ok, false);
  assert.equal(r1.success, false);
  assert.equal(r1.code, 'delegate_action_expired');
  assert.equal(r1.txHash, null);

  const r2 = parsePaymentResponse({
    ok: true,
    transaction: 'TX_NEAR_X402_1',
    payer: 'alice.testnet',
    inner_status: 'Settled',
  });
  assert.equal(r2.ok, true);
  assert.equal(r2.success, true);
  assert.equal(r2.txHash, 'TX_NEAR_X402_1');
  assert.equal(r2.payer, 'alice.testnet');
});

test('N3-M3: parsePaymentResponse accepts status string (e.g. FINAL) without treating it as HTTP error', () => {
  const resp = { ok: true, status: 'FINAL', inner_status: 'Settled', tx_hash: 'TX_FINAL_123' };
  const res = parsePaymentResponse(resp);
  assert.equal(res.ok, true);
  assert.equal(res.success, true);
  assert.equal(res.inner_status, 'Settled');
  assert.equal(res.txHash, 'TX_FINAL_123');
});

test('N3-L1: parsePaymentResponse decodes unpadded alphanumeric base64url (e.g. eyJhIjoxfQ)', () => {
  // eyJhIjoxfQ is base64url for {"a":1}
  const r = parsePaymentResponse('eyJhIjoxfQ');
  assert.equal(r.raw.a, 1);
});


