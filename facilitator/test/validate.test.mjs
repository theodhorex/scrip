import test from 'node:test';
import assert from 'node:assert/strict';
import { actions, KeyPair, encodeTransaction, createTransaction } from 'near-api-js';
import { loadPolicy } from '../src/policy.mjs';
import { validateSignedDelegate, parsePaymentSignatureHeader } from '../src/validate.mjs';
import { basePolicy, makeSigned, AGENT, CONTRACT } from './helpers.mjs';

const policy = loadPolicy(basePolicy);
const ctx = { currentBlockHeight: 1000 };
const check = async (o, pol = policy, c = ctx) => validateSignedDelegate((await makeSigned(o)).b64, pol, c);
const code = async (o, pol, c) => (await check(o, pol, c)).code;

test('happy path returns agentId and method', async () => {
  const r = await check({});
  assert.equal(r.ok, true);
  assert.equal(r.agentId, AGENT);
  assert.equal(r.method, 'request_payment');
});

test('BAD_ENCODING', async () => {
  for (const bad of ['', '***not base64***', 'AAAA', 42, null, Buffer.from('hello world').toString('base64')]) {
    assert.equal(validateSignedDelegate(bad, policy, ctx).code, 'BAD_ENCODING', String(bad));
  }
  const { b64 } = await makeSigned({});
  assert.equal(validateSignedDelegate(b64 + 'AAAA', policy, ctx).code, 'BAD_ENCODING'); // trailing bytes
});

test('AGENT_NOT_ALLOWED', async () => {
  const p = loadPolicy({ ...basePolicy, allowedAgents: ['other.testnet'] });
  assert.equal(await code({}, p), 'AGENT_NOT_ALLOWED');
  assert.equal(await code({ senderId: 'agent.near' }), 'AGENT_NOT_ALLOWED');
  const ok = loadPolicy({ ...basePolicy, allowedAgents: [AGENT] });
  assert.equal((await check({}, ok)).ok, true);
});

test('WRONG_RECEIVER', async () => assert.equal(await code({ receiverId: 'evil.testnet' }), 'WRONG_RECEIVER'));

test('WRONG_ACTION_COUNT', async () => {
  const fc = () => actions.functionCall('request_payment', {}, 1n, 0n);
  assert.equal(await code({ actions: [] }), 'WRONG_ACTION_COUNT');
  assert.equal(await code({ actions: [fc(), fc()] }), 'WRONG_ACTION_COUNT');
});

test('NOT_FUNCTION_CALL', async () => assert.equal(await code({ actions: [actions.transfer(1n)] }), 'NOT_FUNCTION_CALL'));
test('METHOD_NOT_ALLOWED', async () => assert.equal(await code({ method: 'other' }), 'METHOD_NOT_ALLOWED'));
test('DEPOSIT_NOT_ZERO', async () => assert.equal(await code({ deposit: 1n }), 'DEPOSIT_NOT_ZERO'));

test('GAS_TOO_HIGH (boundary ok)', async () => {
  assert.equal(await code({ gas: 100_000_000_000_001n }), 'GAS_TOO_HIGH');
  assert.equal((await check({ gas: 100_000_000_000_000n })).ok, true);
  assert.equal(await code({ gas: 59_999_999_999_999n }), 'GAS_TOO_LOW');
  assert.equal((await check({ gas: 60_000_000_000_000n })).ok, true);
});

test('EXPIRES_TOO_SOON / EXPIRES_TOO_FAR with boundaries', async () => {
  assert.equal(await code({ maxBlockHeight: 1004n }), 'EXPIRES_TOO_SOON');
  assert.equal((await check({ maxBlockHeight: 1005n })).ok, true);
  assert.equal((await check({ maxBlockHeight: 1200n })).ok, true);
  assert.equal(await code({ maxBlockHeight: 1201n }), 'EXPIRES_TOO_FAR');
  assert.equal(await code({ maxBlockHeight: 10n }), 'EXPIRES_TOO_SOON');
});

test('NONCE_INVALID (zero)', async () => assert.equal(await code({ nonce: 0n }), 'NONCE_INVALID'));

test('BAD_SIGNATURE: tampered payload and wrong key', async () => {
  const good = await makeSigned({});
  // Swap in a signature made by a different key over a different action.
  const other = await makeSigned({ nonce: 99n });
  const forged = structuredClone(good.signedDelegate);
  forged.signature = other.signedDelegate.signature;
  const { encodeSignedDelegate } = await import('near-api-js');
  const b64 = Buffer.from(encodeSignedDelegate(forged)).toString('base64');
  assert.equal(validateSignedDelegate(b64, policy, ctx).code, 'BAD_SIGNATURE');
  // Flip a byte inside the signature (last 64 bytes).
  const raw = Buffer.from(good.b64, 'base64');
  raw[raw.length - 1] ^= 0xff;
  assert.equal(validateSignedDelegate(raw.toString('base64'), policy, ctx).code, 'BAD_SIGNATURE');
  // Flip a byte in the signed payload (nonce area) -> signature no longer matches.
  const raw2 = Buffer.from(good.b64, 'base64');
  raw2[raw2.length - 66] ^= 0x01;
  const r = validateSignedDelegate(raw2.toString('base64'), policy, ctx);
  assert.equal(r.ok, false);
});

test('ok result carries a decoded delegate that re-serializes into a transaction action', async () => {
  const r = await check({});
  const kp = KeyPair.fromRandom('ed25519');
  const tx = createTransaction('relayer.testnet', kp.getPublicKey(), AGENT, 1n, [actions.signedDelegate(r.signedDelegate)], new Uint8Array(32));
  assert.ok(encodeTransaction(tx).length > 100);
  assert.equal(CONTRACT, r.signedDelegate.delegateAction.receiverId);
});

test('N3-L1: parsePaymentSignatureHeader decodes unpadded base64url including alphanumeric-only (eyJhIjoxfQ)', () => {
  // eyJhIjoxfQ is base64url for {"a":1}
  const parsed = parsePaymentSignatureHeader('eyJhIjoxfQ');
  assert.equal(parsed.code, 'BAD_PAYMENT_SIGNATURE');
  assert.equal(parsed.detail, 'missing signed delegate in PAYMENT-SIGNATURE');

  // Also test with valid payload encoded as unpadded base64url
  const validObj = {
    signedDelegate: 'dGVzdA==',
    paymentRequirements: { payTo: 'bob.testnet', amount: '100', asset: 'usdc.testnet', mandate: 1 },
  };
  const b64url = Buffer.from(JSON.stringify(validObj)).toString('base64url');
  const res = parsePaymentSignatureHeader(b64url);
  assert.equal(res.ok, true);
  assert.equal(res.signedDelegateBase64, 'dGVzdA==');
});

