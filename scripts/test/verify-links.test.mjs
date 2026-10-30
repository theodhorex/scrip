import test from 'node:test';
import assert from 'node:assert/strict';
import { extractHashes, accountsIn, classify } from '../verify-links.mjs';

test('extractHashes finds top-level and nested base58 hashes', () => {
  const hash1 = '7FmibFsaMTCzaTDgK2jLviqTuNtKq3shxNomMn1oa4Lv';
  const hash2 = '4dAYztmoCoGoCVuS38gaJPM2sskVfpeW5YH6r2mFPHL5';
  const doc = {
    tx: hash1,
    nested: { list: [hash2, 'not-a-hash'] },
  };
  const map = extractHashes(doc);
  assert.equal(map.get(hash1), '$.tx');
  assert.equal(map.get(hash2), '$.nested.list[0]');
  assert.equal(map.size, 2);
});

test('extractHashes finds tx inside facilitatorLog JSON strings', () => {
  const hash = '2tXYKjLG2V451ii2aUDKJ9jFj7k4gok3eqeSuwRgcFLS';
  const doc = {
    facilitatorLog: [
      `[12:00:00] submitted tx: {"tx":"${hash}"}`,
    ],
  };
  const map = extractHashes(doc);
  assert.equal(map.get(hash), '$.facilitatorLog[0]');
});

test('accountsIn extracts unique testnet account IDs', () => {
  const text = 'from alice.testnet to bob.testnet and alice.testnet with relayer-1747.testnet';
  const accts = accountsIn(text);
  assert.deepEqual(accts, ['alice.testnet', 'bob.testnet', 'relayer-1747.testnet']);
});

test('classify accurately reports success, failure, and receipt status', () => {
  assert.deepEqual(classify(null), { ok: false, why: 'no status' });
  assert.deepEqual(classify({ status: { Failure: { ActionError: {} } } }), { ok: false, why: 'tx failed' });
  assert.deepEqual(
    classify({ status: { SuccessValue: '' } }),
    { ok: true, receiptFailure: false, why: 'ok' },
  );
  assert.deepEqual(
    classify({
      status: { SuccessReceiptId: 'abc' },
      receipts_outcome: [{ outcome: { status: { Failure: {} } } }],
    }),
    { ok: true, receiptFailure: true, why: 'tx ok, a receipt failed' },
  );
});
