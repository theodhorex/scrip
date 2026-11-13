// Relayer: decode + validate offline -> dedupe -> read height (cached ~1 s) -> expiry -> verify access key ->
// rate-limit (agent, global) -> serialized submit. All deps injected.
import { createHash } from 'node:crypto';
import { validateSignedDelegate, checkExpiry } from './validate.mjs';
import { createKeyVerifier } from './keycheck.mjs';
import { extractInnerStatus } from './inner_status.mjs';
import { createDedupeStore } from './store.mjs';

export const OUTER_NOTE = 'ok means the outer transaction (relay of the delegate) succeeded; the inner function-call result (e.g. request_payment) is NOT checked here: read it from the chain events/receipts via tx_hash. Do not treat this as proof of payment.';

const HEIGHT_TTL_MS = 1000;
const DEDUPE_MAX = 10_000;
const DEFAULT_RPC_TIMEOUT_MS = 15_000;

function withTimeout(promise, ms) {
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => {
      const err = new Error(`RPC call timed out after ${ms}ms`);
      err.code = 'ETIMEDOUT';
      reject(err);
    }, ms);
  });
  return Promise.race([
    promise.finally(() => clearTimeout(timer)),
    timeoutPromise,
  ]);
}

/** Single-flight promise chain: tasks run strictly one after another, a failing task never blocks the next. */
export function createSerialQueue(options = 32) {
  const maxLength = typeof options === 'number' ? options : (options?.maxLength ?? 32);
  let tail = Promise.resolve();
  let length = 0;
  return {
    get length() { return length; },
    get maxLength() { return maxLength; },
    run(fn) {
      if (length >= maxLength) {
        const err = new Error('BUSY');
        err.code = 'BUSY';
        return Promise.reject(err);
      }
      length++;
      const p = tail.then(fn, fn);
      tail = p.then(
        () => { length--; },
        () => { length--; },
      );
      return p;
    },
  };
}

// A timeout / connection drop during the broadcast means the tx may have landed. Anything else (rejected
// nonce, rpc error response, signing failure) is treated as "not broadcast": token refunded, retry allowed.
const AMBIGUOUS_CODES = ['ETIMEDOUT', 'ECONNRESET', 'ECONNABORTED', 'EPIPE', 'UND_ERR_SOCKET', 'UND_ERR_HEADERS_TIMEOUT', 'UND_ERR_BODY_TIMEOUT'];
export function isAmbiguousFailure(e) {
  const name = `${e?.constructor?.name ?? ''} ${e?.name ?? ''}`;
  return /timeout|timed out|abort/i.test(name) || /timeout|timed out/i.test(String(e?.message ?? '')) || AMBIGUOUS_CODES.includes(e?.code) || e?.ambiguous === true;
}

export function makeRelayer({
  provider,
  relayerAccount,
  policy,
  limiter,
  globalLimiter,
  keyVerifier = createKeyVerifier({ provider, policy }),
  maxQueueLength = 32,
  queue = createSerialQueue(maxQueueLength),
  now = Date.now,
  dedupeMax = DEDUPE_MAX,
  minBalance,
  relayerBalance,
  dbPath,
  store = createDedupeStore(dbPath ?? ':memory:'),
  rpcTimeoutMs = DEFAULT_RPC_TIMEOUT_MS,
}) {
  let heightCache = null; // { promise, at }
  let lastHeight = 0;
  // F-C: cached relayer balance (TTL ~1 s). Checked on every relay when minBalance is set.
  const BAL_TTL_MS = 1000;
  let balanceCache = null; // { value, at }
  // N3-I1: short cache for mandate token lookups (~5 s).
  const MANDATE_TTL_MS = 5000;
  const mandateCache = new Map(); // `${contractId}:${mandateId}` -> { mandate, at }

  async function getMandate(mandateId) {
    const cid = policy.contractId;
    const key = `${cid}:${mandateId}`;
    const t = now();
    const cached = mandateCache.get(key);
    if (cached && (t - cached.at) < MANDATE_TTL_MS) {
      return cached.mandate;
    }

    let m = null;
    try {
      const mid = Number(mandateId);
      if (typeof provider.callFunction === 'function') {
        m = await withTimeout(
          provider.callFunction({
            contractId: cid,
            method: 'get_mandate',
            args: { id: mid },
          }),
          rpcTimeoutMs,
        );
      } else if (typeof provider.query === 'function') {
        const q = await withTimeout(
          provider.query({
            request_type: 'call_function',
            finality: 'final',
            account_id: cid,
            method_name: 'get_mandate',
            args_base64: Buffer.from(JSON.stringify({ id: mid })).toString('base64'),
          }),
          rpcTimeoutMs,
        );
        if (q?.result && Array.isArray(q.result)) {
          const text = Buffer.from(q.result).toString('utf8');
          m = text ? JSON.parse(text) : null;
        }
      }
    } catch {
      const err = new Error('UPSTREAM_ERROR');
      err.code = 'UPSTREAM_ERROR';
      throw err;
    }

    if (!m) return null;
    mandateCache.set(key, { mandate: m, at: t });
    if (mandateCache.size > 1000) {
      mandateCache.delete(mandateCache.keys().next().value);
    }
    return m;
  }

  async function checkMandateAsset(mandateId, expectedAsset) {
    let m;
    try {
      m = await getMandate(mandateId);
    } catch {
      return { ok: false, code: 'UPSTREAM_ERROR' };
    }
    if (!m) {
      return { ok: false, code: 'MANDATE_NOT_FOUND' };
    }
    if (!m.token || m.token !== expectedAsset) {
      return { ok: false, code: 'ASSET_MISMATCH', token: m.token, expectedAsset };
    }
    return { ok: true, mandate: m };
  }
  async function getRelayerBalance() {
    const t = now();
    if (balanceCache && t - balanceCache.at < BAL_TTL_MS) return balanceCache.value;
    const value = BigInt((await relayerBalance()) ?? 0);
    balanceCache = { value, at: t };
    return value;
  }
  function getHeight() {
    const t = now();
    if (heightCache && t - heightCache.at < HEIGHT_TTL_MS) return heightCache.promise;
    const entry = {
      at: t,
      promise: (async () => {
        const block = await withTimeout(provider.viewBlock({ finality: 'final' }), rpcTimeoutMs); // F-C: only a final height is honest
        const h = block?.header?.height;
        if (typeof h !== 'number' || !Number.isSafeInteger(h) || h <= 0) throw new Error('bad height');
        lastHeight = Math.max(lastHeight, h);
        return h;
      })(),
    };
    heightCache = entry;
    entry.promise.catch(() => { if (heightCache === entry) heightCache = null; }); // failures are never cached
    return entry.promise;
  }

  function prune() {
    store.prune(lastHeight);
    store.bound(dedupeMax);
  }

  async function preflight(signedDelegateBase64, { maxTimeoutSeconds } = {}) {
    // 1) Everything that needs no network (N-M1): encoding, agent, method, gas, signature.
    const v = validateSignedDelegate(signedDelegateBase64, policy);
    if (!v.ok) return { ok: false, code: v.code, detail: v.detail };

    // 2) Replay dedupe (N-L2): no RPC, no bucket token, no relayer gas.
    const dh = createHash('sha256').update(signedDelegateBase64).digest('hex');
    const dup = store.get(dh);
    if (dup) return { ok: false, code: 'DUPLICATE_DELEGATE', txHash: dup.txHash, agentId: v.agentId };

    let currentBlockHeight;
    try {
      currentBlockHeight = await getHeight();
    } catch {
      return { ok: false, code: 'UPSTREAM_ERROR' };
    }
    const ex = checkExpiry(v.maxBlockHeight, policy, currentBlockHeight);
    if (ex) return { ok: false, code: ex.code, detail: ex.detail };
    if (maxTimeoutSeconds !== undefined) {
      const timeoutBlocks = BigInt(Math.max(1, Math.ceil(maxTimeoutSeconds)));
      if (v.maxBlockHeight > BigInt(currentBlockHeight) + timeoutBlocks) {
        return { ok: false, code: 'EXPIRES_TOO_FAR', detail: 'delegate timeout exceeds maxTimeoutSeconds' };
      }
    }

    // The key must be a real restricted access key of senderId BEFORE any token is spent (F2).
    let k;
    try {
      k = await withTimeout(keyVerifier.check(v.agentId, v.publicKey), rpcTimeoutMs);
    } catch {
      return { ok: false, code: 'UPSTREAM_ERROR', agentId: v.agentId };
    }
    if (!k.ok) {
      keyVerifier.evict(v.agentId, v.publicKey);
      return { ok: false, code: k.code, agentId: v.agentId };
    }

    // F-C: the delegate nonce must be strictly above the access-key's current on-chain nonce.
    // The verifier returns the last known nonce on cache hits too; access-key nonces only grow.
    if (typeof k.nonce === 'bigint' && k.nonce >= v.nonce) {
      return { ok: false, code: 'NONCE_TOO_LOW', agentId: v.agentId };
    }

    // F-C: never spend relayer gas when the relayer account is at or below its minimum balance.
    if (minBalance !== undefined && relayerBalance !== undefined) {
      let bal;
      try {
        bal = await getRelayerBalance();
      } catch {
        return { ok: false, code: 'UPSTREAM_ERROR' };
      }
      if (bal <= BigInt(minBalance)) return { ok: false, code: 'RELAYER_LOW_BALANCE' };
    }

    return { ok: true, v, dh };
  }

  return {
    policy,
    store,
    keyVerifier,
    getMandate,
    checkMandateAsset,
    async getTxStatus(txHash) {
      if (!txHash || typeof txHash !== 'string') {
        return { ok: false, code: 'INVALID_TX_HASH' };
      }
      const local = store.getByTxHash(txHash);
      if (!local) {
        return { ok: false, code: 'TX_NOT_FOUND', tx_hash: txHash };
      }
      let outcome = null;
      let rpcTimedOut = false;
      if (typeof provider.viewTransactionStatusWithReceipts === 'function') {
        try {
          outcome = await withTimeout(
            provider.viewTransactionStatusWithReceipts({
              txHash,
              accountId: relayerAccount?.accountId,
              waitUntil: 'FINAL',
            }),
            rpcTimeoutMs,
          );
        } catch (e) {
          if (isAmbiguousFailure(e)) rpcTimedOut = true;
        }
      } else if (typeof provider.txStatus === 'function') {
        try {
          outcome = await withTimeout(
            provider.txStatus({
              txHash,
              accountId: relayerAccount?.accountId,
              waitUntil: 'FINAL',
            }),
            rpcTimeoutMs,
          );
        } catch (e) {
          if (isAmbiguousFailure(e)) rpcTimedOut = true;
        }
      }

      if (rpcTimedOut) {
        return { ok: false, code: 'UPSTREAM_ERROR', tx_hash: txHash };
      }

      if (outcome) {
        const inner = extractInnerStatus(outcome);
        if (outcome.status?.Failure) {
          if (local) store.update(local.hash, txHash, 'TX_FAILED');
          return {
            ok: false,
            code: 'TX_FAILED',
            tx_hash: txHash,
            inner_status: inner.inner_status,
            ...(inner.inner_code ? { inner_code: inner.inner_code } : {}),
          };
        }
        if (local) store.update(local.hash, txHash, 'FINAL');
        return {
          ok: true,
          tx_hash: txHash,
          status: 'FINAL',
          inner_status: inner.inner_status,
          ...(inner.inner_code ? { inner_code: inner.inner_code } : {}),
        };
      }

      if (local && local.status === 'PENDING') {
        return {
          ok: true,
          tx_hash: txHash,
          pending: true,
          status: 'PENDING',
        };
      }

      return { ok: false, code: 'TX_NOT_FOUND', tx_hash: txHash };
    },

    async verify(signedDelegateBase64, { maxTimeoutSeconds } = {}) {
      const p = await preflight(signedDelegateBase64, { maxTimeoutSeconds });
      if (!p.ok) return p;
      const { v } = p;
      return {
        ok: true,
        agentId: v.agentId,
        method: v.method,
        call: v.call,
        maxBlockHeight: v.maxBlockHeight,
        nonce: v.nonce,
      };
    },

    async relay(signedDelegateBase64, { maxTimeoutSeconds } = {}) {
      const p = await preflight(signedDelegateBase64, { maxTimeoutSeconds });
      if (!p.ok) return p;
      const { v, dh } = p;

      if (queue?.length !== undefined && queue?.maxLength !== undefined && queue.length >= queue.maxLength) {
        return { ok: false, code: 'BUSY', agentId: v.agentId, retryAfterMs: 1000 };
      }

      const rl = limiter.tryTake(v.agentId);
      if (!rl.allowed) return { ok: false, code: 'RATE_LIMITED', retryAfterMs: rl.retryAfterMs, agentId: v.agentId };
      if (globalLimiter) {
        const g = globalLimiter.tryTake('*');
        if (!g.allowed) {
          limiter.refund?.(v.agentId);
          return { ok: false, code: 'RATE_LIMITED', retryAfterMs: g.retryAfterMs, agentId: v.agentId };
        }
      }
      const refundAll = () => {
        limiter.refund?.(v.agentId);
        globalLimiter?.refund?.('*');
      };

      // Register before queueing so a parallel identical request is short-circuited (in flight).
      // Re-check: another identical request may have registered while we awaited above.
      if (store.get(dh)) {
        refundAll();
        return { ok: false, code: 'DUPLICATE_DELEGATE', txHash: store.get(dh)?.txHash, agentId: v.agentId };
      }
      prune();
      store.set(dh, v.maxBlockHeight, undefined, 'PENDING', now, dedupeMax);

      try {
        let outcome = await queue.run(() => withTimeout(relayerAccount.relayMetaTransaction(v.signedDelegate), rpcTimeoutMs));
        const txHash = outcome?.transaction?.hash;
        if (txHash) {
          store.update(dh, txHash, 'FINAL');
        }
        if (outcome?.status?.Failure) return { ok: false, code: 'TX_FAILED', txHash, agentId: v.agentId };

        // F-B: wait for FINAL and read inner status
        if (txHash && (!outcome?.receipts_outcome || outcome.receipts_outcome.length === 0)) {
          if (typeof provider.viewTransactionStatusWithReceipts === 'function') {
            try {
              const finalOutcome = await withTimeout(provider.viewTransactionStatusWithReceipts({
                txHash,
                accountId: relayerAccount.accountId,
                waitUntil: 'FINAL',
              }), rpcTimeoutMs);
              if (finalOutcome) outcome = finalOutcome;
            } catch {}
          } else if (typeof provider.txStatus === 'function') {
            try {
              const finalOutcome = await withTimeout(provider.txStatus({
                txHash,
                accountId: relayerAccount.accountId,
                waitUntil: 'FINAL',
              }), rpcTimeoutMs);
              if (finalOutcome) outcome = finalOutcome;
            } catch {}
          }
        }
        const inner = extractInnerStatus(outcome);
        if (inner.inner_code === 'REVOKED' || inner.inner_code === 'KEY_REVOKED') {
          keyVerifier.evict(v.agentId, v.publicKey);
        }
        return {
          ok: true,
          txHash,
          agentId: v.agentId,
          outerSuccess: true,
          inner_status: inner.inner_status,
          ...(inner.inner_code ? { inner_code: inner.inner_code } : {}),
          note: OUTER_NOTE,
        };
      } catch (e) {
        if (e?.code === 'BUSY' || e?.message === 'BUSY') {
          store.delete(dh);
          refundAll();
          return { ok: false, code: 'BUSY', agentId: v.agentId, retryAfterMs: 1000 };
        }
        if (isAmbiguousFailure(e)) {
          // May have landed: keep the token spent and the dedupe entry; client must re-check the chain, not re-sign.
          return { ok: false, code: 'RELAY_PENDING', agentId: v.agentId };
        }
        store.delete(dh);
        refundAll();
        return { ok: false, code: 'RELAY_FAILED', agentId: v.agentId };
      }
    },
  };
}
