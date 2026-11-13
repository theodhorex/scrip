// In-memory stand-in for facilitator/src/store.mjs (same interface), for the hosted relayer on Vercel.
// A serverless instance has no durable disk, so the dedupe set lives as long as the instance. A replayed
// delegate that reaches a fresh instance still cannot pay twice: the chain rejects a reused access-key nonce.
export function createDedupeStore() {
  const rows = new Map(); // hash -> { hash, maxBlockHeight, txHash, status, createdAt }; insertion order = oldest first

  function bound(max) {
    if (typeof max !== 'number' || max <= 0) return;
    while (rows.size > max) rows.delete(rows.keys().next().value);
  }

  return {
    get(hash) {
      const r = rows.get(hash);
      return r ? { ...r } : null;
    },
    getByTxHash(txHash) {
      for (const r of rows.values()) if (r.txHash === txHash) return { ...r };
      return null;
    },
    set(hash, maxBlockHeight, txHash = null, status = 'PENDING', now = Date.now, maxEntries = undefined) {
      if (rows.has(hash)) return;
      rows.set(hash, { hash, maxBlockHeight: BigInt(maxBlockHeight), txHash: txHash ?? undefined, status, createdAt: now() });
      if (maxEntries !== undefined) bound(maxEntries);
    },
    update(hash, txHash, status) {
      const r = rows.get(hash);
      if (r) Object.assign(r, { txHash: txHash ?? undefined, status });
    },
    delete(hash) {
      rows.delete(hash);
    },
    prune(currentBlockHeight) {
      const h = BigInt(currentBlockHeight);
      for (const [k, r] of rows) if (r.maxBlockHeight < h) rows.delete(k);
    },
    bound,
    size() {
      return rows.size;
    },
    close() {
      rows.clear();
    },
  };
}
