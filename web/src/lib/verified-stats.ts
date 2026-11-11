/**
 * Verified numbers shown on the hero lab. Hand-entered, not computed.
 * Source: re-run on 3 Nov 2026.
 * Not final: to be refreshed at code freeze. Do not add the 3000+ catalog count
 * or any layer E result until those are final.
 */
export const VERIFIED_STATS_AS_OF = "3 Nov 2026";
export const VERIFIED_STATS_NOTE = "as of 3 Nov 2026; to be refreshed at freeze";

export const VERIFIED_STATS: ReadonlyArray<{
  value: string;
  label: string;
  source: string;
}> = [
  { value: "160/160", label: "sandbox cases pass", source: "contract sandbox, layer D" },
  { value: "20/20", label: "integration tests pass", source: "contract integration tests" },
  { value: "127", label: "unit tests pass", source: "contract unit tests" },
];
