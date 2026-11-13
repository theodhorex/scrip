// Hosted relayer (POST /api/relay on the web app): the facilitator's relay pipeline, unchanged, behind one
// extra gate. The facilitator needs a fixed agent allowlist; here the allowlist is "the agent of the mandate
// this delegate pays from": the sender must be the `agent` recorded on chain for `mandate_id`. Anyone with a
// mandate on the live contract can then pay gasless, and nobody else can make the relayer spend gas.
// The modules next to this file are byte-identical copies of facilitator/src (checked by a test), except
// store.mjs, which keeps the dedupe set in memory because a serverless instance has no durable disk.
import { loadPolicy, isTestnetId } from './policy.mjs';
import { decodeSignedDelegate, parseRequestPaymentArgs } from './validate.mjs';
import { makeRelayer, createSerialQueue } from './relay.mjs';
import { createKeyVerifier } from './keycheck.mjs';
import { createRateLimiter } from './ratelimit.mjs';
import { createDedupeStore } from './store.mjs';

export const MAX_BODY_BYTES = 16 * 1024;

/** Same HTTP mapping as facilitator/src/server.mjs, plus the hosted gate codes. */
export const STATUS = Object.freeze({
  RATE_LIMITED: 429, BUSY: 429, IP_RATE_LIMITED: 429, SERVER_BUSY: 503, UPSTREAM_ERROR: 502, RELAY_FAILED: 502, TX_FAILED: 502,
  RELAY_PENDING: 504, DUPLICATE_DELEGATE: 409, MANDATE_NOT_FOUND: 400, RELAYER_LOW_BALANCE: 503, RELAYER_NOT_CONFIGURED: 503,
});

const MANDATE_TTL_MS = 5000;

export function hostedPolicy(contractId, agentId) {
  return loadPolicy({
    network: 'testnet',
    contractId,
    allowedMethods: ['request_payment'],
    allowedAgents: [agentId],
    minGas: '60000000000000',
    maxGas: '100000000000000',
    maxBlockHeightWindow: 300,
    minBlockHeightMargin: 5,
    rateLimit: { capacity: 8, refillPerSecond: 1 },
    globalRateLimit: { capacity: 30, refillPerSecond: 0.5 },
  });
}

/**
 * @param {{provider: any, relayerAccount: any, contractId: string, minBalance?: bigint, relayerBalance?: () => Promise<bigint>, now?: () => number, rpcTimeoutMs?: number}} deps
 */
export function createHostedRelayer({ provider, relayerAccount, contractId, minBalance, relayerBalance, now = Date.now, rpcTimeoutMs = 15_000 }) {
  // Only contractId and allowedMethods matter to the key verifier; the agent here is a placeholder.
  const base = hostedPolicy(contractId, 'placeholder.testnet');
  const shared = {
    provider,
    relayerAccount,
    limiter: createRateLimiter({ ...base.rateLimit, now }),
    globalLimiter: createRateLimiter({ ...base.globalRateLimit, now, maxBuckets: 1 }),
    keyVerifier: createKeyVerifier({ provider, policy: base, now }),
    queue: createSerialQueue(32),
    store: createDedupeStore(),
    minBalance,
    relayerBalance,
    now,
    rpcTimeoutMs,
  };
  const mandates = new Map(); // mandate id -> { agent, at }

  async function agentOf(mandateId) {
    const key = String(mandateId);
    const hit = mandates.get(key);
    if (hit && now() - hit.at < MANDATE_TTL_MS) return hit.agent;
    let m;
    try {
      m = await provider.callFunction({ contractId, method: 'get_mandate', args: { id: Number(mandateId) } });
    } catch {
      return { error: 'UPSTREAM_ERROR' };
    }
    const agent = m && typeof m.agent === 'string' ? m.agent : null;
    mandates.set(key, { agent, at: now() });
    if (mandates.size > 1000) mandates.delete(mandates.keys().next().value);
    return agent;
  }

  return {
    contractId,
    /** -> the facilitator's relay result ({ ok, txHash, inner_status, ... } | { ok:false, code }) */
    async relay(b64) {
      const sd = decodeSignedDelegate(b64);
      if (!sd) return { ok: false, code: 'BAD_ENCODING' };
      const da = sd.delegateAction;
      if (da.receiverId !== contractId) return { ok: false, code: 'WRONG_RECEIVER' };
      const fc = da.actions.length === 1 ? da.actions[0].functionCall : undefined;
      if (!fc || fc.methodName !== 'request_payment') return { ok: false, code: 'METHOD_NOT_ALLOWED' };
      const args = parseRequestPaymentArgs(fc.args);
      if (!args.ok) return { ok: false, code: args.code };
      if (!isTestnetId(da.senderId)) return { ok: false, code: 'AGENT_NOT_ALLOWED' };

      const agent = await agentOf(args.call.mandateId);
      if (agent && typeof agent === 'object') return { ok: false, code: agent.error };
      if (agent === null) return { ok: false, code: 'MANDATE_NOT_FOUND' };
      if (agent !== da.senderId) return { ok: false, code: 'AGENT_NOT_ALLOWED', agentId: da.senderId };

      const relayer = makeRelayer({ ...shared, policy: hostedPolicy(contractId, da.senderId) });
      return relayer.relay(b64);
    },
  };
}

/** Relay result -> { status, body, headers }, the same response shape as the facilitator's POST /relay. */
export function toResponse(r) {
  if (r.ok) {
    return {
      status: 200,
      body: {
        ok: true,
        tx_hash: r.txHash,
        outer_tx_succeeded: r.outerSuccess === true,
        inner_status: r.inner_status,
        ...(r.inner_code ? { inner_code: r.inner_code } : {}),
        note: r.note,
      },
      headers: {},
    };
  }
  const headers = {};
  if (r.code === 'RATE_LIMITED' || r.code === 'BUSY' || r.code === 'IP_RATE_LIMITED') {
    headers['retry-after'] = String(Math.max(1, Math.ceil((r.retryAfterMs ?? 1000) / 1000)));
  }
  return { status: STATUS[r.code] ?? 400, body: { ok: false, code: r.code, ...(r.txHash ? { tx_hash: r.txHash } : {}) }, headers };
}
