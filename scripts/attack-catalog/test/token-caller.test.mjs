import test from 'node:test';
import assert from 'node:assert/strict';
import { classifyTokenCallerOutcome } from '../layers/relay_attack.mjs';

const M = { id: 1, deposited: '5', status: 'Active' };
const base = { amount: '100000', senderBefore: 1000n, senderAfter: 1000n, contractBefore: 500n, contractAfter: 500n, logs: [], mandateBefore: M, mandateAfter: { ...M } };

test('token caller: all three proofs hold -> BLOCKED FULL_REFUND', () => {
  const r = classifyTokenCallerOutcome(base);
  assert.deepEqual([r.label, r.code], ['BLOCKED', 'FULL_REFUND']);
});
test('token caller: an unreadable proof is INFRA_ERROR, never BLOCKED or BREACH', () => {
  for (const k of ['senderBefore', 'senderAfter', 'contractBefore', 'contractAfter']) {
    const r = classifyTokenCallerOutcome({ ...base, [k]: null });
    assert.deepEqual([r.label, r.code], ['SKIPPED', 'INFRA_ERROR'], k);
  }
  assert.equal(classifyTokenCallerOutcome({ ...base, mandateAfter: undefined }).label, 'SKIPPED');
  assert.equal(classifyTokenCallerOutcome({ ...base, logs: null }).label, 'SKIPPED');
});
test('token caller: a consistent deposit is INERT (accepted), not a refund', () => {
  const r = classifyTokenCallerOutcome({ ...base, amount: '100', senderAfter: 900n, contractAfter: 600n, mandateAfter: { ...M, deposited: '6' }, logs: ['EVENT_JSON:{"event":"deposited"}'] });
  assert.equal(r.label, 'INERT');
});
test('token caller: a deposited event with unchanged balances cannot be called a refund', () => {
  const r = classifyTokenCallerOutcome({ ...base, logs: ['EVENT_JSON:{"event":"deposited"}'] });
  assert.notEqual(r.code, 'FULL_REFUND');
});
test('token caller: mirrored mismatch (funds lost) is a BREACH', () => {
  const r = classifyTokenCallerOutcome({ ...base, senderAfter: 900n });
  assert.deepEqual([r.label, r.code], ['BREACH', 'LEDGER_MISMATCH']);
});
test('token caller: mandate changed without a matching deposit is not a refund', () => {
  const r = classifyTokenCallerOutcome({ ...base, mandateAfter: { ...M, status: 'Revoked' } });
  assert.notEqual(r.code, 'FULL_REFUND');
});
