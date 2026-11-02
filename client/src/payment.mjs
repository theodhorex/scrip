// x402-style client payment helpers for Scrip.
// Source: https://github.com/x402-foundation/x402/blob/2aa22d3e6a38547a8232737599d9f519c9ac5533/specs/schemes/exact/scheme_exact_near.md
import { buildRequestPayment, signDelegate, DEFAULT_GAS } from './delegate.mjs';
import { checkRecipient, toU128, toU64 } from './intent.mjs';

const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const B64_URL = /^[A-Za-z0-9_-]+$/;

function decodeB64OrJson(input) {
  if (typeof input !== 'string') return null;
  const s = input.trim();
  if (s.length === 0) return null;
  if (s.startsWith('{') || s.startsWith('[')) {
    try {
      return JSON.parse(s);
    } catch {
      return null;
    }
  }
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  if (!B64.test(b64) || b64.length % 4 !== 0) return null;
  try {
    const text = Buffer.from(b64, 'base64').toString('utf8');
    return JSON.parse(text);
  } catch {
    return null;
  }
}

/**
 * Builds and signs an x402-style PAYMENT-SIGNATURE payload containing an Scrip NEP-366 DelegateAction.
 *
 * @param {object} requirements - paymentRequirements ({ payTo, amount, asset, mandate, maxTimeoutSeconds, extra })
 * @param {object} options - { agentId, keyPair, nonce, maxBlockHeight, contractId?, requestNonce?, gas?, network?, scheme? }
 * @returns {Promise<{header: string, base64: string, payload: object, signedDelegate: object, toString(): string}>}
 */
export async function buildPaymentSignature(requirements, options = {}) {
  if (requirements === null || typeof requirements !== 'object' || Array.isArray(requirements)) {
    throw new TypeError('requirements must be an object');
  }
  if (options === null || typeof options !== 'object' || Array.isArray(options)) {
    throw new TypeError('options must be an object');
  }

  const payTo = requirements.payTo;
  if (!payTo || typeof payTo !== 'string') {
    throw new TypeError('payTo must be a non-empty string');
  }
  checkRecipient(payTo);

  toU128(requirements.amount, 'amount');
  const amountStr = String(requirements.amount);

  if (typeof requirements.asset !== 'string' || requirements.asset.length === 0) {
    throw new TypeError('asset must be a non-empty string');
  }

  const rawMandate = requirements.mandate
    ?? requirements.mandateId
    ?? requirements.extra?.mandateId
    ?? requirements.extra?.mandate;
  if (rawMandate === undefined || rawMandate === null) {
    throw new TypeError('mandate must be specified in requirements or requirements.extra');
  }
  const mandateId = toU64(rawMandate, 'mandate');

  const agentId = options.agentId;
  if (typeof agentId !== 'string' || agentId.length === 0) {
    throw new TypeError('agentId must be a non-empty string');
  }

  const keyPair = options.keyPair;
  if (!keyPair || typeof keyPair.getPublicKey !== 'function') {
    throw new TypeError('keyPair must be a near-api-js KeyPair');
  }

  const contractId = options.contractId
    ?? requirements.extra?.contractId
    ?? requirements.extra?.mandateContract
    ?? requirements.contractId;
  if (typeof contractId !== 'string' || contractId.length === 0) {
    throw new TypeError('contractId must be a non-empty string (passed in options or requirements.extra.contractId)');
  }

  const requestNonce = options.requestNonce !== undefined ? toU64(options.requestNonce, 'requestNonce') : 1n;
  const gas = options.gas ?? DEFAULT_GAS;

  const action = buildRequestPayment({
    contractId,
    mandateId,
    recipient: payTo,
    amount: amountStr,
    nonce: requestNonce,
    gas,
  });

  const nonce = toU64(options.nonce, 'nonce');
  const maxBlockHeight = toU64(options.maxBlockHeight, 'maxBlockHeight');

  const signed = await signDelegate({
    agentId,
    contractId,
    action,
    nonce,
    maxBlockHeight,
    keyPair,
  });

  const scheme = options.scheme ?? requirements.scheme ?? 'scrip';
  const network = options.network ?? requirements.network ?? 'near:testnet';

  const payload = {
    x402Version: 2,
    scheme,
    network,
    payload: {
      signedDelegateAction: signed.base64,
    },
    paymentRequirements: requirements,
  };

  const base64 = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64');

  const res = {
    header: base64,
    base64,
    payload,
    signedDelegate: signed.signedDelegate,
    toString() {
      return this.base64;
    },
    [Symbol.toPrimitive]() {
      return this.base64;
    },
  };

  return res;
}

/**
 * Parses an x402-style payment settlement response or PAYMENT-RESPONSE HTTP header.
 *
 * @param {string|object} responseOrHeader
 * @returns {{ok: boolean, success: boolean, txHash: string|null, inner_status: string|null, inner_code: string|null, payer: string|null, raw: any, code?: string}}
 */
export function parsePaymentResponse(responseOrHeader) {
  if (responseOrHeader === null || responseOrHeader === undefined) {
    throw new TypeError('responseOrHeader is required');
  }

  let obj = null;

  if (typeof responseOrHeader === 'string') {
    obj = decodeB64OrJson(responseOrHeader);
    if (!obj) {
      throw new RangeError('invalid payment response: not valid JSON or base64 JSON');
    }
  } else if (typeof responseOrHeader === 'object') {
    // Check if it's a fetch Response-like object with headers
    if (responseOrHeader.headers && typeof responseOrHeader.headers.get === 'function') {
      const hdr = responseOrHeader.headers.get('payment-response');
      if (hdr) {
        obj = decodeB64OrJson(hdr);
      }
    }
    if (!obj && responseOrHeader.body !== undefined) {
      if (typeof responseOrHeader.body === 'string') {
        obj = decodeB64OrJson(responseOrHeader.body);
      } else if (typeof responseOrHeader.body === 'object' && responseOrHeader.body !== null) {
        obj = responseOrHeader.body;
      }
    }
    if (!obj) {
      obj = responseOrHeader;
    }
  }

  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
    throw new RangeError('invalid payment response format');
  }

  const txHash = obj.tx_hash ?? obj.txHash ?? obj.transaction ?? null;
  const inner_status = obj.inner_status ?? null;
  const inner_code = obj.inner_code ?? null;
  const payer = obj.payer ?? null;

  const isSuccess = obj.success === true || (obj.ok === true && (inner_status === 'Settled' || inner_status === 'Reserved' || !inner_status));
  const isOk = obj.ok !== false && (typeof obj.status !== 'number' || obj.status === 200 || obj.status === 201);

  const res = {
    ok: isOk && (obj.ok === true || obj.success === true || (isSuccess && !obj.code)),
    success: isSuccess,
    txHash: typeof txHash === 'string' ? txHash : null,
    inner_status,
    inner_code,
    payer,
    raw: obj,
  };

  if (!res.ok) {
    res.code = obj.code ?? obj.invalidReason ?? obj.errorReason ?? 'PAYMENT_FAILED';
  }

  return res;
}
