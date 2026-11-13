"use client";

import { useEffect, useRef, useState, useSyncExternalStore } from "react";
import { SectionHead } from "./Section";
import { TweenNum } from "./TweenNum";
import { RuleScene, type RuleRun } from "./RuleScene";
import { gateIndexOf } from "@/lib/rule-scene";
import { REJECT_TEXT } from "./codes";
import { motionOK } from "./scroll-bus";
import {
  AMOUNT_MAX_MILLI, AMOUNT_MIN_MILLI, AMOUNT_STEP_MILLI, SIM, formatEvent, initialSim, milliToUnits,
  parseRuleQuery, submitPayment, toRuleQuery, type SimEvent, type SimInput, type SimState,
} from "@/lib/rule-sim";
import "./base.css";
import "./rules.css";

const usd = (units: string) => Number(BigInt(units)) / 1_000_000;
const subscribeHash = (cb: () => void) => { addEventListener("hashchange", cb); return () => removeEventListener("hashchange", cb); };

type Outcome = { n: number; ok: boolean; code?: string; amount: number; to: string } | null;

/** Deep link: #rules?to=unknown&amount=300 (amount in thousandths of a USDC). The key remounts the machine when the link changes. */
export function RuleMachine() {
  const hash = useSyncExternalStore(subscribeHash, () => location.hash, () => "");
  const q = hash.startsWith("#rules?") ? hash.slice(7) : "";
  useEffect(() => { if (q) document.getElementById("rules")?.scrollIntoView(); }, [q]);
  return <Machine key={q} initial={parseRuleQuery(q)} />;
}

function Machine({ initial }: { initial: SimInput }) {
  const [input, setInput] = useState<SimInput>(initial);
  const [ledger, setLedger] = useState<SimState>(initialSim);
  const [view, setView] = useState<SimState>(initialSim);
  const [log, setLog] = useState<{ id: number; ev: SimEvent }[]>([]);
  const [out, setOut] = useState<Outcome>(null);
  const [busy, setBusy] = useState(false);
  const [run, setRun] = useState<RuleRun>(null);
  const [copied, setCopied] = useState<"" | "log" | "link">("");
  const timers = useRef<number[]>([]);
  const panel = useRef<HTMLDivElement>(null);
  const seq = useRef(0);
  const later = (fn: () => void, ms: number) => { timers.current.push(window.setTimeout(fn, ms)); };
  useEffect(() => { const t = timers.current; return () => t.forEach(clearTimeout); }, []);

  const push = (ev: SimEvent) => setLog((l) => [...l, { id: ++seq.current, ev }]);

  function send(e?: React.FormEvent) {
    e?.preventDefault();
    if (busy) return;
    const r = submitPayment(ledger, input);
    const n = (out?.n ?? 0) + 1;
    const amount = input.amountMilli / 1000;
    const to = input.to === "allowed" ? SIM.merchant : SIM.stranger;
    const fast = !motionOK();
    setBusy(true);
    setRun({ n, failIndex: r.outcome === "rejected" ? gateIndexOf(r.code ?? "") : null });
    if (r.outcome === "rejected") {
      push(r.events[0]);
      setOut({ n, ok: false, code: r.code, amount, to });
      if (!fast) panel.current?.animate(
        [{ transform: "translateX(0)" }, { transform: "translateX(-4px)" }, { transform: "translateX(4px)" }, { transform: "translateX(-2px)" }, { transform: "translateX(0)" }],
        { duration: 240, easing: "cubic-bezier(.22,1,.36,1)" },
      );
      later(() => setBusy(false), fast ? 0 : 320);
      return;
    }
    // accepted: reserved first, then settled
    push(r.events[0]);
    setView(r.reservedState);
    later(() => {
      push(r.events[1]);
      setView(r.state);
      setLedger(r.state);
      setOut({ n, ok: true, amount, to });
      setBusy(false);
    }, fast ? 0 : 520);
  }

  function reset() {
    timers.current.forEach(clearTimeout);
    timers.current = [];
    setLedger(initialSim()); setView(initialSim()); setLog([]); setOut(null); setBusy(false); setRun(null);
  }
  function preset(p: SimInput) { setInput(p); }
  async function copy(kind: "log" | "link") {
    const text = kind === "log"
      ? log.map((l) => formatEvent(l.ev)).join("\n")
      : `${location.origin}${location.pathname}#rules?${toRuleQuery(input)}`;
    try { await navigator.clipboard.writeText(text); setCopied(kind); later(() => setCopied(""), 1200); } catch { /* clipboard blocked: nothing to do */ }
  }

  const spent = usd(view.spent), reserved = usd(view.reserved), budget = usd(SIM.budget), deposited = usd(SIM.deposited);
  const free = Math.max(0, Math.min(budget, deposited) - spent - reserved);
  const pct = (v: number) => `${(v / deposited) * 100}%`;
  const needsApproval = BigInt(milliToUnits(input.amountMilli)) > BigInt(SIM.approvalThreshold);
  const info = out && !out.ok && out.code ? REJECT_TEXT[out.code] : null;

  return (
    <div className="nl-rm">
      <form className="nl-rm-form" onSubmit={send} aria-label="Payment request">
        <div className="nl-field">
          <label htmlFor="rm-to">Recipient</label>
          <select id="rm-to" className="nl-select" value={input.to} onChange={(e) => setInput({ ...input, to: e.target.value === "unknown" ? "unknown" : "allowed" })}>
            <option value="allowed">{SIM.merchant} (on the list)</option>
            <option value="unknown">{SIM.stranger} (not on the list)</option>
          </select>
        </div>
        <div className="nl-field">
          <label htmlFor="rm-amount">Amount</label>
          <div className="nl-amount"><output htmlFor="rm-amount">{(input.amountMilli / 1000).toFixed(2)}</output><span className="mono nl-note">USDC (test)</span></div>
          <input id="rm-amount" className="nl-range" type="range" min={AMOUNT_MIN_MILLI} max={AMOUNT_MAX_MILLI} step={AMOUNT_STEP_MILLI}
            value={input.amountMilli} onChange={(e) => setInput({ ...input, amountMilli: Number(e.target.value) })}
            aria-valuetext={`${(input.amountMilli / 1000).toFixed(2)} USDC`} />
          <div className="nl-ticks nl-ticks-wrap" aria-hidden="true">
            <span style={{ left: `${((250 - AMOUNT_MIN_MILLI) / (AMOUNT_MAX_MILLI - AMOUNT_MIN_MILLI)) * 100}%` }}>approval above 0.25</span>
            <span style={{ left: `${((400 - AMOUNT_MIN_MILLI) / (AMOUNT_MAX_MILLI - AMOUNT_MIN_MILLI)) * 100}%`, paddingTop: 30 }}>cap 0.40</span>
          </div>
        </div>
        <div className="nl-field" style={{ marginTop: 18 }}>
          <button type="button" className="nl-switch" role="switch" aria-checked={input.approved} onClick={() => setInput({ ...input, approved: !input.approved })}>
            <span>Guardian approved this payment</span><span className="nl-switch-track" aria-hidden="true" />
          </button>
          <p className="nl-note">{needsApproval ? "This amount is above the threshold, so an approval is needed." : "Not needed at this amount."} An approval is tied to one recipient, one amount and one nonce.</p>
        </div>
        <div className="nl-actions-row">
          <button type="submit" className="nl-btn" data-primary disabled={busy}>Send payment</button>
          <button type="button" className="nl-btn" onClick={reset}>Reset</button>
          <button type="button" className="nl-btn" onClick={() => copy("link")}>{copied === "link" ? "Copied" : "Copy link"}</button>
        </div>
        <div className="nl-presets" role="group" aria-label="Try an example">
          <span>Try:</span>
          <button type="button" onClick={() => preset({ to: "unknown", amountMilli: 300, approved: false })}>a stranger account</button>
          <button type="button" onClick={() => preset({ to: "allowed", amountMilli: 500, approved: true })}>over the cap</button>
          <button type="button" onClick={() => preset({ to: "allowed", amountMilli: 300, approved: false })}>needs approval</button>
        </div>
        <dl className="nl-params" aria-label="Mandate used by the simulation">
          <dt>budget</dt><dd>1.00</dd><dt>per-payment cap</dt><dd>0.40</dd><dt>approval above</dt><dd>0.25</dd><dt>deposited</dt><dd>1.50</dd><dt>recipients</dt><dd>{SIM.merchant}</dd>
        </dl>
      </form>

      <div className="nl-rm-out">
        <RuleScene milli={input.amountMilli} stranger={input.to === "unknown"} approved={input.approved} needsApproval={needsApproval}
          spentFrac={spent / budget} reservedFrac={reserved / budget} run={run} />
        <div className="nl-rm-panel" ref={panel}>
          {out && !out.ok ? <span className="nl-sweep" key={out.n} aria-hidden="true" /> : null}
          <div className="nl-result" role="status" aria-live="polite">
            {!out ? (
              <>
                <p className="nl-result-head">No request yet.</p>
                <p>Pick a recipient and an amount, then send. Try to push the budget line.</p>
              </>
            ) : out.ok ? (
              <>
                <p className="nl-result-head">Settled: {out.amount.toFixed(2)} USDC to {out.to}.</p>
                <p>All seven checks passed. The amount was reserved, the transfer ran, and the reservation became spent.</p>
              </>
            ) : (
              <>
                <p className="nl-result-head" data-bad>Rejected: <code>{out.code}</code></p>
                <p>{info?.text}</p>
                <p className="nl-note">{info?.step}. Nothing was reserved. The ledger did not change.</p>
              </>
            )}
          </div>
          <div className="nl-meter" role="img" aria-label={`Spent ${spent.toFixed(2)}, reserved ${reserved.toFixed(2)}, free ${free.toFixed(2)}, budget ${budget.toFixed(2)}`}>
            <div className="nl-meter-spent" style={{ width: pct(spent), transition: "width .6s cubic-bezier(.22,1,.36,1)" }} />
            <div className="nl-meter-res" style={{ left: pct(spent), width: pct(reserved), transition: "all .5s cubic-bezier(.22,1,.36,1)" }} />
            <span className="nl-budgetline" style={{ left: pct(budget) }} />
          </div>
          <div className="nl-meter-caption"><span>0</span><span>budget 1.00</span><span>deposited 1.50</span></div>
          <dl className="nl-rm-nums">
            <div><dt>Spent</dt><dd><TweenNum value={spent} /></dd></div>
            <div><dt>Reserved</dt><dd><TweenNum value={reserved} /></dd></div>
            <div><dt>Free</dt><dd><TweenNum value={free} /></dd></div>
          </dl>
        </div>

        <div className="nl-log-wrap">
          <div className="nl-log-head">
            <span>Event log (NEP-297 lines, same envelope as the contract)</span>
            <button type="button" onClick={() => copy("log")} disabled={log.length === 0}>{copied === "log" ? "Copied" : "Copy log"}</button>
          </div>
          {log.length === 0 ? <p className="nl-log-empty">Events appear here.</p> : (
            <ol data-lenis-prevent className="nl-log mono" aria-label="Event log">
              {log.map((l, i) => <li key={l.id} data-ev={l.ev.event} data-new={i === log.length - 1 ? "" : undefined}>{formatEvent(l.ev)}</li>)}
            </ol>
          )}
        </div>
        <p className="nl-note" style={{ marginTop: 22 }}>Browser simulation of the contract&apos;s rules. Not a live chain call. Illustrative mandate, no recorded numbers. Event standard string is the contract&apos;s own: &quot;scrip&quot;.</p>
      </div>
    </div>
  );
}

export function RulesSection() {
  return (
    <section className="nl-sec" id="rules" aria-labelledby="rules-title">
      <div className="nl-wrap">
        <SectionHead id="rules" n={2} label="The rule machine" lines={["Send a payment.", "Break a rule."]}
          lede={<>These are the contract&apos;s checks, in the contract&apos;s order. Losses are capped by the sixth one: <strong>spent + reserved + amount can never pass the budget</strong>.</>}
          todo="Pick who gets paid and how much, press Send payment, then read the answer on the right."
          plain="Try to make a payment. Pick a stranger, or an amount that is too big, and watch the contract say no and say why. Nothing real is spent: this runs in your browser." />
        <RuleMachine />
      </div>
    </section>
  );
}
