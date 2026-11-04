import test from 'node:test';
import assert from 'node:assert/strict';
import { parseRecovery, isRecoverable, buildPlan } from '../recover.mjs';

const F = 'funder.testnet';
const fake = 'ed25519:FAKEFAKEFAKE';

test('parseRecovery keeps only well-formed entries', () => {
  const t = JSON.stringify({ accounts: [{ id: 'a.funder.testnet', key: fake }, { id: 'b' }, { key: fake }, { id: 'c', key: 'nope' }] });
  assert.deepEqual(parseRecovery(t), [{ id: 'a.funder.testnet', key: fake }]);
  assert.deepEqual(parseRecovery('not json'), []);
  assert.deepEqual(parseRecovery('{}'), []);
});

test('isRecoverable only accepts sub-accounts of the funder', () => {
  assert.equal(isRecoverable('amc1.funder.testnet', F), true);
  assert.equal(isRecoverable('funder.testnet', F), false);
  assert.equal(isRecoverable('other.testnet', F), false);
  assert.equal(isRecoverable('x.funder.near', 'funder.near'), false);
});

test('buildPlan sweeps balances, skips gone/foreign/duplicate accounts', () => {
  const entries = [
    { id: 'a.funder.testnet', key: fake }, { id: 'b.funder.testnet', key: fake },
    { id: 'gone.funder.testnet', key: fake }, { id: 'evil.testnet', key: fake }, { id: 'a.funder.testnet', key: fake },
  ];
  const state = {
    'a.funder.testnet': { exists: true, usdc: 500000n }, 'b.funder.testnet': { exists: true, usdc: 0n },
    'gone.funder.testnet': { exists: false, usdc: 0n }, 'evil.testnet': { exists: true, usdc: 9n },
  };
  const p = buildPlan(entries, F, state);
  assert.deepEqual(p.actions.map((a) => [a.id, a.sweep]), [['a.funder.testnet', 500000n], ['b.funder.testnet', 0n]]);
  assert.deepEqual(p.skipped.map((s) => s.reason), ['already gone', 'not a sub-account of the funder', 'duplicate']);
});

import { isAccountMissingError, isTransientRpcError, withRpcRetry } from '../recover.mjs';
test('recover: only an explicit missing-account error means "gone"; rate limits and network errors do not', () => {
  assert.equal(isAccountMissingError({ type: 'AccountDoesNotExist' }), true);
  assert.equal(isAccountMissingError(new Error('Account x.testnet does not exist at block height 5')), true);
  assert.equal(isAccountMissingError(new Error('{"error":{"code":-429,"message":"Rate limits exceeded"}}')), false);
  assert.equal(isAccountMissingError(new Error('fetch failed')), false);
});
test('recover: transient errors are retried, other errors are thrown at once', async () => {
  assert.equal(isTransientRpcError(new Error('Rate limits exceeded 429')), true);
  assert.equal(isTransientRpcError(new Error('UNAUTHORIZED')), false);
  let n = 0;
  const v = await withRpcRetry(async () => { n++; if (n < 3) throw new Error('429 rate limit'); return 'ok'; }, { sleep: async () => {} });
  assert.equal(v, 'ok'); assert.equal(n, 3);
  let m = 0;
  await assert.rejects(withRpcRetry(async () => { m++; throw new Error('UNAUTHORIZED'); }, { sleep: async () => {} }));
  assert.equal(m, 1);
});
