// Mutation-targeted tests for src/intent.mjs (task S4: Stryker client/).
//
// Every test names the Stryker mutant(s) it kills. Ids refer to
// client/.stryker-out/mutation.baseline.json (baseline: 82.14%, 20 survived).
// All cited survivors slipped through because the original suite asserted only
// error CLASSES; these tests pin the exact guard/message instead.
//
// Hash expectations come only from the independent Python oracle
// (tools/gen_vectors.py -> docs/vectors/intent_hash.json). Nothing is recomputed
// with the code under test: the test-side reference preimage below is pinned to
// every Python vector before it is used over a random domain.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { intentHash, intentHashHex, toU64, toU128 } from '../src/intent.mjs';

const vectors = JSON.parse(
  readFileSync(new URL('../../docs/vectors/intent_hash.json', import.meta.url), 'utf8'),
);
const base = { mandateId: 1n, recipient: 'shop.testnet', amount: '1000000', nonce: 3n, expiresAtMs: 1700000000000n };

test('non-object input throws the guard message verbatim (kills #101 #102 #103 #105 #109)', () => {
  // Survivors replace the guard with `false`, tighten `||` to `&&`, or blank the
  // message: execution then dies later in property access with a different TypeError.
  for (const bad of [null, undefined, 5, 'x']) {
    assert.throws(() => intentHash(bad), { name: 'TypeError', message: 'input must be an object' });
  }
});

test('numeric coercion failures report field name and cause (kills #19 #28 #33)', () => {
  // #19 forces `else if (true)`, re-routing non-numbers into the integer check;
  // #28/#33 blank the two diagnostic templates.
  assert.throws(() => intentHash({ ...base, nonce: '1' }), { name: 'TypeError', message: 'nonce must be a BigInt or safe-integer Number' });
  assert.throws(() => intentHash({ ...base, nonce: 1.5 }), { name: 'TypeError', message: 'nonce must be an integer, got 1.5' });
  assert.throws(() => intentHash({ ...base, nonce: 2 ** 53 }), { name: 'RangeError', message: 'nonce is not a safe integer; pass a BigInt' });
});

test('amount must be a canonical decimal string (kills #54 #111; abuse case: no alias spellings)', () => {
  // Security: "007" and "7" must not both be acceptable spellings of one value,
  // or a signed intent could be reworded without changing its meaning.
  assert.throws(() => intentHash({ ...base, amount: 5 }), { name: 'TypeError', message: 'amount must be a decimal string' });
  assert.throws(() => intentHash({ ...base, amount: 5n }), { name: 'TypeError', message: 'amount must be a decimal string' });
  assert.throws(() => intentHash({ ...base, amount: '007' }), { name: 'RangeError', message: 'amount must be canonical decimal digits (no sign, spaces, or leading zeros)' }); // re-guarantees #60 (killed at baseline)
});

test('recipient type guard reports its own message (kills #69 #73)', () => {
  // #69 disables the type guard so execution falls into `recipient.length`
  // ("Cannot read properties of undefined"); #73 blanks the message.
  assert.throws(() => intentHash({ ...base, recipient: undefined }), { name: 'TypeError', message: 'recipient must be a string' });
  assert.throws(() => intentHash({ ...base, recipient: 5 }), { name: 'TypeError', message: 'recipient must be a string' });
});

test('empty recipient is rejected as empty, not as a charset mismatch (kills #75 #78)', () => {
  assert.throws(() => intentHash({ ...base, recipient: '' }), { name: 'RangeError', message: 'recipient must not be empty' });
});

test('range errors name the offending field (kills #110 #112 #113)', () => {
  assert.throws(() => intentHash({ ...base, mandateId: -1n }), { name: 'RangeError', message: 'mandateId out of u64 range' });
  assert.throws(() => intentHash({ ...base, nonce: 2n ** 64n }), { name: 'RangeError', message: 'nonce out of u64 range' });
  assert.throws(() => intentHash({ ...base, expiresAtMs: 2n ** 64n }), { name: 'RangeError', message: 'expiresAtMs out of u64 range' });
});

// --- property tests (broad domain, seeded => deterministic, no flakiness) ---

const toArgs = (i) => ({
  mandateId: typeof i.mandateId === 'bigint' ? i.mandateId : BigInt(i.mandateId),
  recipient: i.recipient,
  amount: typeof i.amount === 'bigint' ? i.amount : BigInt(i.amount),
  nonce: typeof i.nonce === 'bigint' ? i.nonce : BigInt(i.nonce),
  expiresAtMs: typeof i.expiresAtMs === 'bigint' ? i.expiresAtMs : BigInt(i.expiresAtMs),
});

function lcg(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = s;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const r32 = (rnd) => BigInt(Math.floor(rnd() * 4294967296));
const randomU64 = (rnd) => r32(rnd) | (r32(rnd) << 32n);
const randomU128 = (rnd) => randomU64(rnd) | (randomU64(rnd) << 64n);
const CHARS = 'abcdefghijklmnopqrstuvwxyz0123456789._-';
function randomRecipient(rnd) {
  const len = 1 + Math.floor(rnd() * 64);
  let s = '';
  for (let i = 0; i < len; i++) s += CHARS[Math.floor(rnd() * CHARS.length)];
  return s;
}

// Spec transliteration of the PRD preimage (little-endian fields), used as a
// reference oracle only AFTER it is proven equal to every Python vector.
function leRef(value, bytes) {
  const out = Buffer.alloc(bytes);
  let v = value;
  for (let i = 0; i < bytes; i++) { out[i] = Number(v & 0xffn); v >>= 8n; }
  return out;
}
function refHex(i) {
  const r = Buffer.from(i.recipient, 'ascii');
  return createHash('sha256')
    .update(Buffer.from('amanat/v1', 'ascii'))
    .update(leRef(BigInt(i.mandateId), 8))
    .update(leRef(BigInt(r.length), 4))
    .update(r)
    .update(leRef(BigInt(i.amount), 16))
    .update(leRef(BigInt(i.nonce), 8))
    .update(leRef(BigInt(i.expiresAtMs), 8))
    .digest('hex');
}

test('property: hash equals the Python-spec preimage over a seeded 200-case domain, deterministically (kills #2 #98 #115-#121)', () => {
  // Anti-tautology: the reference must first reproduce all 10 Python vectors
  // (endianness_probe included) before it is trusted on random inputs.
  for (const v of vectors.positive) assert.equal(refHex(toArgs(v.input)), v.hash);
  const rnd = lcg(0xa6a7);
  for (let i = 0; i < 200; i++) {
    const inp = { mandateId: randomU64(rnd), recipient: randomRecipient(rnd), amount: randomU128(rnd).toString(), nonce: randomU64(rnd), expiresAtMs: randomU64(rnd) };
    const a = intentHashHex(inp);
    assert.equal(a, refHex(inp), `case ${i}: preimage mismatch`);
    assert.equal(a, intentHashHex(inp), `case ${i}: not deterministic`);
    assert.match(a, /^[0-9a-f]{64}$/);
  }
});

test('property: toU64 Number<->BigInt round-trip over a seeded wide domain (kills #16 #21)', () => {
  const rnd = lcg(0xbeef);
  for (let i = 0; i < 200; i++) {
    const n = randomU64(rnd);
    assert.equal(toU64(n), n);
    assert.equal(toU64(BigInt(toU64(n))), n); // idempotent round-trip
    if (n <= BigInt(Number.MAX_SAFE_INTEGER)) assert.equal(toU64(Number(n)), n);
  }
  assert.equal(toU64(BigInt(Number.MAX_SAFE_INTEGER)), BigInt(Number.MAX_SAFE_INTEGER));
  assert.throws(() => toU64(2 ** 53), RangeError);
});
