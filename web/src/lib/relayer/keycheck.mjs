// Verifies that the signing key really is a restricted access key of senderId (F2). RPC is injected.
const POS_TTL_MS = 60_000;
const NEG_TTL_MS = 10_000;

// near-api-js 7.4.0 throws AccessKeyDoesNotExistError / AccountDoesNotExistError (matched by class name,
// they are not exported from the package root). Anything else is treated as an RPC failure.
const isMissing = (e) => ['AccessKeyDoesNotExistError', 'AccountDoesNotExistError'].includes(e?.constructor?.name);

function permissionOk(permission, policy) {
  const fc = permission && typeof permission === 'object' ? permission.FunctionCall : undefined; // 'FullAccess' is a string
  if (!fc || fc.receiver_id !== policy.contractId) return false;
  if (!Array.isArray(fc.method_names) || fc.method_names.length === 0) return false;
  if (!fc.method_names.every((m) => policy.allowedMethods.includes(m))) return false;
  if (fc.allowance !== null && fc.allowance !== undefined) {
    try {
      if (BigInt(fc.allowance) === 0n) return false;
    } catch {
      return false;
    }
  }
  return true;
}

export function createKeyVerifier({ provider, policy, now = Date.now, maxEntries = 10_000, maxNegEntries = 500 }) {
  // Positive and negative results live in separate bounded maps, so forged random keys (negatives) can
  // only evict other negatives, never valid positive entries (N-L4). Insertion order = oldest first.
  const pos = new Map(); // `${accountId}\n${publicKey}` -> { until, nonce }
  const neg = new Map();
  const put = (m, id, value, max) => {
    m.delete(id);
    while (m.size >= max) m.delete(m.keys().next().value);
    m.set(id, value);
  };
  return {
    /** -> { ok:true, nonce?, fresh } | { ok:false, code:'KEY_NOT_ALLOWED'|'UPSTREAM_ERROR' } */
    async check(accountId, publicKey) {
      const id = `${accountId}\n${publicKey.toString()}`;
      const t = now();
      const pu = pos.get(id);
      if (pu !== undefined) {
        if (pu.until > t) return { ok: true, nonce: pu.nonce, fresh: false };
        pos.delete(id);
      }
      const nu = neg.get(id);
      if (nu !== undefined) {
        if (nu > t) return { ok: false, code: 'KEY_NOT_ALLOWED' };
        neg.delete(id);
      }

      let allowed;
      let nonce;
      try {
        const r = await provider.viewAccessKey({ accountId, publicKey });
        allowed = permissionOk(r?.permission, policy);
        try {
          nonce = r?.nonce === undefined ? undefined : BigInt(r.nonce); // u64 nonce of the access key
        } catch {
          nonce = undefined;
        }
      } catch (e) {
        if (!isMissing(e)) return { ok: false, code: 'UPSTREAM_ERROR' }; // not cached, no token spent
        allowed = false;
      }
      if (allowed) put(pos, id, { until: now() + POS_TTL_MS, nonce }, maxEntries);
      else put(neg, id, now() + NEG_TTL_MS, maxNegEntries);
      if (!allowed) return { ok: false, code: 'KEY_NOT_ALLOWED' };
      // `fresh` tells the caller this answer came from a real RPC now. A cache hit still carries the
      // last known on-chain nonce; access-key nonces only increase, so it stays a safe lower bound.
      return { ok: true, nonce, fresh: true };
    },
    /** Drop a cached positive (e.g. the chain rejected the key). */
    evict(accountId, publicKey) {
      pos.delete(`${accountId}\n${publicKey.toString()}`);
    },
    size: () => pos.size + neg.size,
    sizes: () => ({ pos: pos.size, neg: neg.size }),
  };
}
