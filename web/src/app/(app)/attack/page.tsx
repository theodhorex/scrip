import type { Metadata } from "next";
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

export const metadata: Metadata = {
  title: "Attack results | Scrip",
  description: "A 30-payment burst and 1,999 recorded attacks against Scrip. None got through.",
};

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
      <header className="bp-app-head">
        <div>
          <span className="bp-chapter-label">Attack results</span>
          <h1 className="bp-app-title">We attacked it. Nothing got through.</h1>
          <p className="bp-app-lede">
            First, 30 payments of 0.1 USDC fired at the same moment at a 1 USDC budget: against an ordinary contract,
            and against Scrip. Then 1,999 recorded attacks, from fake recipients to stolen keys.
          </p>
        </div>
        <div className="nl-head-actions">
          <Link href="/try" className="bp-btn bp-btn-primary">Try it yourself</Link>
          <Link href="/verify" className="bp-btn bp-btn-secondary">Verify the transactions</Link>
        </div>
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
        <div className="nl-burst">
          <div className="nl-burst-card nl-burst-bad">
            <span className="nl-burst-k">An ordinary contract paid out</span>
            <span className="nl-burst-v">{naive ? formatUsdcUnits(naive.merchantReceived) : "–"}</span>
            <span className="nl-burst-s">{naive?.exceededBudget ? `${formatUsdcUnits(naive.overBudgetBy)} over a ${formatUsdcUnits(naive.budget)} budget` : "within budget"}</span>
          </div>
          <div className="nl-burst-card">
            <span className="nl-burst-k">Scrip paid out</span>
            <span className="nl-burst-v">{scrip ? formatUsdcUnits(scrip.merchantReceived) : "–"}</span>
            <span className="nl-burst-s">{scrip && !scrip.exceededBudget ? `exactly the ${formatUsdcUnits(scrip.budget)} budget, the rest refused` : "over budget"}</span>
          </div>
          <dl className="nl-burst-meta">
            <div><dt>Network</dt><dd>{results.network}</dd></div>
            <div><dt>Run</dt><dd>{results.startedAt.slice(0, 16).replace("T", " ")} UTC</dd></div>
            <div><dt>Burst</dt><dd>{results.params.N} transactions, {results.params.PACE_MS} ms apart</dd></div>
            <div><dt>Status</dt><dd>{results.ok ? "Testnet run verified" : "Run recorded"}</dd></div>
          </dl>
        </div>
      )}

      <section aria-labelledby="comparison-heading">
        <h2 id="comparison-heading" className="bp-app-section-title">
          The burst, line by line
        </h2>
        <div className="bp-plate bp-app-table-wrap">
          <table className="bp-app-table">
            <thead>
              <tr>
                <th scope="col" style={{ width: "36%" }}>Metric</th>
                <th scope="col">
                  Ordinary contract
                  <span className="block text-[11px] font-normal normal-case tracking-normal text-bp-reject">
                    Checks the balance after paying
                  </span>
                </th>
                <th scope="col">
                  Scrip
                  <span className="block text-[11px] font-normal normal-case tracking-normal text-bp-pass">
                    Reserves the amount before paying
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

      <section aria-labelledby="catalog-heading">
        <div className="flex items-center justify-between">
          <h2 id="catalog-heading" className="bp-app-section-title">
            Attack catalog <span className="bp-kicker">{grand.toLocaleString("en-US")} cases, 12 categories, 5 layers</span>
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
            <p className="nl-ov-note" style={{ margin: "0 0 18px" }}>
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
            <p className="nl-ov-note" style={{ marginTop: 12 }} aria-hidden={layersWithData.length === 0}>
              Legend: {VERDICTS.map((v) => `${VERDICT_MARK[v]} ${v}`).join(" · ")} · &ndash; no cases
            </p>
          </>
        )}
      </section>

      {catalog && (
        <section aria-labelledby="out-of-scope-heading">
          <div>
            <h2 id="out-of-scope-heading" className="bp-app-section-title">
              Outside the guarantee <span className="bp-kicker">{outOfScopeCases.length} cases</span>
            </h2>
            <p className="nl-ov-note" style={{ margin: "0 0 18px" }}>
              Scenarios outside the Scrip threat model (for example a leaked owner full-access key, a malicious token contract, or a lying RPC). Scrip does not claim to prevent these; they are recorded on purpose as stated limits.
            </p>
          </div>

          {outOfScopeCases.length === 0 ? (
            <div className="bp-plate p-4 text-xs text-bp-muted">
              The catalog has no OUT_OF_SCOPE cases right now.
            </div>
          ) : (
            <details className="nl-fold">
              <summary>Show all {outOfScopeCases.length} out-of-scope cases (every one labelled as expected)</summary>
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
            </details>
          )}
        </section>
      )}
    </div>
  );
}
