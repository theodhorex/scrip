import catalog from "../data/attack-catalog.json" with { type: "json" };
import { LLM_TRIALS } from "./llm-trials-data";

/**
 * Figures shown in the Proof section. Catalog numbers come from the data file (results/attack-catalog.json,
 * run 10 to 12 Nov 2026). The two constants below have no data file and are typed from their sources.
 */
const v = catalog.summary.verdicts;

/** contracts/scrip/MUTATION.md, rerun 10 to 12 Nov 2026: 198 mutants, 176 caught, 1 missed (equivalent), 21 unviable; 176 of 177 viable. */
const MUTATION = { caught: 176, viable: 177, mutants: 198 };
/** CI log of the contract test job (cargo test). */
const CONTRACT_TESTS = 138;

export const VERIFIED_STATS_AS_OF = "12 Nov 2026";
export const VERIFIED_STATS_NOTE = "as of 12 Nov 2026";

export const VERIFIED_STATS: ReadonlyArray<{ value: string; label: string; source: string }> = [
  { value: `${v.PASS.toLocaleString("en-US")}/${v.total.toLocaleString("en-US")}`, label: "catalog cases pass", source: "results/attack-catalog.json, layers A to E" },
  { value: `${v.FAIL} / ${v.BREACH}`, label: "failed / breached", source: `${v.SKIPPED} cases were skipped, reported as skipped, not as passed` },
  { value: `${((MUTATION.caught / MUTATION.viable) * 100).toFixed(1)}%`, label: "mutants caught", source: `contracts/scrip/MUTATION.md: ${MUTATION.caught} of ${MUTATION.viable} viable, ${MUTATION.mutants} generated` },
  { value: String(CONTRACT_TESTS), label: "contract tests pass", source: "CI, contract job" },
  { value: String(LLM_TRIALS.length), label: "real model decisions", source: "results/llm/, 4 small models" },
];
