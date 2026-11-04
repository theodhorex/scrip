// Layer E helpers for category 6 (delegate/key attacks through the facilitator /relay) and
// category 11 (direct ft_on_transfer). Pure, offline-testable: no network here.
//
// Why this exists (CORRECTIONS_E_CAT1_6_7_11.md): the relay path used to ignore keyAllowedMethods,
// keyType, keyAllowance, keyReceiverId, delegateReceiverId, maxBlockHeight, actionsCount and
// invalidSignature, so those attacks were never sent and every case ended "Transaction confirmed".
import * as nearApi from 'near-api-js';

const { KeyPairSigner, buildDelegateAction, encodeSignedDelegate, actions } = nearApi;

const isUint = (v) => (typeof v === 'number' && Number.isSafeInteger(v) && v >= 0) || (typeof v === 'bigint' && v >= 0n)
  || (typeof v === 'string' && /^(?:0|[1-9][0-9]*)$/.test(v));

/**
 * Turns case params into an explicit attack plan. Fails closed: a malformed param throws instead of
 * silently falling back to a legitimate delegate (which would make the attack INERT).
 * @returns {{keySpec: null|{kind:'FullAccess'}|{kind:'FunctionCall', methodNames:string[], receiverId:string|null, allowance:bigint|null},
 *   forgedKey:boolean, delegateReceiverId:string|null, nonce:bigint|null, maxBlockHeight:bigint|null,
 *   actionsCount:number, tamperPayload:boolean}}
 */
export function planRelayAttack(p = {}) {
  let keySpec = null;
  if (p.keyType !== undefined && p.keyType !== 'FullAccess' && p.keyType !== 'FunctionCall') {
    throw new Error(`unknown keyType ${p.keyType}`);
  }
  if (p.keyType === 'FullAccess') {
    keySpec = { kind: 'FullAccess' };
  } else if (p.keyAllowedMethods !== undefined || p.keyReceiverId !== undefined || p.keyAllowance !== undefined || p.keyType === 'FunctionCall') {
    if (p.keyAllowedMethods !== undefined && (!Array.isArray(p.keyAllowedMethods) || p.keyAllowedMethods.length === 0
      || p.keyAllowedMethods.some((m) => typeof m !== 'string' || m === ''))) {
      throw new Error('keyAllowedMethods must be a non-empty array of method names');
    }
    if (p.keyAllowance !== undefined && !isUint(p.keyAllowance)) throw new Error('keyAllowance must be a yocto integer');
    keySpec = {
      kind: 'FunctionCall',
      methodNames: p.keyAllowedMethods ?? ['request_payment'],
      receiverId: p.keyReceiverId ?? null,
      allowance: p.keyAllowance === undefined ? null : BigInt(p.keyAllowance),
    };
  }
  if (p.nonce !== undefined && !isUint(p.nonce)) throw new Error('nonce must be an unsigned integer');
  if (p.maxBlockHeight !== undefined && !isUint(p.maxBlockHeight)) throw new Error('maxBlockHeight must be an unsigned integer');
  if (p.actionsCount !== undefined && !(Number.isInteger(p.actionsCount) && p.actionsCount >= 0 && p.actionsCount <= 8)) {
    throw new Error('actionsCount must be an integer in 0..8');
  }
  if (p.delegateReceiverId !== undefined && (typeof p.delegateReceiverId !== 'string' || p.delegateReceiverId === '')) {
    throw new Error('delegateReceiverId must be a non-empty string');
  }
  return {
    keySpec,
    forgedKey: p.forgedKey === true,
    delegateReceiverId: p.delegateReceiverId ?? null,
    nonce: p.nonce === undefined ? null : BigInt(p.nonce),
    maxBlockHeight: p.maxBlockHeight === undefined ? null : BigInt(p.maxBlockHeight),
    actionsCount: p.actionsCount ?? 1,
    tamperPayload: p.invalidSignature === true,
  };
}

/** Payload altered AFTER signing: the signature no longer matches borsh(DelegateAction). */
export function tamperSignedDelegate(signedDelegate) {
  signedDelegate.delegateAction.nonce += 1n;
  return signedDelegate;
}

/**
 * Builds the base64 SignedDelegate that really carries the attack described by `plan`.
 * @param {object} o
 * @param {ReturnType<typeof planRelayAttack>} o.plan
 * @param {object} o.keyPair signing key (the key under attack: new restricted/full key, forged key or agent fcKey)
 * @param {string} o.senderId delegate sender (agent account)
 * @param {string} o.contractId legitimate receiver
 * @param {bigint|number} o.onChainNonce current nonce of the signing key (0 for unknown keys)
 * @param {bigint|number} o.headHeight current block height
 * @param {string} o.method @param {object} o.args @param {bigint} o.gas
 */
export async function buildAttackDelegate({ plan, keyPair, senderId, contractId, onChainNonce, headHeight, method, args, gas }) {
  const signer = new KeyPairSigner(keyPair);
  const publicKey = await signer.getPublicKey();
  // NEAR access-key nonces are block-height based, so a literal nonce of 1 is NONCE_TOO_LOW:
  // only a case that sets a nonce on purpose overrides "on-chain + 1".
  const nonce = plan.nonce !== null ? plan.nonce : BigInt(onChainNonce) + 1n;
  const maxBlockHeight = plan.maxBlockHeight !== null ? plan.maxBlockHeight : BigInt(headHeight) + 100n;
  const delegate = buildDelegateAction({
    senderId,
    receiverId: plan.delegateReceiverId ?? contractId,
    nonce,
    maxBlockHeight,
    publicKey,
    actions: Array.from({ length: plan.actionsCount }, () => actions.functionCall(method, args, gas, 0n)),
  });
  const signed = await signer.signDelegateAction(delegate);
  const sd = plan.tamperPayload ? tamperSignedDelegate(signed.signedDelegate) : signed.signedDelegate;
  return { b64: Buffer.from(encodeSignedDelegate(sd)).toString('base64'), nonce, maxBlockHeight };
}

/** SuccessValue of a FinalExecutionOutcome decoded from base64 JSON (null when absent/unparseable). */
export function readSuccessValue(txRes) {
  const raw = txRes?.status?.SuccessValue;
  if (typeof raw !== 'string' || raw === '') return null;
  try {
    return JSON.parse(Buffer.from(raw, 'base64').toString('utf8'));
  } catch {
    return null;
  }
}

/**
 * ft_on_transfer never panics (lib.rs:455-456, 463-473): a wrong predecessor, wrong sender, bad msg, unknown or
 * inactive mandate all return the FULL amount as "unused" and emit nothing. So the only observable proof of a
 * block is: return value == amount AND no `deposited` event AND mandate state unchanged.
 * Anything else is not claimed as BLOCKED.
 * @returns {{label:'BLOCKED'|'INERT'|'BREACH', code?:string, note:string}}
 */
export function classifyFtOnTransfer(txRes, amount, { stateUnchanged }) {
  const ret = readSuccessValue(txRes);
  const logs = txRes?.receipts_outcome?.flatMap((o) => o?.outcome?.logs ?? []) ?? [];
  const deposited = logs.some((l) => typeof l === 'string' && l.startsWith('EVENT_JSON:') && l.includes('"deposited"'));
  if (txRes?.status?.Failure) return { label: 'BLOCKED', code: 'CALL_FAILED', note: 'ft_on_transfer failed at VM level' };
  if (ret === String(amount) && !deposited && stateUnchanged) {
    return { label: 'BLOCKED', code: 'FULL_REFUND', note: `ft_on_transfer returned the full amount ${amount} unused; no deposited event; state unchanged (lib.rs:463-473)` };
  }
  if (deposited || ret === '0') {
    return stateUnchanged
      ? { label: 'INERT', note: 'ft_on_transfer reported a deposit but state is unchanged' }
      : { label: 'BREACH', code: 'UNAUTHORIZED_DEPOSIT', note: 'ft_on_transfer from a non-token caller changed mandate state' };
  }
  return { label: 'INERT', note: `unclassified ft_on_transfer result ${JSON.stringify(ret)}` };
}

/** Symbolic name of the real, registered token in the case files; only the token contract itself can be its predecessor. */
export const LEGIT_TOKEN_SYMBOL = 'usdc.testnet';
export const isLegitTokenCaller = (name) => name === LEGIT_TOKEN_SYMBOL;

/**
 * Classifies a REAL token-originated deposit (funder calls ft_transfer_call on the USDC contract, so the token is the
 * true predecessor of ft_on_transfer). Pure: every reading is passed in; a reading that is missing (null/undefined) means
 * the proof could not be read, which is infrastructure, never a verdict.
 *   FULL_REFUND  only when ALL hold: sender USDC unchanged, contract USDC unchanged, no `deposited` event, mandate unchanged.
 *   accepted     deposit landed consistently (sender -amount, contract +amount, deposited event or mandate change): INERT.
 *   inconsistent sender and contract deltas that do not mirror each other (funds lost or created): BREACH.
 */
export function classifyTokenCallerOutcome({ amount, senderBefore, senderAfter, contractBefore, contractAfter, logs, mandateBefore, mandateAfter }) {
  const readings = [senderBefore, senderAfter, contractBefore, contractAfter];
  if (readings.some((v) => v === null || v === undefined) || mandateBefore === undefined || mandateAfter === undefined || !Array.isArray(logs)) {
    return { label: 'SKIPPED', code: 'INFRA_ERROR', note: 'a refund proof could not be read (RPC/network); not a verdict, rerun' };
  }
  const snap = (m) => (m ? JSON.stringify(m, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : null);
  const senderDelta = BigInt(senderAfter) - BigInt(senderBefore);
  const contractDelta = BigInt(contractAfter) - BigInt(contractBefore);
  const depositedEvent = logs.some((l) => typeof l === 'string' && l.startsWith('EVENT_JSON:') && l.includes('"deposited"'));
  const mandateChanged = snap(mandateBefore) !== snap(mandateAfter);
  if (senderDelta !== -contractDelta) {
    return { label: 'BREACH', code: 'LEDGER_MISMATCH', note: `sender delta ${senderDelta} and contract delta ${contractDelta} do not mirror each other` };
  }
  if (senderDelta === 0n && contractDelta === 0n && !depositedEvent && !mandateChanged) {
    return { label: 'BLOCKED', code: 'FULL_REFUND', note: `full refund proven: sender USDC unchanged, contract USDC unchanged, no deposited event, mandate unchanged (amount ${amount})` };
  }
  if (contractDelta === BigInt(amount) && (depositedEvent || mandateChanged)) {
    return { label: 'INERT', note: `deposit of ${amount} accepted by the contract (sender -${amount}, contract +${amount})` };
  }
  return { label: 'BREACH', code: 'PARTIAL_OR_UNEXPLAINED', note: `unexpected outcome: senderDelta=${senderDelta} contractDelta=${contractDelta} depositedEvent=${depositedEvent} mandateChanged=${mandateChanged}` };
}
