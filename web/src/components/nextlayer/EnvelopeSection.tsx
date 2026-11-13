import { SectionHead } from "./Section";
import { GUARD_RUN, formatRecorded } from "./data";
import "./base.css";
import "./proof.css";

const MARK: Record<string, string> = { allow: "✓", warn: "!", block: "✕" };

/** Provenance: the envelope module predates the hackathon; the contract and the rest were built during it. */
export function EnvelopeSection() {
  return (
    <section className="nl-sec" id="envelope" aria-labelledby="envelope-title">
      <div className="nl-wrap">
        <SectionHead id="envelope" n={6} label="Around the contract" lines={["One disposable account.", "One look at the recipient."]}
          plain="Two helper pieces around the contract: a throwaway account for the agent, and a check on who is being paid. The recipient check is not connected to payments yet." />
        <div className="nl-env">
          <div data-reveal="rise">
            <h3>Envelope</h3>
            <p className="nl-body">A throwaway sub-account that serves as the agent&apos;s identity and holds a single function-call key. It exists for one task and is deleted afterwards, so a leaked key has little to take and little time to use it.</p>
            <dl className="nl-prov">
              <div><dt>Before the hackathon</dt><dd>The envelope module (create, fund, sweep, delete) was already working on testnet.</dd></div>
              <div><dt>Built during it</dt><dd>The mandate contract, the guardian rules, the relayer and this site.</dd></div>
            </dl>
          </div>
          <div data-reveal="rise" style={{ "--i": 1 } as React.CSSProperties}>
            <h3>Counterparty guard</h3>
            <p className="nl-body">A client-side check that answers allow, warn or block before the agent signs, from account age, whether the account has contract code, earlier interactions and a blocklist that needs evidence. It is <strong>not wired into the payment flow yet</strong>, and the age and history signals depend on an external indexer.</p>
          </div>
        </div>
        <div className="nl-tablewrap" style={{ marginTop: 56 }}>
          <table className="nl-table nl-stack">
            <caption className="nl-note" style={{ paddingBottom: 10 }}>Counterparty guard demo. Source: results/demo-guard.json, recorded {formatRecorded(GUARD_RUN.recordedAt)}. Read-only: the guard recorded what it would have signed, no transaction was sent.</caption>
            <thead><tr><th scope="col">Scenario</th><th scope="col">Verdict</th><th scope="col">Why</th></tr></thead>
            <tbody>
              {GUARD_RUN.scenarios.map((x) => (
                <tr key={x.id}><th scope="row"><code>{x.id}</code></th>
                  <td data-label="Verdict"><span className="nl-verdict" data-v={x.verdict === "block" ? "FAIL" : "PASS"}><span aria-hidden="true">{MARK[x.verdict]} </span>{x.verdict}</span></td>
                  <td data-label="Why">{x.note}</td></tr>
              ))}
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
