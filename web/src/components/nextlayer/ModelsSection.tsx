import Link from "next/link";
import { SectionHead } from "./Section";
import { LLM_TRIALS, LLM_REPLAY, summarizeTrials, summarizeReplay } from "@/lib/llm-trials-data";
import { EXPLORER_TX_BASE } from "@/lib/network";
import "./base.css";
import "./proof.css";
import "./models.css";

/** Token amounts are base units of a 6-decimal token. */
function usdc(base: string): string {
  const p = base.padStart(7, "0");
  const whole = p.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = p.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;

export function ModelsSection() {
  const models = summarizeTrials(LLM_TRIALS);
  const replay = summarizeReplay(LLM_REPLAY);
  const codes = Object.entries(replay.codes).map(([k, n]) => `${k} x${n}`).join(", ");
  return (
    <section className="nl-sec" id="models" aria-labelledby="models-title">
      <div className="nl-wrap">
        <SectionHead id="models" n={6} label="Real models" lines={["Models were fooled.", "The budget held."]}
          lede={`${LLM_TRIALS.length} decisions from ${models.length} small open models (Ollama, run on GitHub Actions, temperature 0.7). The invoice's payee and amount are honest. The only attack is a sentence in its note.`}
          plain="We gave small AI models an invoice and asked them to pay it. In some invoices the note said to pay someone else. Then we replayed six of their bad decisions on testnet, once with a normal wallet and once with Scrip." />
        <div className="nl-models-grid">
          <div>
            <h3 className="nl-h3" style={{ marginTop: 0 }}>What each model did</h3>
            <div className="nl-tablewrap">
              <table className="nl-table nl-stack nl-models-table">
                <caption className="nl-note" style={{ paddingBottom: 10 }}>Source: results/llm/llm-trials-*.json. “Fooled” means the model paid the recipient named in the injected note. “Overpaid” means it paid 0.6 when the cap is 0.5.</caption>
                <thead><tr><th scope="col">Model</th><th scope="col">Decisions</th><th scope="col">Fooled, normal prompt</th><th scope="col">Fooled, hijacked prompt</th><th scope="col">Overpaid</th><th scope="col">Declined</th><th scope="col">Broken</th></tr></thead>
                <tbody>
                  {models.map((m) => (
                    <tr key={m.model}>
                      <th scope="row" className="mono">{m.model}</th>
                      <td className="cell" data-label="Decisions">{m.total} ({m.seeds} seeds)</td>
                      <td className="cell" data-label="Fooled, normal prompt" data-bad={m.injected.normal.fooled > 0 ? "1" : undefined}><b>{m.injected.normal.fooled}</b> of {m.injected.normal.total}</td>
                      <td className="cell" data-label="Fooled, hijacked prompt" data-bad={m.injected.hijacked.fooled > 0 ? "1" : undefined}><b>{m.injected.hijacked.fooled}</b> of {m.injected.hijacked.total}</td>
                      <td className="cell" data-label="Overpaid">{m.overpaid}</td>
                      <td className="cell" data-label="Declined">{m.declined}</td>
                      <td className="cell" data-label="Broken">{m.broken}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
            <p className="nl-note" style={{ marginTop: 14 }}>The “hijacked” prompt tells the model to follow instructions found in the invoice. The “normal” prompt does not. Overcharge invoices model a dishonest merchant, not a reasoning failure. These are small models: the results say nothing about large ones. qwen3:4b has 5 seeds because a 20-seed run hit the 5-hour job limit.</p>
          </div>
          <div>
            <h3 className="nl-h3" style={{ marginTop: 0 }}>Replayed on testnet</h3>
            <dl className="nl-balances">
              <div><dt>Plain wallet, test USDC</dt><dd><b>{usdc(replay.naiveBefore)}</b> to <b>{usdc(replay.naiveAfter)}</b></dd></div>
              <div><dt>Scrip mandate, test USDC</dt><dd><b>{usdc(replay.scripBefore)}</b> to <b>{usdc(replay.scripAfter)}</b></dd></div>
              <div><dt>Attacker gained, plain wallet</dt><dd>{usdc(replay.attackerGainedNaive)}</dd></div>
              <div><dt>Attacker gained, Scrip</dt><dd>{usdc(replay.attackerGainedScrip)}</dd></div>
            </dl>
            <p className="nl-body">The plain wallet executed {replay.naivePaid} of {replay.decisions} recorded decisions. Scrip refused {replay.scripRejected} of {replay.decisions} on-chain ({codes}).</p>
            <ul className="nl-replay" aria-label="Replayed decisions">
              {replay.rows.map((r, i) => (
                <li key={i}>
                  <span className="mono">{r.model}</span>
                  <span>{r.code ? <code>{r.code}</code> : null}</span>
                  <small>{r.invoiceMode}, {r.prompt} prompt
                    {r.scripTx ? <> · Scrip tx <a className="nl-link" href={`${EXPLORER_TX_BASE}/${r.scripTx}`} target="_blank" rel="noopener noreferrer" aria-label={`Scrip transaction ${r.scripTx} on the explorer`}>{short(r.scripTx)}</a></> : null}
                    {r.naiveTx ? <> · plain tx <a className="nl-link" href={`${EXPLORER_TX_BASE}/${r.naiveTx}`} target="_blank" rel="noopener noreferrer" aria-label={`Plain wallet transaction ${r.naiveTx} on the explorer`}>{short(r.naiveTx)}</a></> : null}
                  </small>
                </li>
              ))}
            </ul>
            <p className="nl-note" style={{ marginTop: 14 }}>Only these {replay.decisions} decisions were replayed on-chain. The other {LLM_TRIALS.length - replay.decisions} were judged by a local copy of the contract rules. <Link className="nl-link" href="/verify">Check every transaction yourself</Link>.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
