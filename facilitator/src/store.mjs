// Persistent deduplication store using node:sqlite.
import { DatabaseSync } from 'node:sqlite';

export function createDedupeStore(dbPath = '.facilitator.db') {
  const db = new DatabaseSync(dbPath);
  db.exec(`
    CREATE TABLE IF NOT EXISTS delegates (
      hash TEXT PRIMARY KEY,
      max_block_height TEXT NOT NULL,
      tx_hash TEXT,
      status TEXT NOT NULL,
      created_at INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_delegates_tx_hash ON delegates(tx_hash);
  `);

  const insertStmt = db.prepare(`
    INSERT INTO delegates (hash, max_block_height, tx_hash, status, created_at)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(hash) DO NOTHING
  `);

  const updateStmt = db.prepare(`
    UPDATE delegates SET tx_hash = ?, status = ? WHERE hash = ?
  `);

  const getStmt = db.prepare(`
    SELECT hash, max_block_height, tx_hash, status, created_at FROM delegates WHERE hash = ?
  `);

  const getByTxHashStmt = db.prepare(`
    SELECT hash, max_block_height, tx_hash, status, created_at FROM delegates WHERE tx_hash = ?
  `);

  const pruneStmt = db.prepare(`
    DELETE FROM delegates WHERE CAST(max_block_height AS INTEGER) < ?
  `);

  const countStmt = db.prepare(`
    SELECT COUNT(*) as count FROM delegates
  `);

  function bound(max) {
    if (typeof max !== 'number' || max <= 0) return;
    const currentSize = countStmt.get().count;
    if (currentSize > max) {
      db.prepare(`
        DELETE FROM delegates WHERE hash IN (
          SELECT hash FROM delegates ORDER BY created_at ASC LIMIT ?
        )
      `).run(currentSize - max);
    }
  }

  return {
    get(hash) {
      const row = getStmt.get(hash);
      if (!row) return null;
      return {
        hash: row.hash,
        maxBlockHeight: BigInt(row.max_block_height),
        txHash: row.tx_hash ?? undefined,
        status: row.status,
        createdAt: row.created_at,
      };
    },
    getByTxHash(txHash) {
      const row = getByTxHashStmt.get(txHash);
      if (!row) return null;
      return {
        hash: row.hash,
        maxBlockHeight: BigInt(row.max_block_height),
        txHash: row.tx_hash ?? undefined,
        status: row.status,
        createdAt: row.created_at,
      };
    },
    set(hash, maxBlockHeight, txHash = null, status = 'PENDING', now = Date.now, maxEntries = undefined) {
      insertStmt.run(hash, maxBlockHeight.toString(), txHash, status, now());
      if (maxEntries !== undefined) bound(maxEntries);
    },
    update(hash, txHash, status) {
      updateStmt.run(txHash ?? null, status, hash);
    },
    delete(hash) {
      db.prepare('DELETE FROM delegates WHERE hash = ?').run(hash);
    },
    prune(currentBlockHeight) {
      pruneStmt.run(Number(currentBlockHeight));
    },
    bound,
    size() {
      return countStmt.get().count;
    },
    close() {
      db.close();
    },
  };
}
