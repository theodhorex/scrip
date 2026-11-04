// Offline proof for H6: every cat 6 attack parameter is really applied to the DelegateAction, and the
// facilitator source (facilitator/src/{validate,keycheck}.mjs) yields exactly the expected code.
import test from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import {
  planRelayAttack, buildAttackDelegate, classifyFtOnTransfer, readSuccessValue, isLegitTokenCaller,
} from '../layers/relay_attack.mjs';
import { validateSignedDelegate, checkExpiry } from '../../../facilitator/src/validate.mjs';
import { createKeyVerifier } from '../../../facilitator/src/keycheck.mjs';
import { loadPolicy } from '../../../facilitator/src/policy.mjs';
import { generateCategory6Cases, generateCategory7Cases } from '../cases/layer_e/delegate_gas.mjs';
import { generateCategory1Cases, generateCategory11Cases } from '../cases/layer_e/token_recipient.mjs';

const CONTRACT = 'amanat-h6.testnet';
const AGENT = 'agent-h6.testnet';
const T = 1_000_000_000_000n;
const policy = loadPolicy({
  network: 'testnet', contractId: CONTRACT, allowedMethods: ['request_payment'], allowedAgents: [AGENT],
  maxGas: String(150n * T), maxBlockHeightWindow: 300, minBlockHeightMargin: 5,
  rateLimit: { capacity: 5, refillPerSecond: 1 },
});
const ARGS = { mandate_id: 1, recipient: 'merchant.testnet', amount: '100000', nonce: 7 };
const HEAD = 1_000_000;

const build = (params, over = {}) => buildAttackDelegate({
  plan: planRelayAttack(params), keyPair: KeyPair.fromRandom('ed25519'), senderId: AGENT, contractId: CONTRACT,
  onChainNonce: 500, headHeight: HEAD, method: 'request_payment', args: ARGS, gas: 100n * T, ...over,
});

test('legit plan is accepted by the facilitator offline validator (negative control)', async () => {
  const { b64 } = await build({});
  const v = validateSignedDelegate(b64, policy, { currentBlockHeight: HEAD });
  assert.equal(v.ok, true);
});

test('delegateReceiverId is applied -> WRONG_RECEIVER (validate.mjs:98)', async () => {
  for (const r of ['attacker.testnet', 'relayer.testnet']) {
    const { b64 } = await build({ delegateReceiverId: r });
    assert.equal(validateSignedDelegate(b64, policy).code, 'WRONG_RECEIVER');
  }
});

test('actionsCount 0 and 2 are applied -> WRONG_ACTION_COUNT (validate.mjs:99)', async () => {
  for (const n of [0, 2]) {
    const { b64 } = await build({ actionsCount: n });
    assert.equal(validateSignedDelegate(b64, policy).code, 'WRONG_ACTION_COUNT');
  }
});

test('payload tampered after signing -> BAD_SIGNATURE (validate.mjs:134), untampered passes', async () => {
  const { b64 } = await build({ invalidSignature: true });
  assert.equal(validateSignedDelegate(b64, policy).code, 'BAD_SIGNATURE');
  assert.equal(validateSignedDelegate((await build({})).b64, policy).ok, true);
});

test('nonce 0 -> NONCE_INVALID (validate.mjs:121); nonce 1 passes offline (relay.mjs:225 rejects it later)', async () => {
  assert.equal(validateSignedDelegate((await build({ nonce: 0 })).b64, policy).code, 'NONCE_INVALID');
  const { b64, nonce } = await build({ nonce: 1 });
  assert.equal(nonce, 1n);
  assert.equal(validateSignedDelegate(b64, policy).ok, true);
});

test('default nonce is on-chain + 1; explicit nonce wins', async () => {
  assert.equal((await build({})).nonce, 501n);
  assert.equal((await build({ nonce: 3 })).nonce, 3n);
});

test('past maxBlockHeight is applied -> EXPIRES_TOO_SOON (validate.mjs:84); default is accepted', async () => {
  const past = await build({ maxBlockHeight: 100 });
  assert.equal(past.maxBlockHeight, 100n);
  const v = validateSignedDelegate(past.b64, policy);
  assert.equal(v.ok, true); // offline checks do not know the height
  assert.equal(checkExpiry(v.maxBlockHeight, policy, HEAD).code, 'EXPIRES_TOO_SOON');
  const ok = validateSignedDelegate((await build({})).b64, policy);
  assert.equal(checkExpiry(ok.maxBlockHeight, policy, HEAD), null);
});

test('gas below minimum / above maximum -> GAS_TOO_LOW / GAS_TOO_HIGH (validate.mjs:105-106)', async () => {
  for (const [g, code] of [[0n, 'GAS_TOO_LOW'], [59n * T, 'GAS_TOO_LOW'], [151n * T, 'GAS_TOO_HIGH']]) {
    assert.equal(validateSignedDelegate((await build({}, { gas: g })).b64, policy).code, code);
  }
  assert.equal(validateSignedDelegate((await build({}, { gas: 60n * T })).b64, policy).ok, true);
  assert.equal(validateSignedDelegate((await build({}, { gas: 150n * T })).b64, policy).ok, true);
});

test('recipient shape: uppercase / space / tab / homoglyph / empty -> BAD_CALL_ARGS (validate.mjs:50-51); valid lowercase passes', async () => {
  for (const r of ['MERCHANT.testnet', ' merchant.testnet', 'merchant.testnet ', 'merchant\t.testnet', 'merch\u0430nt.testnet', '']) {
    const { b64 } = await build({}, { args: { ...ARGS, recipient: r } });
    assert.equal(validateSignedDelegate(b64, policy).code, 'BAD_CALL_ARGS', JSON.stringify(r));
  }
  for (const r of ['sub.merchant.testnet', '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef']) {
    const { b64 } = await build({}, { args: { ...ARGS, recipient: r } });
    assert.equal(validateSignedDelegate(b64, policy).ok, true, r);
  }
});

const verifierFor = (permission, missing = false) => createKeyVerifier({
  policy,
  provider: {
    async viewAccessKey() {
      if (missing) { const e = new Error('x'); Object.defineProperty(e, 'constructor', { value: { name: 'AccessKeyDoesNotExistError' } }); throw e; }
      return { nonce: 10, permission };
    },
  },
});
const pk = KeyPair.fromRandom('ed25519').getPublicKey();
const fc = (o) => ({ FunctionCall: { receiver_id: CONTRACT, method_names: ['request_payment'], allowance: '250000000000000000000000', ...o } });

test('key specs are planned and each is rejected by keycheck.mjs as KEY_NOT_ALLOWED; the legit key is accepted', async () => {
  const cases = [
    [{ keyAllowedMethods: ['approve_intent'] }, fc({ method_names: ['approve_intent'] })],
    [{ keyAllowedMethods: ['ft_transfer'] }, fc({ method_names: ['ft_transfer'] })],
    [{ keyAllowedMethods: ['get_mandate'] }, fc({ method_names: ['get_mandate'] })],
    [{ keyType: 'FullAccess' }, 'FullAccess'],
    [{ keyAllowance: '0' }, fc({ allowance: '0' })],
    [{ keyReceiverId: 'usdc.testnet' }, fc({ receiver_id: 'usdc.testnet' })],
  ];
  for (const [params, permission] of cases) {
    const plan = planRelayAttack(params);
    assert.notEqual(plan.keySpec, null, JSON.stringify(params));
    assert.equal((await verifierFor(permission).check(AGENT, pk)).code, 'KEY_NOT_ALLOWED', JSON.stringify(params));
  }
  assert.equal((await verifierFor(fc({})).check(AGENT, pk)).ok, true);
  assert.equal((await verifierFor(null, true).check(AGENT, pk)).code, 'KEY_NOT_ALLOWED'); // forgedKey: unknown key
});

test('planRelayAttack: key spec fields and defaults', () => {
  assert.equal(planRelayAttack({}).keySpec, null);
  assert.deepEqual(planRelayAttack({ keyType: 'FullAccess' }).keySpec, { kind: 'FullAccess' });
  assert.deepEqual(planRelayAttack({ keyAllowance: '0' }).keySpec, { kind: 'FunctionCall', methodNames: ['request_payment'], receiverId: null, allowance: 0n });
  assert.deepEqual(planRelayAttack({ keyAllowedMethods: ['get_mandate'], keyReceiverId: 'usdc.testnet' }).keySpec,
    { kind: 'FunctionCall', methodNames: ['get_mandate'], receiverId: 'usdc.testnet', allowance: null });
  assert.equal(planRelayAttack({ forgedKey: true }).forgedKey, true);
  assert.equal(planRelayAttack({}).actionsCount, 1);
});

test('planRelayAttack fails closed on malformed params instead of sending a legit delegate', () => {
  for (const bad of [{ keyType: 'Weird' }, { keyAllowedMethods: [] }, { keyAllowedMethods: 'x' }, { keyAllowance: '-1' },
    { nonce: -1 }, { nonce: 'abc' }, { maxBlockHeight: 1.5 }, { actionsCount: -1 }, { actionsCount: 99 }, { delegateReceiverId: '' }]) {
    assert.throws(() => planRelayAttack(bad), undefined, JSON.stringify(bad));
  }
});

const b64 = (v) => Buffer.from(JSON.stringify(v)).toString('base64');
test('classifyFtOnTransfer: full refund + unchanged state is BLOCKED/FULL_REFUND', () => {
  const tx = { status: { SuccessValue: b64('1250000') }, receipts_outcome: [] };
  assert.equal(readSuccessValue(tx), '1250000');
  const r = classifyFtOnTransfer(tx, '1250000', { stateUnchanged: true });
  assert.deepEqual([r.label, r.code], ['BLOCKED', 'FULL_REFUND']);
});

test('classifyFtOnTransfer negatives: partial refund, mutated state, deposited event never count as blocked', () => {
  const part = { status: { SuccessValue: b64('5') }, receipts_outcome: [] };
  assert.notEqual(classifyFtOnTransfer(part, '1250000', { stateUnchanged: true }).label, 'BLOCKED');
  const ok = { status: { SuccessValue: b64('1250000') }, receipts_outcome: [] };
  assert.notEqual(classifyFtOnTransfer(ok, '1250000', { stateUnchanged: false }).label, 'BLOCKED');
  const dep = { status: { SuccessValue: b64('0') }, receipts_outcome: [{ outcome: { logs: ['EVENT_JSON:{"event":"deposited"}'] } }] };
  assert.equal(classifyFtOnTransfer(dep, '1250000', { stateUnchanged: false }).label, 'BREACH');
  assert.equal(classifyFtOnTransfer({}, '1', { stateUnchanged: true }).label, 'INERT');
});

test('catalog: cat 6 params give every case an applied attack and an expected code the facilitator can emit', () => {
  const FAC = new Set(['KEY_NOT_ALLOWED', 'WRONG_RECEIVER', 'WRONG_ACTION_COUNT', 'BAD_SIGNATURE', 'EXPIRES_TOO_SOON',
    'NONCE_TOO_LOW', 'NONCE_INVALID', 'UNAUTHORIZED_AGENT']);
  const cases = generateCategory6Cases();
  assert.equal(cases.length, 45);
  for (const c of cases) {
    assert.equal(c.expected.label, 'BLOCKED');
    assert.ok(FAC.has(c.expected.code), `${c.id} ${c.expected.code}`);
    const p = c.params;
    const applied = ['keyAllowedMethods', 'keyType', 'keyAllowance', 'keyReceiverId', 'delegateReceiverId', 'forgedKey',
      'invalidSignature', 'maxBlockHeight', 'nonce', 'actionsCount', 'agentIndex'].some((k) => p[k] !== undefined);
    assert.ok(applied, `${c.id} carries no attack parameter (would be INERT)`);
    planRelayAttack(p);
  }
});

test('catalog: cat 7 expects GAS_TOO_LOW / GAS_TOO_HIGH, never the contract-only names', () => {
  const codes = new Set(generateCategory7Cases().map((c) => c.expected.code));
  assert.deepEqual([...codes].filter((c) => c !== null).sort(), ['GAS_TOO_HIGH', 'GAS_TOO_LOW']);
  assert.ok(codes.has(null)); // 60..150 Tgas rows stay INERT
});

test('catalog: cat 1 shape-invalid recipients expect BAD_CALL_ARGS, well-formed unknown recipients keep RECIPIENT_NOT_ALLOWED', () => {
  for (const c of generateCategory1Cases()) {
    if (c.expected.code === null) continue;
    const r = c.params.recipient;
    const shapeOk = typeof r === 'string' && /^(?:[a-z\d]+[-_.])*[a-z\d]{2,64}$/.test(r) && r.length <= 64;
    assert.equal(c.expected.code, shapeOk ? 'RECIPIENT_NOT_ALLOWED' : 'BAD_CALL_ARGS', `${c.id} ${JSON.stringify(r)}`);
    assert.equal(c.expected.label, 'BLOCKED');
  }
});

test('catalog: cat 11 BLOCKED rows expect FULL_REFUND (lib.rs has no INVALID_TOKEN/ZERO_AMOUNT in ft_on_transfer)', () => {
  const cases = generateCategory11Cases();
  const blocked = cases.filter((c) => c.expected.label === 'BLOCKED');
  assert.ok(blocked.length >= 20);
  for (const c of blocked) assert.equal(c.expected.code, 'FULL_REFUND', c.id);
});

test('cat 11 split: counterfeit callers are runnable, the legit token symbol is not (never counted as pass)', () => {
  const cases = generateCategory11Cases();
  const runnable = cases.filter((c) => !isLegitTokenCaller(c.params.senderId));
  const needToken = cases.filter((c) => isLegitTokenCaller(c.params.senderId));
  assert.ok(runnable.length >= 5 && needToken.length >= 10, `${runnable.length}/${needToken.length}`);
  for (const c of runnable) {
    assert.equal(c.expected.label, 'BLOCKED', c.id);
    assert.equal(c.params.refundReason, 'INVALID_TOKEN', c.id); // lib.rs:471 m.token != token
  }
  assert.equal(isLegitTokenCaller('fake_usdc.testnet'), false);
  assert.equal(isLegitTokenCaller(undefined), false);
});
