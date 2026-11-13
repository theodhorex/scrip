// Data access seam. Mandates are read from the live `scrip` contract over NEAR testnet
// JSON-RPC (see chain.ts): by default the live demo contract in src/data/live.json,
// or SCRIP_CONTRACT_ID when set. SCRIP_SAMPLE_DATA=1 switches back to bundled sample
// data. Events need an indexer, so they are empty when live. Chain errors are thrown:
// callers must render <ChainError />, never fall back to sample data.
import "server-only";
import { viewCall } from "./chain";
import { mapMandateView } from "./mandate-map";
import { MOCK_EVENTS, MOCK_MANDATES } from "./mock";
import { LIVE } from "./live";
import { parseScripEvents } from "./live-events";

const INDEXER = "https://tx.test.fastnear.com/v0";
import type { ScripEvent, Mandate } from "./types";

// Server-side env, evaluated when the server module loads.
const SAMPLE = process.env.SCRIP_SAMPLE_DATA === "1";
const CONTRACT_ID = SAMPLE ? undefined : (process.env.SCRIP_CONTRACT_ID || LIVE.contractId);
/** Mandate ids to list. The live demo contract has one mandate; another contract lists ids from SCRIP_MANDATE_IDS. */
const MANDATE_IDS = (process.env.SCRIP_MANDATE_IDS ?? (CONTRACT_ID === LIVE.contractId ? String(LIVE.mandateId) : "1"))
  .split(",").map((x) => Number(x.trim())).filter((n) => Number.isSafeInteger(n) && n >= 0);
export const IS_SAMPLE_DATA = !CONTRACT_ID;
export const CONTRACT = CONTRACT_ID;

export async function listMandates(): Promise<Mandate[]> {
  if (!CONTRACT_ID) return MOCK_MANDATES;
  const found = await Promise.all(MANDATE_IDS.map((id) => getMandate(id)));
  return found.filter((m): m is Mandate => !!m);
}

export async function getMandate(id: number): Promise<Mandate | undefined> {
  if (!CONTRACT_ID) return MOCK_MANDATES.find((m) => m.id === id);
  if (!Number.isSafeInteger(id) || id < 0) return undefined;
  const raw = await viewCall(CONTRACT_ID, "get_mandate", { id });
  if (raw === null || raw === undefined) return undefined;
  return mapMandateView(raw, id);
}

export async function listEvents(mandateId: number): Promise<ScripEvent[]> {
  if (!CONTRACT_ID) return MOCK_EVENTS.filter((e) => e.mandateId === mandateId);
  // Recent transactions of the contract from the public FastNear indexer, then their logs. Best effort:
  // when the indexer is down the page shows an empty log (labelled), never invented events.
  const post = async (path: string, body: unknown) => {
    const ctl = new AbortController();
    const t = setTimeout(() => ctl.abort(), 8000);
    try {
      const r = await fetch(`${INDEXER}/${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body), signal: ctl.signal, cache: "no-store" });
      return r.ok ? await r.json() : null;
    } catch { return null; } finally { clearTimeout(t); }
  };
  const acct = (await post("account", { account_id: CONTRACT_ID })) as { account_txs?: Array<{ transaction_hash?: string; tx_block_height?: number }> } | null;
  const hashes = (acct?.account_txs ?? [])
    .sort((a, b) => (b.tx_block_height ?? 0) - (a.tx_block_height ?? 0))
    .map((t) => t.transaction_hash)
    .filter((h): h is string => typeof h === "string")
    .slice(0, 20);
  if (hashes.length === 0) return [];
  return parseScripEvents(await post("transactions", { tx_hashes: hashes }), mandateId);
}
