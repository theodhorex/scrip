// Agent-side NEP-366 helpers: build + sign a request_payment delegate offline, encode it for the
// facilitator, classify its responses, and decode the contract's PaymentResult. No network, no I/O.
import { buildDelegateAction, actions, KeyPairSigner, encodeSignedDelegate } from 'near-api-js';
import { toU64, toU128, checkRecipient } from './intent.mjs';

const TGAS = 10n ** 12n;
/** Contract requires prepaid gas >= 60 Tgas (MIN_PREPAID_GAS in contracts/amanat/src/lib.rs). */
export const MIN_GAS = 60n * TGAS;
export const DEFAULT_GAS = 100n * TGAS;
const U64_MAX = (1n << 64n) - 1n;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** Mirrors `RejectCode::as_str` in the contract. */
export const REJECT_CODES = Object.freeze([
  'NOT_ACTIVE', 'EXPIRED', 'RECIPIENT_NOT_ALLOWED', 'OVER_PER_PAYMENT_CAP', 'TOO_MANY_OPEN',
  'OVER_BUDGET', 'NEEDS_APPROVAL', 'APPROVAL_USED', 'APPROVAL_EXPIRED',
]);

/** Facilitator error codes (facilitator/README.md). */
export const RELAY_ERROR_CODES = Object.freeze([
  'BAD_ENCODING', 'AGENT_NOT_ALLOWED', 'WRONG_RECEIVER', 'WRONG_ACTION_COUNT', 'NOT_FUNCTION_CALL',
  'METHOD_NOT_ALLOWED', 'DEPOSIT_NOT_ZERO', 'GAS_TOO_HIGH', 'EXPIRES_TOO_SOON', 'EXPIRES_TOO_FAR',
  'NONCE_INVALID', 'BAD_SIGNATURE', 'RATE_LIMITED', 'UPSTREAM_ERROR', 'RELAY_FAILED', 'TX_FAILED',
  'BAD_JSON', 'BAD_REQUEST', 'IP_RATE_LIMITED', 'DUPLICATE_DELEGATE', 'SERVER_BUSY', 'RELAY_PENDING', 'GAS_TOO_LOW', 'KEY_NOT_ALLOWED',
]);
// Retryable with the same bytes: rate limit and upstream/submit hiccups. TX_FAILED is not (it
// reached the chain and failed; resubmitting the same delegate would burn relayer gas again).
// DUPLICATE_DELEGATE and RELAY_PENDING are not retryable: the first copy may already be on chain,
// so look the tx up instead of resending.
const RETRYABLE = new Set(['RATE_LIMITED', 'IP_RATE_LIMITED', 'SERVER_BUSY', 'UPSTREAM_ERROR', 'RELAY_FAILED']);

function checkId(value, name) {
  if (typeof value !== 'string') throw new TypeError(`${name} must be a string`);
  if (value.length === 0 || value.length > 64) throw new RangeError(`${name} must be 1..64 chars`);
  return value;
}

/**
 * Function-call action for `request_payment`. Deposit is always 0.
 * @param {{contractId: string, mandateId: bigint|number, recipient: string, amount: string, nonce: bigint|number, gas?: bigint}} p
 */
export function buildRequestPayment(p) {
  if (p === null || typeof p !== 'object') throw new TypeError('input must be an object');
  checkId(p.contractId, 'contractId');
  const mandateId = toU64(p.mandateId, 'mandateId');
  checkRecipient(p.recipient);
  const amount = toU128(p.amount, 'amount');
  const nonce = toU64(p.nonce, 'nonce');
  const gas = p.gas === undefined ? DEFAULT_GAS : p.gas;
  if (typeof gas !== 'bigint') throw new TypeError('gas must be a BigInt');
  if (gas < MIN_GAS) throw new RangeError(`gas must be at least 60 Tgas (${MIN_GAS}); the contract refuses less`);
  if (gas > U64_MAX) throw new RangeError('gas out of u64 range');
  // Hand-built JSON keeps u64 exact (JSON.stringify cannot take BigInt, Number loses > 2^53).
  const args = Buffer.from(
    `{"mandate_id":${mandateId},"recipient":${JSON.stringify(p.recipient)},"amount":"${amount}","nonce":${nonce}}`,
    'utf8',
  );
  return actions.functionCall('request_payment', args, gas, 0n);
}

/**
 * Builds and signs a NEP-366 delegate action offline.
 * @param {{agentId: string, contractId: string, action: object, nonce: bigint|number, maxBlockHeight: bigint|number, keyPair: object}} p
 * @returns {Promise<{signedDelegate: object, base64: string}>}
 */
export async function signDelegate(p) {
  if (p === null || typeof p !== 'object') throw new TypeError('input must be an object');
  checkId(p.agentId, 'agentId');
  checkId(p.contractId, 'contractId');
  if (p.action === null || typeof p.action !== 'object') throw new TypeError('action must be an action object');
  const nonce = toU64(p.nonce, 'nonce');
  const maxBlockHeight = toU64(p.maxBlockHeight, 'maxBlockHeight');
  if (!p.keyPair || typeof p.keyPair.getPublicKey !== 'function') throw new TypeError('keyPair must be a near-api-js KeyPair');
  const delegateAction = buildDelegateAction({
    senderId: p.agentId,
    receiverId: p.contractId,
    actions: [p.action],
    nonce,
    maxBlockHeight,
    publicKey: p.keyPair.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(p.keyPair).signDelegateAction(delegateAction);
  return { signedDelegate, base64: Buffer.from(encodeSignedDelegate(signedDelegate)).toString('base64') };
}

/** JSON body string for POST /relay. */
export function relayBodyFor(base64) {
  if (typeof base64 !== 'string' || base64.length === 0) throw new TypeError('base64 must be a non-empty string');
  if (!B64.test(base64) || base64.length % 4 !== 0) throw new RangeError('base64 is not canonical base64');
  return JSON.stringify({ signed_delegate: base64 });
}

/**
 * Maps a facilitator response. `retryAfter` is the optional Retry-After header value (seconds).
 * @param {{status: number, body: any, retryAfter?: string|number|null}} r
 * @returns {{ok: boolean, retryable: boolean, code: string|null, retryAfterSeconds: number|null, txHash: string|null}}
 */
export function classifyRelayResponse(r) {
  if (r === null || typeof r !== 'object' || !Number.isInteger(r.status)) throw new TypeError('status must be an integer');
  const { status, body } = r;
  const b = body !== null && typeof body === 'object' ? body : {};
  if (status === 200 && b.ok === true) {
    return { ok: true, retryable: false, code: null, retryAfterSeconds: null, txHash: typeof b.tx_hash === 'string' ? b.tx_hash : null };
  }
  let code = typeof b.code === 'string' ? b.code : null;
  if (code === null) {
    if (status === 413 || status === 415) code = 'BAD_REQUEST';
    else if (status === 429) code = 'RATE_LIMITED';
    else if (status >= 500) code = 'UPSTREAM_ERROR';
    else code = 'BAD_REQUEST';
  }
  let retryable = RETRYABLE.has(code);
  if (!RELAY_ERROR_CODES.includes(code)) retryable = status >= 500; // unknown code: only server errors retry
  let retryAfterSeconds = null;
  if ((code === 'RATE_LIMITED' || code === 'IP_RATE_LIMITED') && r.retryAfter !== undefined && r.retryAfter !== null) {
    const n = Number(r.retryAfter);
    if (Number.isFinite(n) && n >= 0) retryAfterSeconds = n;
  }
  return { ok: false, retryable, code, retryAfterSeconds, txHash: null };
}

const KINDS_WITH_ID = ['Reserved', 'Settled', 'Refunded', 'AlreadyResolved'];

/**
 * Decodes a contract `PaymentResult` from raw JSON text or its base64 (SuccessValue) form.
 * @returns {{kind: string, requestId: bigint|null, code: string|null}}
 */
export function parseRequestResult(input) {
  if (typeof input !== 'string') throw new TypeError('input must be a string');
  const s = input.trim();
  let text = s;
  if (!s.startsWith('{') && !s.startsWith('[') && !s.startsWith('"')) {
    if (s.length === 0 || !B64.test(s) || s.length % 4 !== 0) throw new RangeError('invalid PaymentResult: not JSON or base64');
    text = Buffer.from(s, 'base64').toString('utf8');
  }
  // Quote request_id so u64 values above 2^53 survive JSON.parse.
  const safe = text.replace(/("request_id"\s*:\s*)(-?\d+)/g, '$1"$2"');
  let v;
  try { v = JSON.parse(safe); } catch { throw new RangeError('invalid PaymentResult: not JSON'); }
  if (v === null || typeof v !== 'object' || Array.isArray(v)) throw new RangeError('invalid PaymentResult: expected an object');
  const keys = Object.keys(v);
  if (keys.length !== 1) throw new RangeError('invalid PaymentResult: expected exactly one variant');
  const kind = keys[0];
  const inner = v[kind];
  if (inner === null || typeof inner !== 'object' || Array.isArray(inner)) throw new RangeError('invalid PaymentResult: bad variant body');
  if (KINDS_WITH_ID.includes(kind)) {
    if (typeof inner.request_id !== 'string' || !/^(0|[1-9][0-9]*)$/.test(inner.request_id)) {
      throw new RangeError('invalid PaymentResult: request_id must be a u64');
    }
    const id = BigInt(inner.request_id);
    if (id > U64_MAX) throw new RangeError('invalid PaymentResult: request_id out of u64 range');
    return { kind, requestId: id, code: null };
  }
  if (kind === 'Rejected') {
    if (!REJECT_CODES.includes(inner.code)) throw new RangeError(`invalid PaymentResult: unknown reject code ${String(inner.code)}`);
    return { kind, requestId: null, code: inner.code };
  }
  throw new RangeError(`invalid PaymentResult: unknown variant ${kind}`);
}
