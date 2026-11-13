// validateSignedDelegate: pure, offline checks of a base64 borsh SignedDelegate against a policy.
import { createHash } from 'node:crypto';
import { SCHEMA, KeyType, PublicKey, encodeDelegateAction, encodeSignedDelegate } from 'near-api-js';
// `deserialize` is not re-exported by near-api-js 7.4.0; `borsh` is its own (hoisted) dependency.
import { deserialize } from 'borsh';
import { isTestnetId } from './policy.mjs';

const MAX_BYTES = 8 * 1024;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;

const no = (code, detail) => ({ ok: false, code, detail });

// Strict NEAR account-id shape for call arguments (contract: AccountId; the allowlist itself
// lives in the mandate, the facilitator can only check the shape here).
const ACCOUNT_RE = /^(?:[a-z\d]+[-_.])*[a-z\d]{2,64}$/;
const U128_RE = /^(?:0|[1-9][0-9]*)$/;
const U64_RE = /^(?:0|[1-9][0-9]*)$/;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;
const B64_URL = /^[A-Za-z0-9_-]+$/;

/**
 * F-C: parse and validate the `request_payment` args buffer exactly like the contract expects:
 * {"mandate_id": u64, "recipient": AccountId, "amount": u128 decimal string, "nonce": u64}.
 * u64 fields may be JSON numbers or decimal strings. Unknown extra keys are rejected (fail closed).
 * @param {Uint8Array|undefined} args
 * @returns {{ok: true, call: {mandateId: bigint, recipient: string, amount: string, nonce: bigint}} | {ok: false, code: string, detail?: string}}
 */
export function parseRequestPaymentArgs(args) {
  let obj;
  try {
    const text = Buffer.from(args ?? []).toString('utf8');
    obj = JSON.parse(text);
  } catch {
    return no('BAD_CALL_ARGS', 'args are not valid JSON');
  }
  const okShape = (v, re) => typeof v === 'string' && re.test(v) && BigInt(v) <= (1n << 64n) - 1n;
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    return no('BAD_CALL_ARGS', 'args must be a JSON object');
  }
  const keys = Object.keys(obj).sort();
  if (keys.length !== 4 || keys.join() !== 'amount,mandate_id,nonce,recipient') {
    return no('BAD_CALL_ARGS', 'args must have exactly mandate_id, recipient, amount, nonce');
  }
  const mid = obj.mandate_id;
  if (!(okShape(mid, U64_RE) || (typeof mid === 'number' && Number.isSafeInteger(mid) && mid >= 0))) {
    return no('BAD_CALL_ARGS', 'mandate_id must be a u64');
  }
  const recipient = obj.recipient;
  if (typeof recipient !== 'string' || recipient.length === 0 || recipient.length > 64 || !ACCOUNT_RE.test(recipient)) {
    return no('BAD_CALL_ARGS', 'recipient must be a valid NEAR account id');
  }
  if (typeof obj.amount !== 'string' || !U128_RE.test(obj.amount) || BigInt(obj.amount) > U128_MAX) {
    return no('BAD_CALL_ARGS', 'amount must be a canonical u128 decimal string');
  }
  const nonce = obj.nonce;
  if (!(okShape(nonce, U64_RE) || (typeof nonce === 'number' && Number.isSafeInteger(nonce) && nonce >= 0))) {
    return no('BAD_CALL_ARGS', 'nonce must be a u64');
  }
  return {
    ok: true,
    call: { mandateId: BigInt(mid), recipient, amount: obj.amount, nonce: BigInt(nonce) },
  };
}


/** Strict decode: canonical base64, borsh parse, and exact re-encode round trip (no trailing bytes). */
export function decodeSignedDelegate(b64) {
  if (typeof b64 !== 'string' || b64.length === 0 || b64.length > MAX_BYTES * 2 || !B64.test(b64) || b64.length % 4 !== 0) return null;
  try {
    const bytes = Buffer.from(b64, 'base64');
    if (bytes.length > MAX_BYTES || bytes.toString('base64') !== b64) return null;
    const sd = deserialize(SCHEMA.SignedDelegate, bytes);
    if (Buffer.compare(Buffer.from(encodeSignedDelegate(sd)), bytes) !== 0) return null;
    return sd;
  } catch {
    return null;
  }
}

/** Height-dependent check. Returns null when fine, else a { ok:false, code } result. */
export function checkExpiry(maxBlockHeight, policy, currentBlockHeight) {
  const cur = BigInt(currentBlockHeight);
  if (maxBlockHeight < cur + BigInt(policy.minBlockHeightMargin)) return no('EXPIRES_TOO_SOON', 'delegate action expires too soon');
  if (maxBlockHeight > cur + BigInt(policy.maxBlockHeightWindow)) return no('EXPIRES_TOO_FAR', 'delegate action expires too far ahead');
  return null;
}

export function validateSignedDelegate(b64, policy, { currentBlockHeight } = {}) {
  const sd = decodeSignedDelegate(b64);
  if (!sd) return no('BAD_ENCODING', 'not a canonical base64 borsh SignedDelegate');
  const da = sd.delegateAction;
  const agentId = da.senderId;

  if (!isTestnetId(agentId) || (policy.allowedAgents && !policy.allowedAgents.includes(agentId))) {
    return no('AGENT_NOT_ALLOWED', 'sender is not an allowed agent');
  }
  if (da.receiverId !== policy.contractId) return no('WRONG_RECEIVER', 'receiver must be the policy contract');
  if (da.actions.length !== 1) return no('WRONG_ACTION_COUNT', 'exactly one action required');
  const fc = da.actions[0].functionCall;
  if (!fc) return no('NOT_FUNCTION_CALL', 'action must be a function call');
  if (!policy.allowedMethods.includes(fc.methodName)) return no('METHOD_NOT_ALLOWED', 'method is not allowed');

  if (fc.deposit !== 0n) return no('DEPOSIT_NOT_ZERO', 'deposit must be zero');
  if (fc.gas < policy.minGas) return no('GAS_TOO_LOW', 'gas is below the policy minimum');
  if (fc.gas > policy.maxGas) return no('GAS_TOO_HIGH', 'gas exceeds policy maximum');

  // F-C: parse the exact contract arguments (`request_payment`) after the cheap structural checks.
  let call;
  if (fc.methodName === 'request_payment') {
    const a = parseRequestPaymentArgs(fc.args);
    if (!a.ok) return no(a.code, a.detail);
    call = a.call;
  }

  // Without a height only the offline checks run (N-M1); the caller then applies checkExpiry once it has a height.
  if (currentBlockHeight !== undefined && currentBlockHeight !== null) {
    const e = checkExpiry(da.maxBlockHeight, policy, currentBlockHeight);
    if (e) return e;
  }
  if (da.nonce === 0n) return no('NONCE_INVALID', 'nonce must be non-zero');

  // Signature over sha256(prefix || borsh(DelegateAction)); ed25519 only.
  const keyData = da.publicKey.ed25519Key?.data;
  const sigData = sd.signature.ed25519Signature?.data;
  if (!keyData || !sigData) return no('BAD_SIGNATURE', 'only ed25519 keys are accepted');
  let valid = false;
  try {
    const hash = new Uint8Array(createHash('sha256').update(encodeDelegateAction(da)).digest());
    valid = new PublicKey({ keyType: KeyType.ED25519, data: Uint8Array.from(keyData) }).verify(hash, Uint8Array.from(sigData));
  } catch {
    valid = false;
  }
  if (!valid) return no('BAD_SIGNATURE', 'signature does not match the delegate action');

  const publicKey = new PublicKey({ keyType: KeyType.ED25519, data: Uint8Array.from(keyData) });
  return { ok: true, agentId, method: fc.methodName, signedDelegate: sd, publicKey, maxBlockHeight: da.maxBlockHeight, nonce: da.nonce, call };
}

function parseU64Field(v) {
  if (typeof v === 'bigint') return v >= 0n && v <= U64_MAX ? v : null;
  if (typeof v === 'number') return Number.isSafeInteger(v) && v >= 0 ? BigInt(v) : null;
  if (typeof v === 'string' && U64_RE.test(v)) {
    const b = BigInt(v);
    return b <= U64_MAX ? b : null;
  }
  return null;
}

function parseMandateRequirement(mandate, extra, topObj) {
  if (mandate === undefined || mandate === null) return null;
  let expectedContractId;
  let expectedMandateId;

  const idVal = parseU64Field(mandate);
  if (idVal !== null) {
    expectedMandateId = idVal;
  } else if (typeof mandate === 'string') {
    const sep = mandate.includes(':') ? ':' : (mandate.includes('#') ? '#' : null);
    if (sep) {
      const parts = mandate.split(sep);
      if (parts.length !== 2 || !isTestnetId(parts[0])) return null;
      const mid = parseU64Field(parts[1]);
      if (mid === null) return null;
      expectedContractId = parts[0];
      expectedMandateId = mid;
    } else if (isTestnetId(mandate)) {
      expectedContractId = mandate;
    } else {
      return null;
    }
  } else if (typeof mandate === 'object' && !Array.isArray(mandate)) {
    const cid = mandate.contractId ?? mandate.contract_id;
    const midRaw = mandate.mandateId ?? mandate.mandate_id ?? mandate.id;
    if (cid !== undefined) {
      if (!isTestnetId(cid)) return null;
      expectedContractId = cid;
    }
    if (midRaw !== undefined) {
      const mid = parseU64Field(midRaw);
      if (mid === null) return null;
      expectedMandateId = mid;
    }
    if (expectedContractId === undefined && expectedMandateId === undefined) return null;
  } else {
    return null;
  }

  const extraCid = topObj?.contractId ?? extra?.mandateContract;
  if (extraCid !== undefined) {
    if (!isTestnetId(extraCid)) return null;
    if (expectedContractId !== undefined && expectedContractId !== extraCid) return null;
    expectedContractId = extraCid;
  }
  const extraMidRaw = topObj?.mandateId ?? extra?.mandateId;
  if (extraMidRaw !== undefined) {
    const mid = parseU64Field(extraMidRaw);
    if (mid === null) return null;
    if (expectedMandateId !== undefined && expectedMandateId !== mid) return null;
    expectedMandateId = mid;
  }

  return { expectedContractId, expectedMandateId };
}

function validateRequirementsObj(reqs) {
  if (reqs === null || reqs === undefined || typeof reqs !== 'object' || Array.isArray(reqs)) {
    return no('BAD_PAYMENT_REQUIREMENTS', 'paymentRequirements must be a JSON object');
  }
  if (reqs.scheme !== undefined && reqs.scheme !== 'scrip') {
    return no('UNSUPPORTED_SCHEME', 'scheme must be scrip');
  }
  if (reqs.network !== undefined && reqs.network !== 'near:testnet' && reqs.network !== 'testnet') {
    return no('UNSUPPORTED_NETWORK', 'network must be near:testnet');
  }
  if (typeof reqs.payTo !== 'string' || reqs.payTo.length < 2 || reqs.payTo.length > 64 || !ACCOUNT_RE.test(reqs.payTo)) {
    return no('BAD_PAYMENT_REQUIREMENTS', 'payTo must be a valid NEAR account id');
  }
  if (typeof reqs.amount !== 'string' || !U128_RE.test(reqs.amount) || BigInt(reqs.amount) > U128_MAX) {
    return no('BAD_PAYMENT_REQUIREMENTS', 'amount must be a canonical u128 decimal string');
  }
  if (typeof reqs.asset !== 'string' || reqs.asset.length < 2 || reqs.asset.length > 64 || !ACCOUNT_RE.test(reqs.asset)) {
    return no('BAD_PAYMENT_REQUIREMENTS', 'asset must be a valid NEAR account id');
  }
  if (reqs.maxTimeoutSeconds !== undefined) {
    if (typeof reqs.maxTimeoutSeconds !== 'number' || !Number.isFinite(reqs.maxTimeoutSeconds) || reqs.maxTimeoutSeconds <= 0) {
      return no('BAD_PAYMENT_REQUIREMENTS', 'maxTimeoutSeconds must be a positive number');
    }
  }
  const m = parseMandateRequirement(reqs.mandate, reqs.extra, reqs);
  if (!m) {
    return no('BAD_PAYMENT_REQUIREMENTS', 'mandate is required and must be a valid mandate id or contract spec');
  }
  return {
    ok: true,
    requirements: {
      payTo: reqs.payTo,
      amount: reqs.amount,
      asset: reqs.asset,
      maxTimeoutSeconds: reqs.maxTimeoutSeconds,
      expectedContractId: m.expectedContractId,
      expectedMandateId: m.expectedMandateId,
    },
  };
}

function decodeBase64Json(raw) {
  const s = raw.trim();
  if (s.length === 0 || s.length > MAX_BYTES * 2) return null;
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  if (!B64.test(b64) || b64.length % 4 !== 0) return null;
  try {
    const text = Buffer.from(b64, 'base64').toString('utf8');
    const obj = JSON.parse(text);
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) return null;
    return obj;
  } catch {
    return null;
  }
}

/**
 * F-E: Decodes and validates the x402-style `PAYMENT-SIGNATURE` HTTP header (base64 JSON)
 * and extracts the signed delegate base64 plus validated `paymentRequirements`.
 * Source: https://github.com/x402-foundation/x402/blob/2aa22d3e6a38547a8232737599d9f519c9ac5533/specs/schemes/exact/scheme_exact_near.md
 */
export function parsePaymentSignatureHeader(headerValue, bodyRequirements) {
  if (headerValue === undefined || headerValue === null || typeof headerValue !== 'string' || headerValue.trim() === '') {
    return no('MISSING_PAYMENT_SIGNATURE', 'PAYMENT-SIGNATURE header is required');
  }
  const sigObj = decodeBase64Json(headerValue);
  if (!sigObj) return no('BAD_PAYMENT_SIGNATURE', 'PAYMENT-SIGNATURE must be base64-encoded JSON object');
  if (sigObj.x402Version !== undefined && sigObj.x402Version !== 2) {
    return no('BAD_PAYMENT_SIGNATURE', 'x402Version must be 2');
  }
  if (sigObj.scheme !== undefined && sigObj.scheme !== 'scrip') {
    return no('UNSUPPORTED_SCHEME', 'scheme must be scrip');
  }
  if (sigObj.network !== undefined && sigObj.network !== 'near:testnet' && sigObj.network !== 'testnet') {
    return no('UNSUPPORTED_NETWORK', 'network must be near:testnet');
  }

  const sdB64 = sigObj?.payload?.signedDelegateAction
    ?? sigObj?.signedDelegateAction
    ?? sigObj?.signed_delegate
    ?? sigObj?.signedDelegate;
  if (typeof sdB64 !== 'string' || sdB64.length === 0) {
    return no('BAD_PAYMENT_SIGNATURE', 'missing signed delegate in PAYMENT-SIGNATURE');
  }

  const hdrReqsRaw = sigObj.paymentRequirements ?? sigObj.accepted;
  if (bodyRequirements !== undefined) {
    const auth = validateRequirementsObj(bodyRequirements);
    if (!auth.ok) return auth;
    if (hdrReqsRaw !== undefined) {
      const hdr = validateRequirementsObj(hdrReqsRaw);
      if (!hdr.ok) return hdr;
      if (hdr.requirements.payTo !== auth.requirements.payTo) return no('RECIPIENT_MISMATCH', 'header payTo disagrees with requirements');
      if (hdr.requirements.amount !== auth.requirements.amount) return no('AMOUNT_MISMATCH', 'header amount disagrees with requirements');
      if (hdr.requirements.asset !== auth.requirements.asset) return no('BAD_PAYMENT_REQUIREMENTS', 'header asset disagrees with requirements');
      if (hdr.requirements.expectedContractId !== undefined && auth.requirements.expectedContractId !== undefined
        && hdr.requirements.expectedContractId !== auth.requirements.expectedContractId) {
        return no('MANDATE_MISMATCH', 'header mandate contract disagrees with requirements');
      }
      if (hdr.requirements.expectedMandateId !== undefined && auth.requirements.expectedMandateId !== undefined
        && hdr.requirements.expectedMandateId !== auth.requirements.expectedMandateId) {
        return no('MANDATE_MISMATCH', 'header mandateId disagrees with requirements');
      }
    }
    return { ok: true, signedDelegateBase64: sdB64, requirements: auth.requirements };
  }

  const hdr = validateRequirementsObj(hdrReqsRaw);
  if (!hdr.ok) return hdr;
  return { ok: true, signedDelegateBase64: sdB64, requirements: hdr.requirements };
}

/**
 * F-E: Matches parsed `request_payment` call arguments against validated `paymentRequirements`.
 */
export function matchPaymentRequirements(call, requirements, policy) {
  if (!call) return no('METHOD_NOT_ALLOWED', 'payment delegate must call request_payment');
  if (requirements.expectedContractId !== undefined && policy?.contractId && requirements.expectedContractId !== policy.contractId) {
    return no('MANDATE_MISMATCH', 'mandate contract does not match policy contract');
  }
  if (requirements.expectedMandateId !== undefined && call.mandateId !== requirements.expectedMandateId) {
    return no('MANDATE_MISMATCH', 'mandate_id does not match paymentRequirements');
  }
  if (call.recipient !== requirements.payTo) {
    return no('RECIPIENT_MISMATCH', 'recipient does not match paymentRequirements.payTo');
  }
  if (call.amount !== requirements.amount) {
    return no('AMOUNT_MISMATCH', 'amount does not match paymentRequirements.amount');
  }
  return { ok: true };
}
