import Link from "next/link";
import { SectionHead } from "./Section";
import { Explorer, type ExplorerRow } from "./Explorer";
import { PROOF, formatRecorded } from "./data";
import { loadAttackCatalog, CATEGORY_NAMES } from "@/lib/attack-data";
import { VERIFIED_STATS, VERIFIED_STATS_NOTE } from "@/lib/verified-stats";
import "./base.css";
import "./proof.css";

function rowsFromCatalog(): ExplorerRow[] {
  const cat = loadAttackCatalog();
  if (!cat) return [];
  return cat.cases.map((c, i) => ({
    id: String(c.id ?? `case-${i + 1}`),
    layer: String(c.layer),
    category: CATEGORY_NAMES[String(c.category)] ?? String(c.category),
    verdict: String(c.verdict).toUpperCase(),
    expected: String(c.expected?.label ?? ""),
    actual: String(c.actual?.label ?? ""),
  }));
}

export function ProofSection() {
  const rows = rowsFromCatalog();
  return (
    <section className="nl-sec" id="proof" aria-labelledby="proof-title">
      <div className="nl-wrap">
        <SectionHead id="proof" n={5} label="Proof" lines={["What was attacked,", "and what held."]}
          lede="Two kinds of evidence: a live run on testnet, and a larger set of test cases. Each number says where it comes from and when."
          todo="Use the filters to see what was tested. Each row says when and where it ran."
          plain="Everything here was actually run, not drawn. Each number tells you what was tested, when, and on which network." />
        <div className="nl-proof-top">
          <div>
            <h3 className="nl-h3" style={{ marginTop: 0 }}>Five attacks on testnet, run on {formatRecorded(PROOF.startedAt)}</h3>
            <div className="nl-tablewrap">
              <table className="nl-table nl-stack">
                <caption className="nl-note" style={{ paddingBottom: 10 }}>Source: results/gate.json. Each attack was sent to the live contract and refused with this code.</caption>
                <thead><tr><th scope="col">Attack</th><th scope="col">Refused with</th><th scope="col">Transaction</th></tr></thead>
                <tbody>
                  {PROOF.attacks.map((a) => (
                    <tr key={a.key}>
                      <th scope="row">{a.label}</th>
                      <td data-label="Refused with"><code className="nl-reject">{a.rejectionCode}</code></td>
                      <td data-label="Transaction">{a.txHash ? <a className="nl-link mono" href={`https://testnet.nearblocks.io/txns/${a.txHash}`} rel="noreferrer noopener" target="_blank">{a.shortTx}</a> : <span className="nl-note">refused before broadcast (HTTP {a.httpStatus})</span>}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="nl-note" style={{ marginTop: 14 }}>The same run left {PROOF.cleanup.leftoverCount} leftover accounts.</p>
          </div>
          <div>
            <h3 className="nl-h3" style={{ marginTop: 0 }}>Test suites and checks</h3>
            <div className="nl-stats">
              {VERIFIED_STATS.map((s) => (
                <div className="nl-stat" key={s.label} data-reveal="rise"><b>{s.value}</b><span>{s.label}</span><small>{s.source}</small></div>
              ))}
            </div>
            <p className="nl-note" style={{ marginTop: 14 }}>Counts {VERIFIED_STATS_NOTE}. The catalog covers 1,999 listed cases in five layers (A contract, B relayer, C client, D sandbox, E live testnet).</p>
            <p className="nl-body" style={{ marginTop: 14 }}>Recorded transactions are re-checked against the public FastNear indexer on <Link className="nl-link" href="/verify">the verify page</Link>: 35 of 35 matched on 13 Nov 2026. Run <code>node scripts/verify-onchain.mjs</code> to do it yourself.</p>
          </div>
        </div>

        <h3 className="nl-h3">Attack catalog</h3>
        <Explorer rows={rows} verifiedD={{ pass: 160, total: 160, asOf: "12 Nov 2026" }} />
        <p style={{ marginTop: 28 }}><Link className="nl-link" href="/attack">Open the full attack page</Link></p>
      </div>
    </section>
  );
}
