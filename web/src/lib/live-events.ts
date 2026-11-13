// Pure parser: NEP-297 `scrip` events from FastNear transaction details (POST /v0/transactions).
// Erasable TypeScript only, so `node --test` can import it directly.
import type { RejectCode, ScripEvent, ScripEventName } from "./types";

const NAMES: readonly ScripEventName[] = ["mandate_created", "deposited", "reserved", "rejected", "settled", "refunded", "intent_approved", "tightened", "loosened", "revoked", "withdrawn", "stale_resolved"];

type Outcome = { block_timestamp?: string | number; outcome?: { logs?: unknown[] } };
type TxDetail = { transaction?: { hash?: string }; receipts?: Array<{ execution_outcome?: Outcome }> };

/** Every `scrip` event for one mandate, newest first. Unknown or malformed logs are skipped, never guessed. */
export function parseScripEvents(body: unknown, mandateId: number): ScripEvent[] {
  const list = (body as { transactions?: TxDetail[] } | null)?.transactions;
  if (!Array.isArray(list)) return [];
  const out: ScripEvent[] = [];
  for (const tx of list) {
    const txHash = tx?.transaction?.hash;
    for (const r of tx?.receipts ?? []) {
      const eo = r?.execution_outcome;
      const ns = eo?.block_timestamp;
      const atMs = typeof ns === "string" || typeof ns === "number" ? Number(BigInt(ns) / BigInt(1000000)) : 0;
      for (const log of eo?.outcome?.logs ?? []) {
        if (typeof log !== "string" || !log.startsWith("EVENT_JSON:")) continue;
        let ev: { standard?: string; event?: string; data?: Array<Record<string, unknown>> };
        try { ev = JSON.parse(log.slice(11)); } catch { continue; }
        if (ev.standard !== "scrip" || !NAMES.includes(ev.event as ScripEventName) || !Array.isArray(ev.data)) continue;
        for (const d of ev.data) {
          if (d?.mandate_id !== mandateId) continue;
          out.push({
            name: ev.event as ScripEventName,
            mandateId,
            requestId: typeof d.request_id === "number" ? d.request_id : undefined,
            recipient: typeof d.recipient === "string" ? d.recipient : undefined,
            amount: typeof d.amount === "string" ? d.amount : undefined,
            code: typeof d.code === "string" ? (d.code as RejectCode) : undefined,
            atMs,
            txHash: typeof txHash === "string" ? txHash : undefined,
          });
        }
      }
    }
  }
  return out.sort((a, b) => b.atMs - a.atMs);
}
