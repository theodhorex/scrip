import { RACE_DATA } from "@/lib/landing-data";
import gateLab from "@/data/gate.json" with { type: "json" };
import { mapProofData } from "@/lib/proof-data";

/** Format an ISO timestamp as "28 Oct 2026" in UTC, so server and client agree. */
export function formatRecorded(iso: string): string {
  return new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(new Date(iso));
}
export const RACE = RACE_DATA; // results/attack.json (copy in src/data/attack.json)
// Verbatim copy of results/gate.json (run of 30 Oct 2026). The old landing keeps its own older copy.
export const PROOF = mapProofData(gateLab);
/** results/demo-guard.json, 2 Nov 2026. Read-only run: sign() only recorded intent, no transaction was sent. */
export const GUARD_RUN = {
  recordedAt: "2026-11-02T03:23:51.660Z",
  scenarios: [
    { id: "known-merchant", verdict: "allow", note: "Account age, code and prior interactions all clear." },
    { id: "new-recipient", verdict: "warn", note: "The account has never been seen before." },
    { id: "injection-block", verdict: "block", note: "On the blocklist, with the report attached as evidence." },
    { id: "unevidenced-report", verdict: "warn", note: "Blocklist entry ignored: the report had no evidence." },
  ],
} as const;
