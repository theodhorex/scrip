// RPC/network outages must never be reported as a contract verdict (BLOCKED/BREACH): they are retried, then SKIPPED.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { isInfraError, withRetry } from '../layers/testnet.mjs';

test('isInfraError recognises rate limits and gateway errors only', () => {
  assert.equal(isInfraError('{"error":{"code":-429,"message":"Rate limits exceeded"}}'), true);
  assert.equal(isInfraError('HTTP 502'), true);
  assert.equal(isInfraError('fetch failed'), true);
  assert.equal(isInfraError('OVER_BUDGET'), false);
  assert.equal(isInfraError('AMANAT_ERR: UNAUTHORIZED_AGENT'), false);
});

test('withRetry retries infra errors then succeeds', async () => {
  let n = 0;
  const v = await withRetry(async () => { if (++n < 3) throw new Error('Rate limits exceeded'); return 'ok'; }, { tries: 5, baseMs: 1 });
  assert.equal(v, 'ok');
  assert.equal(n, 3);
});

test('withRetry does NOT retry a real error and gives up after the limit', async () => {
  let n = 0;
  await assert.rejects(withRetry(async () => { n++; throw new Error('UNAUTHORIZED_AGENT'); }, { tries: 5, baseMs: 1 }), /UNAUTHORIZED_AGENT/);
  assert.equal(n, 1);
  let m = 0;
  await assert.rejects(withRetry(async () => { m++; throw new Error('502'); }, { tries: 3, baseMs: 1 }), /502/);
  assert.equal(m, 3);
});

import { isAccountMissingError } from '../layers/testnet.mjs';
test('cleanup leftover check: only an explicit missing-account error counts as deleted', () => {
  assert.equal(isAccountMissingError({ type: 'AccountDoesNotExist' }), true);
  assert.equal(isAccountMissingError(new Error('Account amce1.testnet does not exist while viewing')), true);
  assert.equal(isAccountMissingError(new Error('fetch failed')), false);
  assert.equal(isAccountMissingError(new Error('Rate limits exceeded')), false);
  assert.equal(isAccountMissingError(undefined), false);
});
