// Tests added to kill surviving mutants in src/validate.mjs (Stryker run 2026-11-01).
// Mutant ids come from .stryker-out/mutation-validate-before.json; each test names the
// ids it kills. Assertions target observable behaviour: canonical base64 decoding, the
// exact contract argument shape, expiry boundaries, and signature verification, plus
// rejection (never a throw, never an `ok`) on hostile input.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actions, buildDelegateAction, KeyPair, KeyPairSigner, encodeSignedDelegate } from 'near-api-js';
import { loadPolicy } from '../src/policy.mjs';
import {
  parseRequestPaymentArgs,
  decodeSignedDelegate,
  checkExpiry,
  validateSignedDelegate,
  parsePaymentSignatureHeader,
  matchPaymentRequirements,
} from '../src/validate.mjs';
import { basePolicy, makeSigned, AGENT, CONTRACT } from './helpers.mjs';

const policy = loadPolicy(basePolicy);
const ctx = { currentBlockHeight: 1000 };
const b64 = (bytes) => Buffer.from(bytes).toString('base64');
const objB64 = (o) => b64(Buffer.from(JSON.stringify(o), 'utf8'));
const ARGS = (o = { mandate_id: 1, recipient: 'bob.testnet', amount: '1', nonce: 1 }) => Buffer.from(JSON.stringify(o), 'utf8');

/** A real, correctly signed delegate whose request_payment args are raw bytes. */
const signedWith = async (argsBytes, o = {}) =>
  makeSigned({
    ...o,
    actions: [
      actions.functionCall(
        o.methodName ?? 'request_payment',
        argsBytes,
        o.gas ?? 60_000_000_000_000n,
        o.deposit ?? 0n,
      ),
    ],
  });

/** Deterministic PRNG so the property tests are reproducible and dependency-free. */
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

// ---------------------------------------------------------------------------
// decodeSignedDelegate: strict canonical base64 + borsh round trip
// ---------------------------------------------------------------------------

test('decodeSignedDelegate: non-canonical/oversized inputs decode to null, never throw (kills TBD)', async () => {
  const { b64: good } = await makeSigned({});
  const bytes = Buffer.from(good, 'base64');
  const rejected = [
    '', // empty
    ' ', // whitespace only
    good.slice(0, -4) + '====', // still base64-shaped but bad padding
    good.slice(0, good.length - 1), // length % 4 !== 0
    good.slice(0, 8) + '!!' + good.slice(10), // illegal alphabet
    '-' + good.slice(1), // base64url alphabet is not canonical here
    b64(Buffer.concat([bytes, Buffer.from([0])])), // one trailing byte
    b64([0xde, 0xad, 0xbe, 0xef]), // valid base64, invalid borsh
    'A'.repeat(8 * 1024 * 2 + 4), // over MAX_BYTES*2 characters
  ];
  for (const v of rejected) assert.equal(decodeSignedDelegate(v), null, JSON.stringify(v.slice(0, 24)));
  for (const v of [null, undefined, 42, {}, []]) assert.equal(decodeSignedDelegate(v), null, String(v));
  // Non-canonical trailing bits: 'AB==' decodes to the same byte as 'AA==' but re-encodes differently.
  assert.equal(decodeSignedDelegate('AB=='), null);
});

test('decodeSignedDelegate: a canonical delegate round-trips and keeps every field (kills TBD)', async () => {
  const { b64: good, signedDelegate } = await makeSigned({});
  const sd = decodeSignedDelegate(good);
  assert.equal(sd.delegateAction.senderId, AGENT);
  assert.equal(sd.delegateAction.receiverId, CONTRACT);
  assert.equal(sd.delegateAction.nonce, signedDelegate.delegateAction.nonce);
  assert.equal(sd.signature.ed25519Signature.data.length, 64);
});

// ---------------------------------------------------------------------------
// parseRequestPaymentArgs: fail-closed contract argument shape
// ---------------------------------------------------------------------------

test('parseRequestPaymentArgs: non-object / wrong-key JSON is rejected (kills TBD)', () => {
  const bad = [
    undefined,
    new Uint8Array(0),
    Buffer.from('not json'),
    Buffer.from('null'),
    Buffer.from('[]'),
    Buffer.from('"str"'),
    Buffer.from('1'),
    Buffer.from(JSON.stringify({ mandate_id: 1, recipient: 'bob.testnet', amount: '1' })), // missing nonce
    Buffer.from(JSON.stringify({ mandate_id: 1, recipient: 'bob.testnet', amount: '1', nonce: 1, extra: 1 })),
    Buffer.from(JSON.stringify({ mandateId: 1, recipient: 'bob.testnet', amount: '1', nonce: 1 })),
  ];
  for (const args of bad) assert.equal(parseRequestPaymentArgs(args).code, 'BAD_CALL_ARGS', String(args));
  // The exact four-key object is accepted and reports the parsed values.
  const ok = parseRequestPaymentArgs(ARGS());
  assert.equal(ok.ok, true);
  assert.equal(ok.call.mandateId, 1n);
  assert.equal(ok.call.recipient, 'bob.testnet');
  assert.equal(ok.call.amount, '1');
  assert.equal(ok.call.nonce, 1n);
});

test('parseRequestPaymentArgs: mandate_id/nonce accept u64 numbers and canonical strings only (kills TBD)', () => {
  const withField = (k, v) => ARGS({ mandate_id: 1, recipient: 'bob.testnet', amount: '1', nonce: 1, [k]: v });
  const U64_MAX = '18446744073709551615';
  for (const k of ['mandate_id', 'nonce']) {
    for (const v of [0, '0', 1, U64_MAX, Number(U64_MAX)]) {
      // Number(u64max) is not a safe integer; only string forms survive.
      if (typeof v === 'number' && !Number.isSafeInteger(v)) {
        assert.equal(parseRequestPaymentArgs(withField(k, v)).code, 'BAD_CALL_ARGS', `${k}=${v}`);
        continue;
      }
      const r = parseRequestPaymentArgs(withField(k, v));
      assert.equal(r.ok, true, `${k}=${String(v)}`);
      assert.equal(typeof r.call[k === 'mandate_id' ? 'mandateId' : 'nonce'], 'bigint');
    }
    for (const v of [-1, 1.5, '01', '1e3', '18446744073709551616', '+1', ' 1', true, null, [], {}]) {
      assert.equal(parseRequestPaymentArgs(withField(k, v)).code, 'BAD_CALL_ARGS', `${k}=${String(v)}`);
    }
  }
});

test('parseRequestPaymentArgs: recipient must be a 2..64 char NEAR account id (kills TBD)', () => {
  const withRecipient = (recipient) => ARGS({ mandate_id: 1, recipient, amount: '1', nonce: 1 });
  for (const recipient of ['a', '', 'A.testnet', '-bob.testnet', 'bob-.testnet', 'bob--x', 'bob.test net', 'x'.repeat(65), 42, null]) {
    assert.equal(parseRequestPaymentArgs(withRecipient(recipient)).code, 'BAD_CALL_ARGS', String(recipient));
  }
  for (const recipient of ['ab', 'bob.testnet', 'ab_cd', 'ab.cd', 'x'.repeat(64), '0x']) {
    assert.equal(parseRequestPaymentArgs(withRecipient(recipient)).ok, true, String(recipient));
  }
});

test('parseRequestPaymentArgs: amount is a canonical u128 decimal string (kills TBD)', () => {
  const withAmount = (amount) => ARGS({ mandate_id: 1, recipient: 'bob.testnet', amount, nonce: 1 });
  for (const amount of ['0', '1', '10', '340282366920938463463374607431768211455']) {
    const r = parseRequestPaymentArgs(withAmount(amount));
    assert.equal(r.ok, true, amount);
    assert.equal(r.call.amount, amount); // exact string, never a number
  }
  for (const amount of ['', '00', '01', '1.0', '1e3', '-1', '+1', ' 1', '340282366920938463463374607431768211456', 1, 0, null]) {
    assert.equal(parseRequestPaymentArgs(withAmount(amount)).code, 'BAD_CALL_ARGS', String(amount));
  }
});

// ---------------------------------------------------------------------------
// checkExpiry: inclusive bounds on both sides
// ---------------------------------------------------------------------------

test('checkExpiry: margin and window are inclusive at their exact boundaries (kills TBD)', () => {
  const p = { minBlockHeightMargin: 5, maxBlockHeightWindow: 200 };
  assert.equal(checkExpiry(1005n, p, 1000), null);
  assert.equal(checkExpiry(1004n, p, 1000).code, 'EXPIRES_TOO_SOON');
  assert.equal(checkExpiry(1006n, p, 1000), null);
  assert.equal(checkExpiry(1200n, p, 1000), null);
  assert.equal(checkExpiry(1201n, p, 1000).code, 'EXPIRES_TOO_FAR');
  // `cur` participates as a bigint so a height near 2^53 still compares exactly.
  assert.equal(checkExpiry(5n, { minBlockHeightMargin: 0, maxBlockHeightWindow: 10 }, 0n), null);
});

// ---------------------------------------------------------------------------
// validateSignedDelegate: verification path and key/signature types
// ---------------------------------------------------------------------------

test('validateSignedDelegate: malformed request_payment args fail closed with BAD_CALL_ARGS (kills TBD)', async () => {
  for (const args of [Buffer.from('{}'), Buffer.from('[]'), Buffer.from('{"mandate_id":1}'), new Uint8Array(0)]) {
    const { b64: raw } = await signedWith(args);
    assert.equal(validateSignedDelegate(raw, policy, ctx).code, 'BAD_CALL_ARGS', args.toString());
  }
  // A valid args buffer yields a parsed `call` in the result.
  const { b64: raw } = await signedWith(ARGS());
  const r = validateSignedDelegate(raw, policy, ctx);
  assert.equal(r.ok, true);
  assert.deepEqual(r.call, { mandateId: 1n, recipient: 'bob.testnet', amount: '1', nonce: 1n });
});

test('validateSignedDelegate: expiry is skipped without a height but the nonce check still runs (kills TBD)', async () => {
  const { b64: raw } = await makeSigned({ maxBlockHeight: 1n, nonce: 9n });
  assert.equal(validateSignedDelegate(raw, policy, {}).ok, true);
  assert.equal(validateSignedDelegate(raw, policy, { currentBlockHeight: null }).ok, true);
  assert.equal(validateSignedDelegate(raw, policy, ctx).code, 'EXPIRES_TOO_SOON');
  const { b64: zeroNonce } = await makeSigned({ nonce: 0n });
  assert.equal(validateSignedDelegate(zeroNonce, policy, {}).code, 'NONCE_INVALID');
  assert.equal(validateSignedDelegate(zeroNonce, policy, ctx).code, 'NONCE_INVALID');
});

test('validateSignedDelegate: only ed25519 keys and ed25519 signatures are accepted (kills TBD)', async () => {
  // 1) ed25519 key, but the signature is carried in the secp256k1 arm.
  const good = await makeSigned({});
  const forgedSig = structuredClone(good.signedDelegate);
  forgedSig.signature = { secp256k1Signature: { keyType: 1, data: new Uint8Array(65) } };
  assert.equal(validateSignedDelegate(b64(encodeSignedDelegate(forgedSig)), policy, ctx).code, 'BAD_SIGNATURE');

  // 2) secp256k1 signer: the public key has no ed25519 arm.
  const secp = KeyPair.fromRandom('secp256k1');
  const secpSigner = new KeyPairSigner(secp);
  const da = buildDelegateAction({
    senderId: AGENT,
    receiverId: CONTRACT,
    actions: [actions.functionCall('request_payment', ARGS(), 60_000_000_000_000n, 0n)],
    nonce: 7n,
    maxBlockHeight: 1050n,
    publicKey: secp.getPublicKey(),
  });
  const { signedDelegate: secpSd } = await secpSigner.signDelegateAction(da);
  assert.equal(validateSignedDelegate(b64(encodeSignedDelegate(secpSd)), policy, ctx).code, 'BAD_SIGNATURE');

  // 3) ed25519 signature present, but the delegate action carries a secp256k1 public key.
  const keyedSecp = structuredClone(good.signedDelegate);
  keyedSecp.delegateAction.publicKey = { secp256k1Key: { keyType: 1, data: new Uint8Array(64) } };
  assert.equal(validateSignedDelegate(b64(encodeSignedDelegate(keyedSecp)), policy, ctx).code, 'BAD_SIGNATURE');
});

test('validateSignedDelegate: the signature must cover sha256(prefix||borsh(delegate)) (kills TBD)', async () => {
  const { b64: raw } = await makeSigned({});
  const bytes = Buffer.from(raw, 'base64');
  const r0 = ((n) => {
    let s = n >>> 0;
    return () => {
      s = (s * 1664525 + 1013904223) >>> 0;
      return s / 4294967296;
    };
  })(0xc0ffee);
  // Flip one bit at many offsets: every flip must be rejected (BAD_SIGNATURE or BAD_ENCODING),
  // never accepted, and must never throw.
  for (let i = 0; i < 200; i++) {
    const copy = Buffer.from(bytes);
    const off = Math.floor(r0() * copy.length);
    copy[off] ^= 1 << Math.floor(r0() * 8);
    const r = validateSignedDelegate(copy.toString('base64'), policy, ctx);
    assert.equal(r.ok, false, `byte ${off} bit flip accepted`);
    assert.equal(typeof r.code, 'string', `byte ${off} must produce a rejection code`);
  }
  // Signature from a different key over a different action is rejected.
  const other = await makeSigned({ nonce: 99n });
  const mixed = structuredClone((await makeSigned({})).signedDelegate);
  mixed.signature = other.signedDelegate.signature;
  assert.equal(validateSignedDelegate(b64(encodeSignedDelegate(mixed)), policy, ctx).code, 'BAD_SIGNATURE');
});

test('validateSignedDelegate: an ok result exposes the verified key and parsed fields (kills TBD)', async () => {
  const { b64: raw, keyPair } = await makeSigned({});
  const r = validateSignedDelegate(raw, policy, ctx);
  assert.equal(r.ok, true);
  assert.equal(r.agentId, AGENT);
  assert.equal(r.method, 'request_payment');
  assert.equal(r.publicKey.toString(), keyPair.getPublicKey().toString());
  assert.equal(r.maxBlockHeight, 1050n);
  assert.equal(r.nonce, 7n);
  assert.equal(r.signedDelegate.delegateAction.receiverId, CONTRACT);
});

test('validateSignedDelegate: every policy gate still rejects its own violation (kills TBD)', async () => {
  const cases = [
    [{ receiverId: 'evil.testnet' }, 'WRONG_RECEIVER'],
    [{ senderId: 'mallory.testnet' }, 'AGENT_NOT_ALLOWED'],
    [{ senderId: 'agent.near' }, 'AGENT_NOT_ALLOWED'],
    [{ actions: [] }, 'WRONG_ACTION_COUNT'],
    [{ actions: [actions.transfer(1n)] }, 'NOT_FUNCTION_CALL'],
    [{ method: 'withdraw' }, 'METHOD_NOT_ALLOWED'],
    [{ deposit: 1n }, 'DEPOSIT_NOT_ZERO'],
    [{ gas: 59_999_999_999_999n }, 'GAS_TOO_LOW'],
    [{ gas: 100_000_000_000_001n }, 'GAS_TOO_HIGH'],
    [{ maxBlockHeight: 1004n }, 'EXPIRES_TOO_SOON'],
    [{ maxBlockHeight: 1201n }, 'EXPIRES_TOO_FAR'],
    [{ nonce: 0n }, 'NONCE_INVALID'],
  ];
  for (let i = 0; i < cases.length; i++) assert.equal((await makeSignedRaw(cases[i][0])).code, cases[i][1], `case ${i}`);
});

const makeSignedRaw = async (o) => validateSignedDelegate((await makeSigned(o)).b64, policy, ctx);

// ---------------------------------------------------------------------------
// paymentRequirements: shape, mandate forms and header/body agreement
// ---------------------------------------------------------------------------

const REQ = { payTo: 'bob.testnet', amount: '100', asset: 'usdc.testnet', mandate: 1 };

test('parsePaymentSignatureHeader: requirements shape is validated field by field (kills TBD)', () => {
  const hdr = (reqs) => objB64({ signedDelegate: 'dGVzdA==', paymentRequirements: reqs });
  const bad = [
    [{ ...REQ, payTo: 'a' }],
    [{ ...REQ, payTo: 'x'.repeat(65) }],
    [{ ...REQ, payTo: 'Bob.testnet' }],
    [{ ...REQ, payTo: 42 }],
    [{ ...REQ, amount: '01' }],
    [{ ...REQ, amount: '340282366920938463463374607431768211456' }],
    [{ ...REQ, amount: 100 }],
    [{ ...REQ, asset: '-' }],
    [{ ...REQ, asset: 'x'.repeat(65) }],
    [{ ...REQ, scheme: 'other' }],
    [{ ...REQ, network: 'near:mainnet' }],
    [{ ...REQ, maxTimeoutSeconds: 0 }],
    [{ ...REQ, maxTimeoutSeconds: -5 }],
    [{ ...REQ, maxTimeoutSeconds: '5' }],
    [{ ...REQ, maxTimeoutSeconds: Infinity }],
  ];
  for (const [reqs] of bad) {
    const r = parsePaymentSignatureHeader(hdr(reqs));
    assert.equal(r.ok, false, JSON.stringify(reqs));
  }
  for (const reqs of [
    REQ,
    { ...REQ, scheme: 'scrip', network: 'testnet', maxTimeoutSeconds: 1 },
    { ...REQ, network: 'near:testnet' },
  ]) {
    assert.equal(parsePaymentSignatureHeader(hdr(reqs)).ok, true, JSON.stringify(reqs));
  }
  for (const reqs of [null, [], 'x', 7]) {
    assert.equal(parsePaymentSignatureHeader(hdr(reqs)).code, 'BAD_PAYMENT_REQUIREMENTS', String(reqs));
  }
});

test('paymentRequirements mandate: every accepted spelling resolves to contract/id (kills TBD)', () => {
  const parse = (mandate, extra) =>
    parsePaymentSignatureHeader(objB64({ signedDelegate: 'dGVzdA==', paymentRequirements: { ...REQ, mandate, ...(extra ? { extra } : {}) } }));
  const forms = [
    [1, { id: 1n }],
    ['1', { id: 1n }],
    [CONTRACT, { cid: CONTRACT }],
    [`${CONTRACT}:1`, { cid: CONTRACT, id: 1n }],
    [`${CONTRACT}#1`, { cid: CONTRACT, id: 1n }],
    [{ contractId: CONTRACT, mandateId: '1' }, { cid: CONTRACT, id: 1n }],
    [{ contract_id: CONTRACT, mandate_id: 1 }, { cid: CONTRACT, id: 1n }],
    [{ id: 2 }, { id: 2n }],
    [{ contractId: CONTRACT }, { cid: CONTRACT }],
  ];
  for (const [mandate, want] of forms) {
    const r = parse(mandate);
    assert.equal(r.ok, true, JSON.stringify(mandate));
    assert.equal(r.requirements.expectedContractId, want.cid, JSON.stringify(mandate));
    assert.equal(r.requirements.expectedMandateId, want.id, JSON.stringify(mandate));
  }
  for (const mandate of [null, {}, [], 'scrip.mainnet', `${CONTRACT}:0:1`, `${CONTRACT}:`, ':1', { contractId: 'scrip.mainnet' }, { mandateId: '01' }, true]) {
    assert.equal(parse(mandate).code, 'BAD_PAYMENT_REQUIREMENTS', JSON.stringify(mandate));
  }
  // top-level extras must agree with the mandate spelling.
  assert.equal(parse(1, { mandateId: 2 }).code, 'BAD_PAYMENT_REQUIREMENTS');
  assert.equal(parse(`${CONTRACT}:1`, { mandateContract: 'evil.testnet' }).code, 'BAD_PAYMENT_REQUIREMENTS');
  assert.equal(parse(1, { mandateId: 1 }).ok, true);
});

test('parsePaymentSignatureHeader: header/body mismatches are rejected, matches return the body requirements (kills TBD)', () => {
  const hdrFor = (reqs) => objB64({ x402Version: 2, scheme: 'scrip', network: 'near:testnet', signedDelegate: 'dGVzdA==', paymentRequirements: reqs });
  const body = { ...REQ, mandate: { contractId: CONTRACT, mandateId: 3 } };
  assert.equal(parsePaymentSignatureHeader(hdrFor({ ...REQ, mandate: 3 }), body).ok, true);

  const bad = [
    [{ ...REQ, payTo: 'alice.testnet', mandate: 3 }, 'RECIPIENT_MISMATCH'],
    [{ ...REQ, amount: '101', mandate: 3 }, 'AMOUNT_MISMATCH'],
    [{ ...REQ, asset: 'other.testnet', mandate: 3 }, 'BAD_PAYMENT_REQUIREMENTS'],
    [{ ...REQ, mandate: { contractId: 'evil.testnet', mandateId: 3 } }, 'MANDATE_MISMATCH'],
    [{ ...REQ, mandate: { contractId: CONTRACT, mandateId: 4 } }, 'MANDATE_MISMATCH'],
  ];
  for (const [hdrReqs, code] of bad) {
    assert.equal(parsePaymentSignatureHeader(hdrFor(hdrReqs), body).code, code, JSON.stringify(hdrReqs));
  }
  // Invalid body requirements win over any header content.
  assert.equal(parsePaymentSignatureHeader(hdrFor(REQ), { ...REQ, payTo: 'X' }).code, 'BAD_PAYMENT_REQUIREMENTS');
  assert.equal(parsePaymentSignatureHeader(hdrFor({ ...REQ, payTo: 'X' }), body).code, 'BAD_PAYMENT_REQUIREMENTS');
});

test('parsePaymentSignatureHeader: header envelope gates version, scheme, network and delegate aliases (kills TBD)', () => {
  const withHdr = (o) => parsePaymentSignatureHeader(objB64(o));
  for (const v of [undefined, null, '', '   ', 42, {}]) assert.equal(parsePaymentSignatureHeader(v).code, 'MISSING_PAYMENT_SIGNATURE', String(v));
  for (const raw of ['***', objB64([1]), objB64('str'), objB64(null), 'A'.repeat(8 * 1024 * 2 + 4), 'QQ']) {
    assert.equal(parsePaymentSignatureHeader(raw).code, 'BAD_PAYMENT_SIGNATURE', raw.slice(0, 12));
  }
  for (const v of [1, 3, '2', null]) assert.equal(withHdr({ x402Version: v, signedDelegate: 'dGVzdA==' }).code, 'BAD_PAYMENT_SIGNATURE', String(v));
  assert.equal(withHdr({ x402Version: 2, scheme: 'other', signedDelegate: 'dGVzdA==' }).code, 'UNSUPPORTED_SCHEME');
  assert.equal(withHdr({ scheme: 'scrip', network: 'mainnet', signedDelegate: 'dGVzdA==' }).code, 'UNSUPPORTED_NETWORK');
  // All four delegate spellings are honoured; an empty one is missing.
  for (const key of ['signedDelegate', 'signed_delegate', 'signedDelegateAction']) {
    assert.equal(withHdr({ [key]: 'dGVzdA==', paymentRequirements: REQ }).signedDelegateBase64, 'dGVzdA==', key);
  }
  assert.equal(withHdr({ payload: { signedDelegateAction: 'dGVzdA==' }, paymentRequirements: REQ }).signedDelegateBase64, 'dGVzdA==');
  assert.equal(withHdr({ signedDelegate: '', paymentRequirements: REQ }).code, 'BAD_PAYMENT_SIGNATURE');
  // base64url input is normalised before decoding.
  assert.equal(parsePaymentSignatureHeader(Buffer.from(JSON.stringify({ signedDelegate: 'dGVzdA==', paymentRequirements: REQ })).toString('base64url')).ok, true);
});

test('matchPaymentRequirements: every mismatch has its own code, a match is ok (kills TBD)', () => {
  const reqs = { ...REQ, expectedContractId: CONTRACT, expectedMandateId: 1n };
  const call = { mandateId: 1n, recipient: 'bob.testnet', amount: '100' };
  assert.deepEqual(matchPaymentRequirements(call, reqs, policy), { ok: true });
  assert.equal(matchPaymentRequirements(null, reqs, policy).code, 'METHOD_NOT_ALLOWED');
  assert.equal(matchPaymentRequirements(call, { ...reqs, expectedContractId: 'evil.testnet' }, policy).code, 'MANDATE_MISMATCH');
  assert.equal(matchPaymentRequirements(call, { ...reqs, expectedContractId: 'evil.testnet' }, {}).ok, true);
  assert.equal(matchPaymentRequirements({ ...call, mandateId: 2n }, reqs, policy).code, 'MANDATE_MISMATCH');
  assert.equal(matchPaymentRequirements({ ...call, recipient: 'alice.testnet' }, reqs, policy).code, 'RECIPIENT_MISMATCH');
  assert.equal(matchPaymentRequirements({ ...call, amount: '101' }, reqs, policy).code, 'AMOUNT_MISMATCH');
  assert.equal(matchPaymentRequirements(call, REQ, policy).ok, true); // no expectations -> only equality checks
});

// ---------------------------------------------------------------------------
// Rejection details: `{ code, detail }` is what relay.mjs hands back to the
// caller, so the exact text is part of the response contract (not a comment).
// ---------------------------------------------------------------------------

test('every rejection returns its documented code and detail (kills TBD)', async () => {
  const cases = [];
  const add = (label, run, code, detail) => cases.push({ label, run, code, detail });

  add('bad encoding', () => validateSignedDelegate('AAAA', policy, ctx), 'BAD_ENCODING', 'not a canonical base64 borsh SignedDelegate');
  add('agent', async () => makeSignedRaw({ senderId: 'mallory.testnet' }), 'AGENT_NOT_ALLOWED', 'sender is not an allowed agent');
  add('receiver', async () => makeSignedRaw({ receiverId: 'evil.testnet' }), 'WRONG_RECEIVER', 'receiver must be the policy contract');
  add('action count', async () => makeSignedRaw({ actions: [] }), 'WRONG_ACTION_COUNT', 'exactly one action required');
  add('not a call', async () => makeSignedRaw({ actions: [actions.transfer(1n)] }), 'NOT_FUNCTION_CALL', 'action must be a function call');
  add('method', async () => makeSignedRaw({ method: 'withdraw' }), 'METHOD_NOT_ALLOWED', 'method is not allowed');
  add('deposit', async () => makeSignedRaw({ deposit: 1n }), 'DEPOSIT_NOT_ZERO', 'deposit must be zero');
  add('gas low', async () => makeSignedRaw({ gas: 1n }), 'GAS_TOO_LOW', 'gas is below the policy minimum');
  add('gas high', async () => makeSignedRaw({ gas: 100_000_000_000_001n }), 'GAS_TOO_HIGH', 'gas exceeds policy maximum');
  add('args json', async () => {
    const { b64: raw } = await signedWith(Buffer.from('{nope'));
    return validateSignedDelegate(raw, policy, ctx);
  }, 'BAD_CALL_ARGS', 'args are not valid JSON');
  add('expires soon', async () => makeSignedRaw({ maxBlockHeight: 1n }), 'EXPIRES_TOO_SOON', 'delegate action expires too soon');
  add('expires far', async () => makeSignedRaw({ maxBlockHeight: 5000n }), 'EXPIRES_TOO_FAR', 'delegate action expires too far ahead');
  add('nonce', async () => makeSignedRaw({ nonce: 0n }), 'NONCE_INVALID', 'nonce must be non-zero');
  add('secp signature', async () => {
    const good = await makeSigned({});
    const forged = structuredClone(good.signedDelegate);
    forged.signature = { secp256k1Signature: { keyType: 1, data: new Uint8Array(65) } };
    return validateSignedDelegate(b64(encodeSignedDelegate(forged)), policy, ctx);
  }, 'BAD_SIGNATURE', 'only ed25519 keys are accepted');
  add('bad signature', async () => {
    const { b64: raw } = await makeSigned({});
    const bytes = Buffer.from(raw, 'base64');
    bytes[bytes.length - 1] ^= 0xff;
    return validateSignedDelegate(bytes.toString('base64'), policy, ctx);
  }, 'BAD_SIGNATURE', 'signature does not match the delegate action');

  add('header missing', () => parsePaymentSignatureHeader(undefined), 'MISSING_PAYMENT_SIGNATURE', 'PAYMENT-SIGNATURE header is required');
  add('header not base64 json', () => parsePaymentSignatureHeader('***'), 'BAD_PAYMENT_SIGNATURE', 'PAYMENT-SIGNATURE must be base64-encoded JSON object');
  add('header version', () => parsePaymentSignatureHeader(objB64({ x402Version: 1, signedDelegate: 'dGVzdA==' })), 'BAD_PAYMENT_SIGNATURE', 'x402Version must be 2');
  add('header scheme', () => parsePaymentSignatureHeader(objB64({ scheme: 'x', signedDelegate: 'dGVzdA==' })), 'UNSUPPORTED_SCHEME', 'scheme must be scrip');
  add('header network', () => parsePaymentSignatureHeader(objB64({ network: 'near:mainnet', signedDelegate: 'dGVzdA==' })), 'UNSUPPORTED_NETWORK', 'network must be near:testnet');
  add('header delegate', () => parsePaymentSignatureHeader(objB64({ signedDelegate: '' })), 'BAD_PAYMENT_SIGNATURE', 'missing signed delegate in PAYMENT-SIGNATURE');

  const hdr = (reqs) => objB64({ signedDelegate: 'dGVzdA==', paymentRequirements: reqs });
  add('reqs object', () => parsePaymentSignatureHeader(hdr([])), 'BAD_PAYMENT_REQUIREMENTS', 'paymentRequirements must be a JSON object');
  add('reqs scheme', () => parsePaymentSignatureHeader(hdr({ ...REQ, scheme: 'x' })), 'UNSUPPORTED_SCHEME', 'scheme must be scrip');
  add('reqs network', () => parsePaymentSignatureHeader(hdr({ ...REQ, network: 'x' })), 'UNSUPPORTED_NETWORK', 'network must be near:testnet');
  add('reqs payTo', () => parsePaymentSignatureHeader(hdr({ ...REQ, payTo: 'A' })), 'BAD_PAYMENT_REQUIREMENTS', 'payTo must be a valid NEAR account id');
  add('reqs amount', () => parsePaymentSignatureHeader(hdr({ ...REQ, amount: '01' })), 'BAD_PAYMENT_REQUIREMENTS', 'amount must be a canonical u128 decimal string');
  add('reqs asset', () => parsePaymentSignatureHeader(hdr({ ...REQ, asset: 'a' })), 'BAD_PAYMENT_REQUIREMENTS', 'asset must be a valid NEAR account id');
  add('reqs timeout', () => parsePaymentSignatureHeader(hdr({ ...REQ, maxTimeoutSeconds: 0 })), 'BAD_PAYMENT_REQUIREMENTS', 'maxTimeoutSeconds must be a positive number');
  add('reqs mandate', () => parsePaymentSignatureHeader(hdr({ ...REQ, mandate: {} })), 'BAD_PAYMENT_REQUIREMENTS', 'mandate is required and must be a valid mandate id or contract spec');

  const body = { ...REQ, mandate: { contractId: CONTRACT, mandateId: 3 } };
  add('body payTo', () => parsePaymentSignatureHeader(hdr({ ...REQ, payTo: 'alice.testnet', mandate: 3 }), body), 'RECIPIENT_MISMATCH', 'header payTo disagrees with requirements');
  add('body amount', () => parsePaymentSignatureHeader(hdr({ ...REQ, amount: '101', mandate: 3 }), body), 'AMOUNT_MISMATCH', 'header amount disagrees with requirements');
  add('body asset', () => parsePaymentSignatureHeader(hdr({ ...REQ, asset: 'other.testnet', mandate: 3 }), body), 'BAD_PAYMENT_REQUIREMENTS', 'header asset disagrees with requirements');
  add('body mandate contract', () => parsePaymentSignatureHeader(hdr({ ...REQ, mandate: { contractId: 'evil.testnet', mandateId: 3 } }), body), 'MANDATE_MISMATCH', 'header mandate contract disagrees with requirements');
  add('body mandate id', () => parsePaymentSignatureHeader(hdr({ ...REQ, mandate: { contractId: CONTRACT, mandateId: 4 } }), body), 'MANDATE_MISMATCH', 'header mandateId disagrees with requirements');

  const reqs = { ...REQ, expectedContractId: CONTRACT, expectedMandateId: 1n };
  const call = { mandateId: 1n, recipient: 'bob.testnet', amount: '100' };
  add('match call', () => matchPaymentRequirements(null, reqs, policy), 'METHOD_NOT_ALLOWED', 'payment delegate must call request_payment');
  add('match contract', () => matchPaymentRequirements(call, { ...reqs, expectedContractId: 'evil.testnet' }, policy), 'MANDATE_MISMATCH', 'mandate contract does not match policy contract');
  add('match mandate', () => matchPaymentRequirements({ ...call, mandateId: 2n }, reqs, policy), 'MANDATE_MISMATCH', 'mandate_id does not match paymentRequirements');
  add('match recipient', () => matchPaymentRequirements({ ...call, recipient: 'alice.testnet' }, reqs, policy), 'RECIPIENT_MISMATCH', 'recipient does not match paymentRequirements.payTo');
  add('match amount', () => matchPaymentRequirements({ ...call, amount: '1' }, reqs, policy), 'AMOUNT_MISMATCH', 'amount does not match paymentRequirements.amount');

  for (const c of cases) {
    const r = await c.run();
    assert.equal(r.ok, false, c.label);
    assert.equal(r.code, c.code, `${c.label} code`);
    assert.equal(r.detail, c.detail, `${c.label} detail`);
  }
});

test('paymentRequirements mandate: bigint, unsafe numbers and top-level extras (kills TBD)', () => {
  const withReqs = (extra) => parsePaymentSignatureHeader(objB64({ signedDelegate: 'dGVzdA==', paymentRequirements: { ...REQ, ...extra } }));
  // bigint mandate ids can only arrive through the bodyRequirements object (JSON has no bigint).
  const viaBody = (mandate) => parsePaymentSignatureHeader(objB64({ signedDelegate: 'dGVzdA==' }), { ...REQ, mandate });
  assert.equal(viaBody({ mandateId: 3n }).requirements.expectedMandateId, 3n);
  assert.equal(viaBody({ mandateId: 0n }).requirements.expectedMandateId, 0n);
  for (const bad of [-1n, 1n << 64n]) assert.equal(viaBody({ mandateId: bad }).code, 'BAD_PAYMENT_REQUIREMENTS', String(bad));
  for (const bad of [1.5, -1, 2 ** 53, '1.0', '']) {
    assert.equal(withReqs({ mandate: { mandateId: bad } }).code, 'BAD_PAYMENT_REQUIREMENTS', String(bad));
  }
  assert.equal(withReqs({ mandate: { mandateId: 0 } }).requirements.expectedMandateId, 0n);
  // Top-level contractId/mandateId are merged with the mandate spelling and must agree.
  assert.equal(withReqs({ mandate: 1, contractId: CONTRACT }).requirements.expectedContractId, CONTRACT);
  assert.equal(withReqs({ mandate: 1, mandateId: '1' }).requirements.expectedMandateId, 1n);
  assert.equal(withReqs({ mandate: 1, contractId: 'scrip.mainnet' }).code, 'BAD_PAYMENT_REQUIREMENTS');
  assert.equal(withReqs({ mandate: `${CONTRACT}:1`, contractId: 'evil.testnet' }).code, 'BAD_PAYMENT_REQUIREMENTS');
  assert.equal(withReqs({ mandate: 1, extra: { mandateContract: 'scrip.mainnet' } }).code, 'BAD_PAYMENT_REQUIREMENTS');
  assert.equal(withReqs({ mandate: 1, extra: { mandateId: '01' } }).code, 'BAD_PAYMENT_REQUIREMENTS');
});
