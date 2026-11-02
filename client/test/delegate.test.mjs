import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { KeyPair, PublicKey, KeyType, actions, encodeDelegateAction } from 'near-api-js';
import {
  buildRequestPayment, signDelegate, relayBodyFor, classifyRelayResponse, parseRequestResult,
  REJECT_CODES, MIN_GAS, DEFAULT_GAS, RELAY_ERROR_CODES,
} from '../src/delegate.mjs';
import { validateSignedDelegate, decodeSignedDelegate } from '../../facilitator/src/validate.mjs';
import { loadPolicy } from '../../facilitator/src/policy.mjs';

const CONTRACT = 'scrip.testnet';
const AGENT = 'agent1.testnet';
const TGAS = 10n ** 12n;
const policy = loadPolicy({
  network: 'testnet', contractId: CONTRACT, allowedMethods: ['request_payment'], allowedAgents: [AGENT],
  maxGas: String(150n * TGAS), maxBlockHeightWindow: 200, minBlockHeightMargin: 5,
  rateLimit: { capacity: 3, refillPerSecond: 1 },
});
const ctx = { currentBlockHeight: 1000 };
const req = { contractId: CONTRACT, mandateId: 3, recipient: 'bob.testnet', amount: '1500', nonce: 9 };

async function signed(action = buildRequestPayment(req), o = {}) {
  const keyPair = o.keyPair ?? KeyPair.fromRandom('ed25519');
  const r = await signDelegate({
    agentId: AGENT, contractId: o.contractId ?? CONTRACT, action, nonce: 7n, maxBlockHeight: 1050n, keyPair,
  });
  return { ...r, keyPair };
}

test('buildRequestPayment: function call, zero deposit, default 100 Tgas, exact args', () => {
  const a = buildRequestPayment(req);
  const fc = a.functionCall;
  assert.equal(fc.methodName, 'request_payment');
  assert.equal(fc.deposit, 0n);
  assert.equal(fc.gas, 100n * TGAS);
  assert.equal(DEFAULT_GAS, 100n * TGAS);
  assert.equal(MIN_GAS, 60n * TGAS);
  assert.deepEqual(JSON.parse(Buffer.from(fc.args).toString()),
    { mandate_id: 3, recipient: 'bob.testnet', amount: '1500', nonce: 9 });
});

test('buildRequestPayment: u64 values above 2^53 keep full precision', () => {
  const a = buildRequestPayment({ ...req, mandateId: 2n ** 64n - 1n, nonce: 2n ** 63n });
  const s = Buffer.from(a.functionCall.args).toString();
  assert.match(s, /"mandate_id":18446744073709551615,/);
  assert.match(s, /"nonce":9223372036854775808\}/);
});

test('buildRequestPayment: gas below 60 Tgas refused, 60 Tgas accepted', () => {
  assert.throws(() => buildRequestPayment({ ...req, gas: 59n * TGAS }), /at least 60 Tgas/);
  assert.throws(() => buildRequestPayment({ ...req, gas: 60n * TGAS - 1n }), RangeError);
  assert.equal(buildRequestPayment({ ...req, gas: 60n * TGAS }).functionCall.gas, 60n * TGAS);
  assert.throws(() => buildRequestPayment({ ...req, gas: 60 }), TypeError);
});

test('buildRequestPayment: validates inputs', () => {
  assert.throws(() => buildRequestPayment({ ...req, amount: '01' }), RangeError);
  assert.throws(() => buildRequestPayment({ ...req, amount: 5 }), TypeError);
  assert.throws(() => buildRequestPayment({ ...req, amount: (2n ** 128n).toString() }), RangeError);
  assert.equal(buildRequestPayment({ ...req, amount: (2n ** 128n - 1n).toString() }).functionCall.args.length > 0, true);
  assert.throws(() => buildRequestPayment({ ...req, nonce: -1 }), RangeError);
  assert.throws(() => buildRequestPayment({ ...req, nonce: 2n ** 64n }), RangeError);
  assert.throws(() => buildRequestPayment({ ...req, mandateId: 1.5 }), TypeError);
  assert.throws(() => buildRequestPayment({ ...req, recipient: 'Bob' }), RangeError);
  assert.throws(() => buildRequestPayment({ ...req, contractId: '' }), RangeError);
  assert.throws(() => buildRequestPayment(null), TypeError);
});

test('signDelegate: ed25519 signature verifies against the public key', async () => {
  const { signedDelegate, keyPair } = await signed();
  const da = signedDelegate.delegateAction;
  const hash = new Uint8Array(createHash('sha256').update(encodeDelegateAction(da)).digest());
  const pk = new PublicKey({ keyType: KeyType.ED25519, data: Uint8Array.from(da.publicKey.ed25519Key.data) });
  assert.equal(pk.toString(), keyPair.getPublicKey().toString());
  assert.equal(pk.verify(hash, Uint8Array.from(signedDelegate.signature.ed25519Signature.data)), true);
  const bad = hash.slice(); bad[0] ^= 1;
  assert.equal(pk.verify(bad, Uint8Array.from(signedDelegate.signature.ed25519Signature.data)), false);
});

test('signDelegate: base64 accepted by the facilitator validateSignedDelegate', async () => {
  const { base64 } = await signed();
  const r = validateSignedDelegate(base64, policy, ctx);
  assert.equal(r.ok, true, r.code);
  assert.equal(r.agentId, AGENT);
  assert.equal(r.method, 'request_payment');
  const sd = decodeSignedDelegate(base64);
  assert.equal(sd.delegateAction.nonce, 7n);
  assert.equal(sd.delegateAction.maxBlockHeight, 1050n);
});

test('signDelegate: rejects bad arguments', async () => {
  const keyPair = KeyPair.fromRandom('ed25519');
  const action = buildRequestPayment(req);
  const base = { agentId: AGENT, contractId: CONTRACT, action, nonce: 7n, maxBlockHeight: 1050n, keyPair };
  await assert.rejects(signDelegate({ ...base, agentId: '' }), RangeError);
  await assert.rejects(signDelegate({ ...base, nonce: -1n }), RangeError);
  await assert.rejects(signDelegate({ ...base, maxBlockHeight: 'x' }), TypeError);
  await assert.rejects(signDelegate({ ...base, keyPair: null }), TypeError);
  await assert.rejects(signDelegate({ ...base, action: null }), TypeError);
});

test('facilitator rejects deposit != 0, wrong method, wrong receiver, tampered bytes', async () => {
  const dep = await signed(actions.functionCall('request_payment', {}, DEFAULT_GAS, 1n));
  assert.equal(validateSignedDelegate(dep.base64, policy, ctx).code, 'DEPOSIT_NOT_ZERO');
  const meth = await signed(actions.functionCall('withdraw', {}, DEFAULT_GAS, 0n));
  assert.equal(validateSignedDelegate(meth.base64, policy, ctx).code, 'METHOD_NOT_ALLOWED');
  const recv = await signed(buildRequestPayment(req), { contractId: 'other.testnet' });
  assert.equal(validateSignedDelegate(recv.base64, policy, ctx).code, 'WRONG_RECEIVER');

  const ok = await signed();
  const bytes = Buffer.from(ok.base64, 'base64');
  bytes[bytes.length - 5] ^= 0xff; // inside the signature
  assert.equal(validateSignedDelegate(bytes.toString('base64'), policy, ctx).code, 'BAD_SIGNATURE');
  const mid = Buffer.from(ok.base64, 'base64');
  mid[30] ^= 0x01; // inside the delegate action body
  assert.notEqual(validateSignedDelegate(mid.toString('base64'), policy, ctx).ok, true);
  assert.equal(validateSignedDelegate(ok.base64 + 'AA', policy, ctx).code, 'BAD_ENCODING');
});

test('relayBodyFor: exact JSON body, validates base64', () => {
  assert.equal(relayBodyFor('AAAA'), '{"signed_delegate":"AAAA"}');
  assert.throws(() => relayBodyFor(''), TypeError);
  assert.throws(() => relayBodyFor('not base64!'), RangeError);
  assert.throws(() => relayBodyFor(5), TypeError);
});

test('classifyRelayResponse: success and every facilitator error code', () => {
  assert.deepEqual(classifyRelayResponse({ status: 200, body: { ok: true, tx_hash: 'H' } }),
    { ok: true, retryable: false, code: null, retryAfterSeconds: null, txHash: 'H' });
  const permanent = ['BAD_ENCODING', 'AGENT_NOT_ALLOWED', 'WRONG_RECEIVER', 'WRONG_ACTION_COUNT', 'NOT_FUNCTION_CALL',
    'METHOD_NOT_ALLOWED', 'DEPOSIT_NOT_ZERO', 'GAS_TOO_HIGH', 'EXPIRES_TOO_SOON', 'EXPIRES_TOO_FAR', 'NONCE_INVALID',
    'BAD_SIGNATURE', 'BAD_JSON', 'BAD_REQUEST', 'GAS_TOO_LOW', 'KEY_NOT_ALLOWED'];
  for (const code of permanent) {
    const r = classifyRelayResponse({ status: 400, body: { ok: false, code } });
    assert.deepEqual(r, { ok: false, retryable: false, code, retryAfterSeconds: null, txHash: null }, code);
  }
  const rl = classifyRelayResponse({ status: 429, body: { ok: false, code: 'RATE_LIMITED' }, retryAfter: '3' });
  assert.deepEqual([rl.ok, rl.retryable, rl.code, rl.retryAfterSeconds], [false, true, 'RATE_LIMITED', 3]);
  assert.equal(classifyRelayResponse({ status: 429, body: { code: 'RATE_LIMITED' } }).retryAfterSeconds, null);
  for (const code of ['UPSTREAM_ERROR', 'RELAY_FAILED']) {
    const r = classifyRelayResponse({ status: 502, body: { ok: false, code } });
    assert.deepEqual([r.ok, r.retryable, r.code], [false, true, code]);
  }
  // TX_FAILED: submitted but failed on chain; do not blindly resubmit.
  assert.equal(classifyRelayResponse({ status: 502, body: { ok: false, code: 'TX_FAILED' } }).retryable, false);
  // every documented code is covered
  const covered = new Set([...permanent, 'RATE_LIMITED', 'UPSTREAM_ERROR', 'RELAY_FAILED', 'TX_FAILED', 'IP_RATE_LIMITED', 'DUPLICATE_DELEGATE', 'SERVER_BUSY', 'RELAY_PENDING']);
  assert.deepEqual([...covered].sort(), [...RELAY_ERROR_CODES].sort());
});

test('classifyRelayResponse: transport-level statuses and unknown shapes', () => {
  assert.deepEqual(classifyRelayResponse({ status: 413, body: null }).code, 'BAD_REQUEST');
  assert.equal(classifyRelayResponse({ status: 413, body: null }).retryable, false);
  assert.equal(classifyRelayResponse({ status: 415, body: null }).code, 'BAD_REQUEST');
  assert.equal(classifyRelayResponse({ status: 503, body: null }).retryable, true);
  assert.equal(classifyRelayResponse({ status: 400, body: { ok: false, code: 'WEIRD' } }).retryable, false);
  assert.equal(classifyRelayResponse({ status: 200, body: { ok: false } }).ok, false);
  assert.throws(() => classifyRelayResponse({}), TypeError);
});

test('parseRequestResult: every PaymentResult shape, JSON string or base64', () => {
  const b64 = (o) => Buffer.from(JSON.stringify(o)).toString('base64');
  assert.deepEqual(parseRequestResult(b64({ Reserved: { request_id: 4 } })), { kind: 'Reserved', requestId: 4n, code: null });
  assert.deepEqual(parseRequestResult(JSON.stringify({ Settled: { request_id: 5 } })), { kind: 'Settled', requestId: 5n, code: null });
  assert.deepEqual(parseRequestResult(JSON.stringify({ Refunded: { request_id: 6 } })), { kind: 'Refunded', requestId: 6n, code: null });
  assert.deepEqual(parseRequestResult(b64({ AlreadyResolved: { request_id: 7 } })), { kind: 'AlreadyResolved', requestId: 7n, code: null });
  assert.deepEqual(parseRequestResult(b64({ Rejected: { code: 'OVER_BUDGET' } })), { kind: 'Rejected', requestId: null, code: 'OVER_BUDGET' });
  assert.equal(parseRequestResult('{"Reserved":{"request_id":18446744073709551615}}').requestId, 18446744073709551615n);
});

test('parseRequestResult: malformed input throws', () => {
  for (const bad of ['', 'zzz', '{}', '[]', '{"Nope":{}}', '{"Reserved":{}}', '{"Reserved":{"request_id":-1}}',
    '{"Rejected":{"code":"MADE_UP"}}', '{"Rejected":{}}', '{"Reserved":{"request_id":1},"Settled":{"request_id":1}}', '"Reserved"']) {
    assert.throws(() => parseRequestResult(bad), /PaymentResult|unknown|invalid/i, bad);
  }
  assert.throws(() => parseRequestResult(null), TypeError);
});

test('REJECT_CODES matches contract RejectCode and is frozen', () => {
  assert.deepEqual([...REJECT_CODES], ['NOT_ACTIVE', 'EXPIRED', 'RECIPIENT_NOT_ALLOWED', 'OVER_PER_PAYMENT_CAP',
    'TOO_MANY_OPEN', 'OVER_BUDGET', 'NEEDS_APPROVAL', 'APPROVAL_USED', 'APPROVAL_EXPIRED']);
  assert.equal(Object.isFrozen(REJECT_CODES), true);
  assert.equal(Object.isFrozen(RELAY_ERROR_CODES), true);
});

test('classifyRelayResponse: new facilitator codes', () => {
  const c = (status, code, retryAfter) => classifyRelayResponse({ status, body: { ok: false, code }, retryAfter });
  assert.deepEqual([c(429, 'IP_RATE_LIMITED', '3').retryable, c(429, 'IP_RATE_LIMITED', '3').retryAfterSeconds], [true, 3]);
  assert.equal(c(503, 'SERVER_BUSY').retryable, true);
  assert.equal(c(409, 'DUPLICATE_DELEGATE').retryable, false);
  assert.equal(c(504, 'RELAY_PENDING').retryable, false);
});
