// Intent hash per PRD 3.4. Pure function: Node built-ins only, BigInt arithmetic only.
import { createHash } from 'node:crypto';

const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const PREFIX = Buffer.from('amanat/v1', 'ascii');
const MAX_RECIPIENT_BYTES = 64;
const RECIPIENT_RE = /^[a-z0-9._-]+$/;
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

/**
 * @typedef {object} IntentInput
 * @property {bigint|number} mandateId   u64 (BigInt or safe-integer Number)
 * @property {string} recipient          1..64 chars of [a-z0-9._-]
 * @property {string} amount             canonical decimal string, u128
 * @property {bigint|number} nonce       u64
 * @property {bigint|number} expiresAtMs u64
 */

/** @returns {bigint} */
export function toU64(value, name) {
  let n;
  if (typeof value === 'bigint') {
    n = value;
  } else if (typeof value === 'number') {
    if (!Number.isInteger(value)) throw new TypeError(`${name} must be an integer, got ${value}`);
    if (!Number.isSafeInteger(value)) throw new RangeError(`${name} is not a safe integer; pass a BigInt`);
    n = BigInt(value);
  } else {
    throw new TypeError(`${name} must be a BigInt or safe-integer Number`);
  }
  if (n < 0n || n > U64_MAX) throw new RangeError(`${name} out of u64 range`);
  return n;
}

/** @returns {bigint} */
export function toU128(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a decimal string`);
  if (!AMOUNT_RE.test(value)) {
    throw new RangeError(`${name} must be canonical decimal digits (no sign, spaces, or leading zeros)`);
  }
  const n = BigInt(value);
  if (n > U128_MAX) throw new RangeError(`${name} out of u128 range`);
  return n;
}

export function checkRecipient(recipient) {
  if (typeof recipient !== 'string') throw new TypeError('recipient must be a string');
  if (recipient.length === 0) throw new RangeError('recipient must not be empty');
  if (!RECIPIENT_RE.test(recipient)) throw new RangeError('recipient must match [a-z0-9._-] (ASCII only)');
  if (recipient.length > MAX_RECIPIENT_BYTES) {
    throw new RangeError(`recipient longer than ${MAX_RECIPIENT_BYTES} bytes`);
  }
  return Buffer.from(recipient, 'utf8');
}

function le(value, bytes) {
  const out = Buffer.alloc(bytes);
  let v = value;
  for (let i = 0; i < bytes; i++) {
    out[i] = Number(v & 0xffn);
    v >>= 8n;
  }
  return out;
}

/**
 * SHA-256("amanat/v1" || u64le mandate_id || u32le len || recipient || u128le amount || u64le nonce || u64le expires_at_ms)
 * @param {IntentInput} input
 * @returns {Uint8Array} 32 bytes
 */
export function intentHash(input) {
  if (input === null || typeof input !== 'object') throw new TypeError('input must be an object');
  const mandateId = toU64(input.mandateId, 'mandateId');
  const recipient = checkRecipient(input.recipient);
  const amount = toU128(input.amount, 'amount');
  const nonce = toU64(input.nonce, 'nonce');
  const expiresAtMs = toU64(input.expiresAtMs, 'expiresAtMs');
  const h = createHash('sha256');
  h.update(PREFIX);
  h.update(le(mandateId, 8));
  h.update(le(BigInt(recipient.length), 4));
  h.update(recipient);
  h.update(le(amount, 16));
  h.update(le(nonce, 8));
  h.update(le(expiresAtMs, 8));
  return new Uint8Array(h.digest());
}

/** @param {IntentInput} input @returns {string} lowercase hex */
export function intentHashHex(input) {
  return Buffer.from(intentHash(input)).toString('hex');
}
