"use client";

import { useRef, useState } from "react";
import { SectionHead } from "./Section";
import { applyChange, type GuardianMandate, type GuardianRejectCode } from "@/lib/guardian";
import "./base.css";
import "./guardian.css";

const GUARD_TEXT: Record<GuardianRejectCode, string> = {
  NOT_STRICTER: "Tighten only accepts a stricter value than the current one.",
  NOT_LOOSER: "Loosen only accepts a looser value than the current one.",
  BUDGET_BELOW_COMMITTED: "The budget cannot drop below what is already spent plus reserved.",
  BUDGET_ABOVE_DEPOSITED: "The budget cannot be raised above what was deposited.",
  BUDGET_BELOW_CAP: "The budget cannot drop below the per-payment cap.",
  CAP_BELOW_THRESHOLD: "The cap cannot drop below the approval threshold.",
  CAP_ABOVE_BUDGET: "The cap cannot be raised above the budget.",
  THRESHOLD_ABOVE_CAP: "The approval threshold cannot be raised above the cap.",
  EXPIRY_NOT_IN_FUTURE: "The new expiry must still be in the future.",
  NO_SUCH_RECIPIENT: "That recipient is not on the list.",
  DUPLICATE_RECIPIENT: "That recipient is already on the list.",
  TOO_MANY_RECIPIENTS: "The recipient list is full.",
  INVALID_RECIPIENT: "That is not a valid account id.",
  NOT_ACTIVE: "The mandate is not active.",
};
type Field = "Budget" | "PerPaymentCap" | "ApprovalThreshold";
const FIELD_LABEL: Record<Field, string> = { Budget: "Budget", PerPaymentCap: "Per-payment cap", ApprovalThreshold: "Approval threshold" };
const START = { budget: 1_000_000, perPaymentCap: 400_000, approvalThreshold: 250_000 };
const STATE = { deposited: "1500000", spent: "200000", reserved: "0", nowMs: 1_800_000_000_000 } as const;
const toUnits = (v: string) => Math.round(Number(v) * 1_000_000);

export function GuardianDemo() {
  const [m, setM] = useState<GuardianMandate>({ status: "Active", budget: String(START.budget), perPaymentCap: String(START.perPaymentCap), approvalThreshold: String(START.approvalThreshold), expiresAtMs: 1_900_000_000_000, recipients: ["shop.testnet"] });
  const [mode, setMode] = useState<"tighten" | "loosen">("tighten");
  const [field, setField] = useState<Field>("Budget");
  const [val, setVal] = useState("0.80");
  const [res, setRes] = useState<{ ok: boolean; code?: GuardianRejectCode; line: string } | null>(null);
  const [flash, setFlash] = useState<Field | null>(null);
  const resRef = useRef(0);

  function run(e?: React.FormEvent) {
    e?.preventDefault();
    const n = toUnits(val);
    if (!Number.isFinite(n) || n < 0) { setRes({ ok: false, line: "Enter an amount of 0 or more." }); return; }
    const r = applyChange(mode, m, STATE, { [field]: String(n) } as never);
    resRef.current += 1;
    if (r.ok) {
      setM(r.mandate);
      setFlash(field);
      setRes({ ok: true, line: `${mode === "tighten" ? "Tightened" : "Loosened"} ${FIELD_LABEL[field].toLowerCase()} to ${(n / 1e6).toFixed(2)}.` });
    } else setRes({ ok: false, code: r.code, line: GUARD_TEXT[r.code] });
  }
  const cur = (k: Field) => (Number(m[k === "Budget" ? "budget" : k === "PerPaymentCap" ? "perPaymentCap" : "approvalThreshold"]) / 1e6).toFixed(2);
  const rows: [Field, string][] = [["Budget", cur("Budget")], ["PerPaymentCap", cur("PerPaymentCap")], ["ApprovalThreshold", cur("ApprovalThreshold")]];

  return (
    <div className="nl-guard">
      <form className="nl-guard-form" onSubmit={run} aria-label="Guardian rule change">
        <div className="nl-field">
          <span className="nl-note">Who is acting</span>
          <div className="nl-seg" role="group" aria-label="Change direction">
            <button type="button" aria-pressed={mode === "tighten"} onClick={() => setMode("tighten")}>Tighten</button>
            <button type="button" aria-pressed={mode === "loosen"} onClick={() => setMode("loosen")}>Loosen</button>
          </div>
          <p className="nl-note">{mode === "tighten" ? "Owner or guardian. Only stricter values pass." : "Guardian only. Only looser values pass, and only within the bounds."}</p>
        </div>
        <div className="nl-field">
          <label htmlFor="g-field">Rule</label>
          <select id="g-field" className="nl-select" value={field} onChange={(e) => setField(e.target.value as Field)}>
            {(Object.keys(FIELD_LABEL) as Field[]).map((f) => <option key={f} value={f}>{FIELD_LABEL[f]}</option>)}
          </select>
        </div>
        <div className="nl-field">
          <label htmlFor="g-val">New value (USDC)</label>
          <div className="nl-numin"><input id="g-val" inputMode="decimal" value={val} onChange={(e) => setVal(e.target.value)} /></div>
        </div>
        <div className="nl-actions-row">
          <button type="submit" className="nl-btn" data-primary>Apply as {mode}</button>
          <button type="button" className="nl-btn" onClick={() => { setM({ ...m, budget: String(START.budget), perPaymentCap: String(START.perPaymentCap), approvalThreshold: String(START.approvalThreshold) }); setRes(null); setFlash(null); }}>Reset</button>
        </div>
      </form>
      <div>
        <dl className="nl-rules-now" aria-label="Current rules">
          {rows.map(([k, v]) => <div key={`${k}-${v}`} data-flash={flash === k ? "" : undefined}><dt>{FIELD_LABEL[k]}</dt><dd>{v}</dd></div>)}
          <div><dt>Deposited / already spent</dt><dd>1.50 / 0.20</dd></div>
        </dl>
        <div className="nl-guard-res" role="status" aria-live="polite">
          {!res ? <p className="nl-body">Try tightening the budget to 0.10, then loosen the cap to 0.90.</p> : res.ok ? (
            <><p className="nl-result-head">{res.line}</p></>
          ) : (
            <><p className="nl-result-head" data-bad>Rejected{res.code ? <>: <code>{res.code}</code></> : null}</p><p className="nl-body">{res.line}</p></>
          )}
        </div>
        <p className="nl-note" style={{ marginTop: 20 }}>Browser simulation of tighten and loosen. Illustrative mandate, not a chain call. Codes are the contract&apos;s own.</p>
      </div>
    </div>
  );
}

export function GuardianSection() {
  return (
    <section className="nl-sec" id="guardian" aria-labelledby="guardian-title">
      <div className="nl-wrap">
        <SectionHead id="guardian" n={4} label="Guardian" lines={["Tightening is free.", "Loosening has a gate."]}
          lede="Rules can always get stricter. Making them looser is limited to the guardian account, and then only within bounds."
          todo="Choose Tighten, change a value, press Apply. Then choose Loosen and try the same."
          plain="A second person (the guardian) can make the rules stricter at any moment. Only they can loosen them, and never past what the owner set." />
        <GuardianDemo />
        <div className="nl-cols2">
          <div data-reveal="rise">
            <h3>Large payments need an approval tied to that payment.</h3>
            <p className="nl-body">Above the approval threshold the guardian signs off on one recipient, one amount and one nonce. The contract stores a hash of that intent, so an approval for 0.30 USDC cannot be reused for 0.31, and it can be spent only once.</p>
          </div>
          <div data-reveal="rise" style={{ "--i": 1 } as React.CSSProperties}>
            <h3>If a callback is ever lost.</h3>
            <p className="nl-body">Only the guardian can settle a stale reservation, and only as <code>transferred=true</code>. A claim that the transfer did <em>not</em> land is refused with <code>STALE_REFUND_UNPROVABLE</code>, because the chain cannot prove it. The amount stays locked inside its own mandate and cannot touch any other.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
