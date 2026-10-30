import Link from "next/link";
import {
  loadAttackResults,
  loadAttackCatalog,
  formatUsdcUnits,
  buildCategoryMatrix,
  getOutOfScopeCases,
  CATEGORY_NAMES,
} from "@/lib/attack-data";

export default function AttackPage() {
  const results = loadAttackResults();
  const catalog = loadAttackCatalog();

  const naive = results?.naive ?? null;
  const amanat = results?.amanat ?? null;

  const catalogMatrix = catalog ? buildCategoryMatrix(catalog.cases) : [];
  const outOfScopeCases = catalog ? getOutOfScopeCases(catalog.cases) : [];

  return (
    <div className="bp-app-stack">
      <header className="bp-app-head" style={{ marginBottom: 0 }}>
        <div>
          <span className="bp-chapter-label">Attack demo</span>
          <h1 className="bp-app-title">Naive contract vs Amanat</h1>
          <p className="bp-app-lede">
            Concurrency stress test evaluating race condition defense under parallel payment requests.
          </p>
        </div>
        <Link href="/mandates" className="bp-btn bp-btn-secondary">View mandates</Link>
      </header>

      {!results ? (
        <div role="status" aria-live="polite" className="bp-plate bp-app-empty">
          <div className="bp-app-empty-icon bp-app-mono" aria-hidden="true">&ndash;</div>
          <h2 className="bp-app-notice-title">Hasil pengujian paralel belum dijalankan</h2>
          <p className="bp-app-notice-body mx-auto max-w-lg">
            Hasil benchmark akan dimuat dari <code className="bp-app-chip">results/attack.json</code> setelah testnet attack dijalankan.
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
          Benchmark comparison: Naive vs Amanat
        </h2>
        <div className="bp-plate bp-app-table-wrap">
          <table className="bp-app-table">
            <thead>
              <tr>
                <th scope="col" style={{ width: "36%" }}>Metric</th>
                <th scope="col">
                  Naive contract
                  <span className="block text-[11px] font-normal normal-case tracking-normal text-bp-muted">
                    Direct transfer without reservation
                  </span>
                </th>
                <th scope="col">
                  Amanat contract
                  <span className="block text-[11px] font-normal normal-case tracking-normal text-bp-pass">
                    Pre-transfer reservation lock
                  </span>
                </th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <th scope="row">Parallel requests</th>
                <td className="bp-app-mono">
                  {naive ? `${naive.broadcast.n} broadcast (${naive.broadcast.burstMs} ms)` : <span className="text-bp-muted">&ndash;</span>}
                </td>
                <td className="bp-app-mono">
                  {amanat ? `${amanat.broadcast.n} broadcast (${amanat.broadcast.burstMs} ms)` : <span className="text-bp-muted">&ndash;</span>}
                </td>
              </tr>
              <tr>
                <th scope="row">Configured budget</th>
                <td className="bp-app-mono">
                  {naive ? formatUsdcUnits(naive.budget) : <span className="text-bp-muted">&ndash;</span>}
                </td>
                <td className="bp-app-mono">
                  {amanat ? formatUsdcUnits(amanat.budget) : <span className="text-bp-muted">&ndash;</span>}
                </td>
              </tr>
              <tr>
                <th scope="row">Saldo merchant (Received)</th>
                <td className="bp-app-mono">
                  {naive ? (
                    <span className="text-bp-reject font-semibold">
                      {formatUsdcUnits(naive.merchantReceived)}
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
                <td className="bp-app-mono">
                  {amanat ? (
                    <span className="text-bp-pass font-semibold">
                      {formatUsdcUnits(amanat.merchantReceived)}
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Spent vs budget</th>
                <td className="bp-app-mono">
                  {naive ? (
                    <span>
                      {formatUsdcUnits(naive.spent)} / {formatUsdcUnits(naive.budget)}
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
                <td className="bp-app-mono">
                  {amanat ? (
                    <span>
                      {formatUsdcUnits(amanat.spent)} / {formatUsdcUnits(amanat.budget)}
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Budget overrun / deficit</th>
                <td className="bp-app-mono">
                  {naive ? (
                    <span className="bp-app-chip bp-app-chip-reject">
                      +{formatUsdcUnits(naive.overBudgetBy)} over budget
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
                <td className="bp-app-mono">
                  {amanat ? (
                    <span className="bp-app-chip bp-app-chip-pass">
                      +{formatUsdcUnits(amanat.overBudgetBy)} (0 overdraw)
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Permintaan diterima / ditolak</th>
                <td className="bp-app-mono">
                  {naive ? (
                    <span>
                      {naive.paymentsPaid} diterima / {naive.broadcast.n - Number(naive.paymentsPaid)} ditolak
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
                <td className="bp-app-mono">
                  {amanat ? (
                    <span>
                      {amanat.paymentsPaid} diterima / {amanat.broadcast.n - Number(amanat.paymentsPaid)} ditolak
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
              </tr>
              <tr>
                <th scope="row">Invariant preserved</th>
                <td>
                  {naive ? (
                    <span className="bp-app-chip bp-app-chip-reject">
                      BROKEN
                    </span>
                  ) : (
                    <span className="text-bp-muted">&ndash;</span>
                  )}
                </td>
                <td>
                  {amanat ? (
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
            Katalog variasi serangan
          </h2>
          {!catalog && <span className="bp-app-chip text-bp-muted">Belum dijalankan</span>}
        </div>

        {!catalog || catalog.cases.length === 0 ? (
          <div role="status" aria-live="polite" className="bp-plate bp-app-empty">
            <div className="bp-app-empty-icon bp-app-mono" aria-hidden="true">&ndash;</div>
            <h3 className="bp-app-notice-title">Katalog serangan belum dijalankan</h3>
            <p className="bp-app-notice-body mx-auto max-w-lg">
              Hasil pengujian katalog variasi serangan akan dimuat dari <code className="bp-app-chip">results/attack-catalog.json</code> setelah dijalankan.
            </p>
          </div>
        ) : (
          <div className="bp-plate bp-app-table-wrap">
            <table className="bp-app-table">
              <thead>
                <tr>
                  <th scope="col" style={{ width: "35%" }}>Kategori</th>
                  <th scope="col" style={{ width: "13%" }}>BLOCKED</th>
                  <th scope="col" style={{ width: "13%" }}>INERT</th>
                  <th scope="col" style={{ width: "13%" }}>OUT_OF_SCOPE</th>
                  <th scope="col" style={{ width: "13%" }}>BREACH</th>
                  <th scope="col" style={{ width: "13%" }}>Total</th>
                </tr>
              </thead>
              <tbody>
                {catalogMatrix.map((row) => (
                  <tr key={row.category}>
                    <th scope="row">
                      <span>{row.categoryName}</span>
                    </th>
                    <td className="bp-app-mono">
                      {row.blocked > 0 ? (
                        <span className="text-bp-pass font-semibold">{row.blocked}</span>
                      ) : (
                        <span className="text-bp-muted">0</span>
                      )}
                    </td>
                    <td className="bp-app-mono">
                      {row.inert > 0 ? (
                        <span>{row.inert}</span>
                      ) : (
                        <span className="text-bp-muted">0</span>
                      )}
                    </td>
                    <td className="bp-app-mono">
                      {row.outOfScope > 0 ? (
                        <span className="text-bp-muted font-medium">{row.outOfScope}</span>
                      ) : (
                        <span className="text-bp-muted">0</span>
                      )}
                    </td>
                    <td className="bp-app-mono">
                      {row.breach > 0 ? (
                        <span className="text-bp-reject font-bold">{row.breach}</span>
                      ) : (
                        <span className="text-bp-muted">0</span>
                      )}
                    </td>
                    <td className="bp-app-mono font-semibold">{row.total}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>

      {catalog && (
        <section aria-labelledby="out-of-scope-heading" className="mt-8">
          <div className="mb-3">
            <h3 id="out-of-scope-heading" className="bp-app-section-title" style={{ marginBottom: 0 }}>
              Di luar jaminan
            </h3>
            <p className="text-xs text-bp-muted mt-1 max-w-2xl leading-relaxed">
              Skenario di luar model ancaman Amanat (misal: kunci full-access owner bocor, kontrak token berbahaya, RPC berbohong). Kasus-kasus ini tidak diklaim dapat dicegah oleh protokol dan sengaja dicatat secara jujur sebagai batasan yang diakui.
            </p>
          </div>

          {outOfScopeCases.length === 0 ? (
            <div className="bp-plate p-4 text-xs text-bp-muted">
              Tidak ada kasus OUT_OF_SCOPE dalam katalog saat ini.
            </div>
          ) : (
            <div className="bp-plate bp-app-table-wrap">
              <table className="bp-app-table">
                <thead>
                  <tr>
                    <th scope="col" style={{ width: "25%" }}>ID / Kategori</th>
                    <th scope="col" style={{ width: "15%" }}>Lapis</th>
                    <th scope="col" style={{ width: "20%" }}>Label Diharapkan</th>
                    <th scope="col" style={{ width: "20%" }}>Label Aktual</th>
                    <th scope="col" style={{ width: "20%" }}>Verdict</th>
                  </tr>
                </thead>
                <tbody>
                  {outOfScopeCases.map((c, i) => (
                    <tr key={c.id ?? `oos-${i}`}>
                      <th scope="row">
                        <div className="font-semibold">{c.id ?? `Kasus ${i + 1}`}</div>
                        <div className="text-[11px] text-bp-muted font-normal">
                          {CATEGORY_NAMES[String(c.category)] ?? `Kategori ${c.category}`}
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
