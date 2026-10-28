// Data access seam. With AMANAT_CONTRACT_ID unset it returns sample data; with
// it set, mandates are read from the `amanat` contract view methods over NEAR
// testnet JSON-RPC (see chain.ts). Events need an indexer, so they are empty
// when live. Chain errors are thrown: callers must render <ChainError />, never
// fall back to sample data. Keep page code on these functions only.
import "server-only";
import { viewCall } from "./chain";
import { mapMandateView } from "./mandate-map";
import { MOCK_EVENTS, MOCK_MANDATES } from "./mock";
import type { AmanatEvent, Mandate } from "./types";

// Server-side env, evaluated when the server module loads.
const CONTRACT_ID = process.env.AMANAT_CONTRACT_ID;
export const IS_SAMPLE_DATA = !CONTRACT_ID;

export async function listMandates(): Promise<Mandate[]> {
  if (!CONTRACT_ID) return MOCK_MANDATES;
  // Spike contract holds a single mandate (id 0); replace with a real listing later.
  const mandate = await getMandate(0);
  return mandate ? [mandate] : [];
}

export async function getMandate(id: number): Promise<Mandate | undefined> {
  if (!CONTRACT_ID) return MOCK_MANDATES.find((m) => m.id === id);
  // Spike get_mandate takes no arguments and serves mandate 0 only; the final
  // contract will take `mandate_id` (pass it in the args object then).
  if (id !== 0) return undefined;
  const raw = await viewCall(CONTRACT_ID, "get_mandate", {});
  return mapMandateView(raw, id);
}

export async function listEvents(mandateId: number): Promise<AmanatEvent[]> {
  if (CONTRACT_ID) return []; // No indexer yet: honest empty state, nothing fabricated.
  return MOCK_EVENTS.filter((e) => e.mandateId === mandateId);
}
