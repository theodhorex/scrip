import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { intentHash, intentHashHex } from '../src/intent.mjs';

const vectors = JSON.parse(
  readFileSync(new URL('../../docs/vectors/intent_hash.json', import.meta.url), 'utf8'),
);

const toArgs = (i) => ({
  mandateId: BigInt(i.mandateId),
  recipient: i.recipient,
  amount: i.amount,
  nonce: BigInt(i.nonce),
  expiresAtMs: BigInt(i.expiresAtMs),
});
const hex = (u8) => Buffer.from(u8).toString('hex');

test('vector file has at least 8 positive and 8 negative cases', () => {
  assert.ok(vectors.positive.length >= 8);
  assert.ok(vectors.negative.length >= 8);
});

for (const v of vectors.positive) {
  test(`positive vector: ${v.name}`, () => {
    const h = intentHash(toArgs(v.input));
    assert.ok(h instanceof Uint8Array);
    assert.equal(h.length, 32);
    assert.equal(hex(h), v.hash);
    assert.equal(intentHashHex(toArgs(v.input)), v.hash);
  });
}

for (const v of vectors.negative) {
  test(`negative vector: ${v.name} -> ${v.error}`, () => {
    const Cls = { RangeError, TypeError }[v.error];
    assert.ok(Cls, 'unknown error class in vectors');
    assert.throws(() => intentHash(toArgs(v.input)), Cls);
  });
}

test('safe-integer Number inputs equal BigInt inputs', () => {
  const v = vectors.positive.find((p) => p.name === 'typical');
  const viaNumber = intentHashHex({
    mandateId: Number(v.input.mandateId),
    recipient: v.input.recipient,
    amount: v.input.amount,
    nonce: Number(v.input.nonce),
    expiresAtMs: Number(v.input.expiresAtMs),
  });
  assert.equal(viaNumber, v.hash);
});

test('unsafe or non-integer Number is rejected', () => {
  const base = toArgs(vectors.positive[0].input);
  assert.throws(() => intentHash({ ...base, nonce: 2 ** 53 }), RangeError);
  assert.throws(() => intentHash({ ...base, nonce: 1.5 }), TypeError);
  assert.throws(() => intentHash({ ...base, nonce: NaN }), TypeError);
  assert.throws(() => intentHash({ ...base, nonce: -1 }), RangeError);
  assert.throws(() => intentHash({ ...base, nonce: '1' }), TypeError);
});

test('amount must be a string (no Number/BigInt)', () => {
  const base = toArgs(vectors.positive[0].input);
  assert.throws(() => intentHash({ ...base, amount: 5 }), TypeError);
  assert.throws(() => intentHash({ ...base, amount: 5n }), TypeError);
});

test('recipient must be a string', () => {
  const base = toArgs(vectors.positive[0].input);
  assert.throws(() => intentHash({ ...base, recipient: undefined }), TypeError);
});
