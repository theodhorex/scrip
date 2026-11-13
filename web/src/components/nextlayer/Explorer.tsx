"use client";

import { useMemo, useState } from "react";

export type ExplorerRow = { id: string; layer: string; category: string; verdict: string; expected: string; actual: string };
const LAYERS = ["A", "B", "C", "D", "E"] as const;
const VERDICTS = ["PASS", "FAIL", "SKIPPED", "BREACH"] as const;
const MARK: Record<string, string> = { PASS: "✓", FAIL: "✕", SKIPPED: "–", BREACH: "!" };
const PAGE = 40;

/** Explorer for results/attack-catalog.json. With no catalog it says so and shows nothing invented. */
export function Explorer({ rows, verifiedD }: { rows: ExplorerRow[]; verifiedD: { pass: number; total: number; asOf: string } }) {
  const [layer, setLayer] = useState<string>("all");
  const [verdict, setVerdict] = useState<string>("all");
  const [cat, setCat] = useState<string>("all");
  const [shown, setShown] = useState(PAGE);
  const cats = useMemo(() => Array.from(new Set(rows.map((r) => r.category))).sort(), [rows]);
  const count = (l: string, v: string) => rows.filter((r) => r.layer === l && r.verdict === v).length;
  const filtered = rows.filter((r) => (layer === "all" || r.layer === layer) && (verdict === "all" || r.verdict === verdict) && (cat === "all" || r.category === cat));
  const main = filtered.filter((r) => r.verdict !== "SKIPPED");
  const skipped = filtered.filter((r) => r.verdict === "SKIPPED");
  const has = rows.length > 0;

  return (
    <div className="nl-explorer">
      <div className="nl-tablewrap">
        <table className="nl-matrix">
          <caption className="nl-note" style={{ paddingBottom: 10 }}>
            {has ? "Verdicts by layer, from results/attack-catalog.json." : `Verdicts by layer. No catalog file yet: only layer D has a verified figure (${verifiedD.pass} of ${verifiedD.total}, as of ${verifiedD.asOf}). Dashes are not recorded, not zero.`}
          </caption>
          <thead><tr><th scope="col">Layer</th>{VERDICTS.map((v) => <th scope="col" key={v}>{v}</th>)}</tr></thead>
          <tbody>
            {LAYERS.map((l, i) => (
              <tr key={l} data-hot={layer === l ? "" : undefined}>
                <th scope="row">{l}</th>
                {VERDICTS.map((v, j) => {
                  const n = has ? count(l, v) : l === "D" && v === "PASS" ? verifiedD.pass : null;
                  return (
                    <td className="cell" key={v} data-bad={n && (v === "FAIL" || v === "BREACH") ? "1" : undefined}
                      data-reveal="wave" style={{ "--i": i * 4 + j } as React.CSSProperties}>
                      {n === null ? "–" : <b>{n}</b>}
                    </td>
                  );
                })}
              </tr>
            ))}
          </tbody>
        </table>
      </div>

      {!has ? (
        <div className="nl-empty">
          <p className="nl-body"><strong>The per-case explorer is empty on purpose.</strong> The attack catalog file has not been produced yet, so there are no cases to list and none are made up. When results/attack-catalog.json exists, this table fills with every case, filterable by layer, category and verdict.</p>
        </div>
      ) : (
        <>
          <div className="nl-filters">
            <div className="nl-chips" role="group" aria-label="Layer">
              {["all", ...LAYERS].map((l) => <button type="button" key={l} aria-pressed={layer === l} onClick={() => { setLayer(l); setShown(PAGE); }}>{l === "all" ? "All layers" : l}</button>)}
            </div>
            <div className="nl-chips" role="group" aria-label="Verdict">
              {["all", ...VERDICTS].map((v) => <button type="button" key={v} aria-pressed={verdict === v} onClick={() => { setVerdict(v); setShown(PAGE); }}>{v === "all" ? "All verdicts" : v}</button>)}
            </div>
            <label className="nl-note">Category <select className="nl-select" style={{ fontSize: 15, minHeight: 44 }} value={cat} onChange={(e) => { setCat(e.target.value); setShown(PAGE); }}>
              <option value="all">All</option>{cats.map((c) => <option key={c} value={c}>{c}</option>)}</select></label>
          </div>
          <p className="nl-note" role="status" aria-live="polite" style={{ marginBottom: 10 }}>{main.length} cases shown{skipped.length ? `, ${skipped.length} skipped listed below` : ""}.</p>
          <div className="nl-tablewrap">
            <table className="nl-table nl-stack">
              <thead><tr><th scope="col">Case</th><th scope="col">Layer</th><th scope="col">Category</th><th scope="col">Expected</th><th scope="col">Actual</th><th scope="col">Verdict</th></tr></thead>
              <tbody>
                {main.slice(0, shown).map((r) => (
                  <tr key={r.id}><th scope="row">{r.id}</th><td data-label="Layer">{r.layer}</td><td data-label="Category">{r.category}</td><td data-label="Expected">{r.expected}</td><td data-label="Actual">{r.actual}</td>
                    <td data-label="Verdict"><span className="nl-verdict" data-v={r.verdict}><span aria-hidden="true">{MARK[r.verdict] ?? "?"} </span>{r.verdict}</span></td></tr>
                ))}
              </tbody>
            </table>
          </div>
          {main.length > shown ? <button type="button" className="nl-btn" style={{ marginTop: 18 }} onClick={() => setShown(shown + PAGE)}>Show {Math.min(PAGE, main.length - shown)} more</button> : null}
          {skipped.length ? (
            <>
              <h3 className="nl-h3">Skipped, with the reason on record</h3>
              <ul className="nl-body" style={{ paddingLeft: 18 }}>
                {skipped.slice(0, 30).map((r) => <li key={r.id}><code>{r.id}</code> (layer {r.layer}): {r.actual || r.expected || "no reason recorded"}</li>)}
              </ul>
            </>
          ) : null}
        </>
      )}
    </div>
  );
}
