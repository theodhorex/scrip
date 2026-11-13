import Link from "next/link";
import {
  loadAttackResults,
  parseAttackResults,
  loadAttackCatalog,
  parseAttackCatalog,
  formatUsdcUnits,
  buildLayerMatrix,
  totalsByLayer,
  LAYERS,
  VERDICTS,
  type VerdictCounts,
  type Verdict,
  getOutOfScopeCases,
  CATEGORY_NAMES,
} from "@/lib/attack-data";
import bundledAttackRun from "@/data/attack.json";
import bundledCatalog from "@/data/attack-catalog.json";

const VERDICT_MARK: Record<Verdict, string> = { PASS: "\u2713", FAIL: "\u2715", SKIPPED: "\u2013", BREACH: "\u26A0" };
const VERDICT_CLASS: Record<Verdict, string> = {
  PASS: "bp-app-chip-pass",
  FAIL: "bp-app-chip-reject",
  SKIPPED: "",
  BREACH: "bp-app-chip-reject",
};

function VerdictCell({ counts }: { counts?: VerdictCounts }) {
  if (!counts || counts.total === 0) {
    return (
      <span className="text-bp-muted bp-app-mono" title="Not run / no cases">
        <span aria-hidden="true">&ndash;</span>
        <span className="sr-only">not run</span>
      </span>
    );
  }
  return (
    <span className="flex flex-wrap gap-1">
      {VERDICTS.filter((v) => counts[v] > 0).map((v) => (
        <span key={v} className={`bp-app-chip ${VERDICT_CLASS[v]}`}>
          <span aria-hidden="true">{VERDICT_MARK[v]}</span>
          {v} {counts[v]}
        </span>
      ))}
      {counts.other > 0 && <span className="bp-app-chip">? {counts.other}</span>}
    </span>
  );
}

export default function AttackPage() {
  // A deploy rooted at web/ has no ../results folder, so fall back to the
  // recorded run bundled in src/data (same run as results/attack.json).
  const results = loadAttackResults() ?? parseAttackResults(bundledAttackRun);
  const catalog = loadAttackCatalog() ?? parseAttackCatalog(bundledCatalog);

  const naive = results?.naive ?? null;
  const scrip = results?.scrip ?? null;

  const catalogMatrix = catalog ? buildLayerMatrix(catalog.cases) : [];
  const layerTotals = totalsByLayer(catalogMatrix);
  const layersWithData = LAYERS.filter((l) => layerTotals[l].total > 0);
  const layersMissing = LAYERS.filter((l) => layerTotals[l].total === 0);
  const grand = catalogMatrix.reduce((n, r) => n + r.total.total, 0);
  const grandBreach = catalogMatrix.reduce((n, r) => n + r.total.BREACH, 0);
  const outOfScopeCases = catalog ? getOutOfScopeCases(catalog.cases) : [];

  return (
    <div className="bp-app-stack">
      <header className="bp-app-head" style={{ marginBottom: 0 }}>
        <div>
          <span className="bp-chapter-label">Attack demo</span>
          <h1 className="bp-app-title">Naive contract vs Scrip</h1>
          <p className="bp-app-lede">
            Concurrency stress test evaluating race condition defense under parallel payment requests.
          </p>
        </div>
        <Link href="/mandates" className="bp-btn bp-btn-secondary">View mandates</Link>
      </header>

      {!results ? (
        <div role="status" aria-live="polite" className="bp-plate bp-app-empty">
          <div className="bp-app-empty-icon bp-app-mono" aria-hidden="true">&ndash;</div>
          <h2 className="bp-app-notice-title">The parallel burst test has not been run</h2>
          <p className="bp-app-notice-body mx-auto max-w-lg">
            Results load from <code className="bp-app-chip">results/attack.json</code> once the testnet attack has run.
          </p>
        </div>
      ) : (
        <div className="bp-plate p-4 text-xs font-mono flex flex-wrap gap-x-6 gap-y-2 items-center text-bp-muted">
          <div>Network: <span className="text-bp-ink">{results.network}</span></div>
          <div>Started: <span className="text-bp-ink">{results.startedAt}</span></div>
          <div>Pace: <span className="text-bp-ink">{results.params.PACE_MS} ms</span></div>
          <div>Burst: <span className="text-bp-ink">{results.params.N} txs</span></div>
          <div>Status: <span className="text-bp-pass font-semibold">{results.ok ? "Testnet run verified" : "Run recorded"}</span></div>
        </div>
      )}

      <section aria-labelledby="comparison-heading">
        <h2 id="comparison-heading" className="bp-app-section-title">
          Benchmark comparison: Naive vs Scrip
        </h2>
        <div className="bp-plate bp-app-table-wrap">
          <table className="bp-app-table">
            <thead>
              <tr>
                <th scope="col" style={{ width: "36%" }}>Metric</th>
                <th scope="col">
                  Naive contract
                  <span className="block text-[11px] font-normal normal-case tracking-normal text-bp-reject">
                    Post-transfer balance check
                  </span>
                </th>
                <th scope="col">
                  Scrip contract
                  <span className="block text-[11px] font-normal normal-case tracking-normal text-bp-pass">
                    Pre-transfer reservation lock
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Transactions</th>
                <td className="bp-app-mono">
                  {naive ? `${naive.broadcast.n} broadcast (${naive.broadcast.burstMs} ms)` : <span className="text-bp-muted">&ndash;</span>}
                </td>
                <td className="bp-app-mono">
                  {scrip ? `${scrip.broadcast.n} broadcast (${scrip.broadcast.burstMs} ms)` : <span className="text-bp-muted">&ndash;</span>}
                </td>
              </tr>
              <tr>
                <th scope="row">Budget cap</th>
                <td className="bp-app-mono">
                  {naive ? formatUsdcUnits(naive.budget) : <span className="text-bp-muted">&ndash;</span>}
                </td>
                <td className="bp-app-mono">
                  {scrip ? formatUsdcUnits(scrip.budget) : <span className="text-bp-muted">&ndash;</span>}
                </td>
              </tr>
              <tr>
                <th scope="row">Merchant received</th>
                <td className="bp-app-mono">
                  {naive ? (
                    <span className="text-bp-reject font-bold">
                      {formatUsdcUnits(naive.merchantReceived)}
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
                <td className="bp-app-mono">
                  {scrip ? (
                    <span className="text-bp-pass font-bold">
                      {formatUsdcUnits(scrip.merchantReceived)}
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Budget exceeded</th>
                <td className="bp-app-mono">
                  {naive ? (
                    naive.exceededBudget ? (
                      <span className="bp-app-chip bp-app-chip-reject">
                        EXCEEDED (+{formatUsdcUnits(naive.overBudgetBy)})
                      </span>
                    ) : (
                      <span className="text-bp-pass font-semibold">NO</span>
                    )
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
                <td className="bp-app-mono">
                  {scrip ? (
                    scrip.exceededBudget ? (
                      <span className="bp-app-chip bp-app-chip-reject">
                        EXCEEDED (+{formatUsdcUnits(scrip.overBudgetBy)})
                      </span>
                    ) : (
                      <span className="text-bp-pass font-semibold">
                        HELD ({formatUsdcUnits(scrip.overBudgetBy)} over)
                      </span>
                    )
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Payments completed</th>
                <td className="bp-app-mono">
                  {naive ? `${naive.paymentsPaid} payments` : <span className="text-bp-muted">&ndash;</span>}
                </td>
                <td className="bp-app-mono">
                  {scrip ? `${scrip.paymentsPaid} payments` : <span className="text-bp-muted">&ndash;</span>}
                </td>
              </tr>
              <tr>
                <th scope="row">Spent (contract)</th>
                <td className="bp-app-mono">
                  {naive ? formatUsdcUnits(naive.spent) : <span className="text-bp-muted">&ndash;</span>}
                </td>
                <td className="bp-app-mono">
                  {scrip ? formatUsdcUnits(scrip.spent) : <span className="text-bp-muted">&ndash;</span>}
                </td>
              </tr>
              <tr>
                <th scope="row">Pending reservations</th>
                <td className="bp-app-mono">
                  {naive ? `${formatUsdcUnits(naive.reserved)} (${naive.openRequests} open)` : <span className="text-bp-muted">&ndash;</span>}
                </td>
                <td className="bp-app-mono">
                  {scrip ? `${formatUsdcUnits(scrip.reserved)} (${scrip.openRequests} open)` : <span className="text-bp-muted">&ndash;</span>}
                </td>
              </tr>
              <tr>
                <th scope="row">Defense verdict</th>
                <td>
                  {naive ? (
                    <span className="bp-app-chip bp-app-chip-reject">
                      VULNERABLE (drain bypasses cap)
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
                <td>
                  {scrip ? (
                    <span className="bp-app-chip bp-app-chip-pass">
                      PRESERVED
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
              </tr>
            </tbody>
          </table>
        </div>
      </section>

      <section aria-labelledby="catalog-heading" className="mt-8">
        <div className="flex items-center justify-between mb-3">
          <h2 id="catalog-heading" className="bp-app-section-title" style={{ marginBottom: 0 }}>
            Attack variation catalog
          </h2>
          {!catalog && <span className="bp-app-chip text-bp-muted">Not run</span>}
        </div>

        {!catalog || catalog.cases.length === 0 ? (
          <div role="status" aria-live="polite" className="bp-plate bp-app-empty">
            <div className="bp-app-empty-icon bp-app-mono" aria-hidden="true">&ndash;</div>
            <h3 className="bp-app-notice-title">The attack catalog has not been run</h3>
            <p className="bp-app-notice-body mx-auto max-w-lg">
              Catalog results load from <code className="bp-app-chip">results/attack-catalog.json</code> once it has run.
            </p>
          </div>
        ) : (
          <>
            <p className="text-xs text-bp-muted mb-3 max-w-2xl leading-relaxed">
              Source: <code className="bp-app-chip">results/attack-catalog.json</code>. {grand} recorded cases; PASS, FAIL, SKIPPED and BREACH labels are shown exactly as the catalog records them.
              {layersMissing.length > 0 && (
                <> Layer {layersMissing.join(", ")} has no data yet and is marked &quot;not run&quot;, not counted as zero passes.</>
              )}
            </p>
            <div className="bp-plate bp-app-table-wrap">
              <table className="bp-app-table">
                <thead>
                  <tr>
                    <th scope="col">Category</th>
                    {LAYERS.map((l) => (
                      <th scope="col" key={l}>Layer {l}</th>
                    ))}
                    <th scope="col">Total</th>
                  </tr>
                </thead>
                <tbody>
                  {catalogMatrix.map((row) => (
                    <tr key={row.category}>
                      <th scope="row">{row.categoryName}</th>
                      {LAYERS.map((l) => (
                        <td key={l}>
                          <VerdictCell counts={row.cells[l]} />
                        </td>
                      ))}
                      <td><VerdictCell counts={row.total} /></td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr>
                    <th scope="row">All categories</th>
                    {LAYERS.map((l) => (
                      <td key={l}>
                        <VerdictCell counts={layerTotals[l]} />
                      </td>
                    ))}
                    <td>
                      <span className="bp-app-mono">{grand}</span>
                      {grandBreach > 0 && <span className="bp-app-chip bp-app-chip-reject ml-2">&#9888; {grandBreach} BREACH</span>}
                    </td>
                  </tr>
                </tfoot>
              </table>
            </div>
            <p className="text-[11px] text-bp-muted mt-2" aria-hidden={layersWithData.length === 0}>
              Legend: {VERDICTS.map((v) => `${VERDICT_MARK[v]} ${v}`).join(" · ")} · &ndash; no cases
            </p>
          </>
        )}
      </section>

      {catalog && (
        <section aria-labelledby="out-of-scope-heading" className="mt-8">
          <div className="mb-3">
            <h3 id="out-of-scope-heading" className="bp-app-section-title" style={{ marginBottom: 0 }}>
              Outside the guarantee
            </h3>
            <p className="text-xs text-bp-muted mt-1 max-w-2xl leading-relaxed">
              Scenarios outside the Scrip threat model (for example a leaked owner full-access key, a malicious token contract, or a lying RPC). Scrip does not claim to prevent these; they are recorded on purpose as stated limits.
            </p>
          </div>

          {outOfScopeCases.length === 0 ? (
            <div className="bp-plate p-4 text-xs text-bp-muted">
              The catalog has no OUT_OF_SCOPE cases right now.
            </div>
          ) : (
            <div className="bp-plate bp-app-table-wrap">
              <table className="bp-app-table">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: "25%" }}>ID / Category</th>
                    <th scope="col" style={{ width: "15%" }}>Layer</th>
                    <th scope="col" style={{ width: "20%" }}>Expected label</th>
                    <th scope="col" style={{ width: "20%" }}>Actual label</th>
                    <th scope="col" style={{ width: "20%" }}>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {outOfScopeCases.map((c, i) => (
                    <tr key={c.id ?? `oos-${i}`}>
                      <th scope="row">
                        <div className="font-semibold">{c.id ?? `Case ${i + 1}`}</div>
                        <div className="text-[11px] text-bp-muted font-normal">
                          {CATEGORY_NAMES[String(c.category)] ?? `Category ${c.category}`}
                        </div>
                      </th>
                      <td className="bp-app-mono text-bp-muted">{c.layer}</td>
                      <td>
                        <span className="bp-app-chip">{c.expected.label}</span>
                      </td>
                      <td>
                        <span className="bp-app-chip">{c.actual?.label ?? "-"}</span>
                      </td>
                      <td className="bp-app-mono">
                        <span className={`bp-app-chip ${c.verdict === "PASS" ? "bp-app-chip-pass" : ""}`}>
                          {c.verdict}
                        </span>
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </section>
      )}
    </div>
  );
}
