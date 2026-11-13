"use client";

import { useId, useMemo, useState } from "react";
import { evaluate, type RejectCode } from "@/lib/rules";

type MandateArgs = {
  budget: string;
  per_payment_cap: string;
  approval_threshold: string;
  expires_at_ms: number;
  recipients: string[];
};

const EXPLAIN: Record<RejectCode, string> = {
  NOT_ACTIVE: "The mandate is not active.",
  EXPIRED: "The mandate has expired.",
  RECIPIENT_NOT_ALLOWED: "This recipient is not on the allowlist, so the contract refuses the payment.",
  OVER_PER_PAYMENT_CAP: "The amount is above the per-payment cap (or zero).",
  TOO_MANY_OPEN: "Too many payments are still waiting to settle.",
  OVER_BUDGET: "Spent so far plus this payment would go past the budget.",
  NEEDS_APPROVAL: "Above the approval threshold: the guardian must approve this exact payment first.",
  APPROVAL_USED: "This approval was already used.",
  APPROVAL_EXPIRED: "This approval has expired.",
};

function toUnits(usdc: string): string | null {
  const t = usdc.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return (BigInt(w) * BigInt(1000000) + BigInt(f.padEnd(6, "0"))).toString();
}

/** Lets a visitor try a payment against the mandate they are configuring. Runs the same rule order as the contract (src/lib/rules.ts) in the browser. No wallet, no transaction, no network call. */
export function TryPayment({ mandate }: { mandate: MandateArgs }) {
  const rid = useId(); const aid = useId(); const sid = useId();
  const [recipient, setRecipient] = useState("");
  const [amount, setAmount] = useState("1");
  const [spent, setSpent] = useState("0");
  const [run, setRun] = useState<{ n: number; at: number } | null>(null);
  const go = () => setRun((r) => ({ n: (r?.n ?? 0) + 1, at: Date.now() }));

  const target = recipient.trim() || mandate.recipients[0] || "";
  const amountUnits = toUnits(amount);
  const spentUnits = toUnits(spent);
  const inputError = amountUnits === null ? "Amount must be a number with up to 6 decimals." : spentUnits === null ? "Spent so far must be a number with up to 6 decimals." : null;

  const result = useMemo(() => {
    if (!run || inputError || amountUnits === null || spentUnits === null) return null;
    return evaluate(
      { status: "Active", expiresAtMs: mandate.expires_at_ms || Number.MAX_SAFE_INTEGER, recipients: mandate.recipients, perPaymentCap: mandate.per_payment_cap, budget: mandate.budget, approvalThreshold: mandate.approval_threshold },
      { deposited: mandate.budget, spent: spentUnits, nowMs: run.at },
      { recipient: target, amount: amountUnits, nonce: 1 },
    );
    // `run` is the trigger: the result only updates when the visitor presses a button.
  }, [run, inputError, amountUnits, spentUnits, target, mandate]);

  const attack = (r: string, a: string) => { setRecipient(r); setAmount(a); go(); };
  const cap = Number(mandate.per_payment_cap) / 1e6;
  const budget = Number(mandate.budget) / 1e6;

  return (
    <section className="bp-plate bp-app-plate bp-app-try" aria-labelledby={`${rid}-h`}>
      <h2 className="bp-app-section-title" id={`${rid}-h`} style={{ marginBottom: 4 }}>Try a payment</h2>
      <p className="bp-app-hint">Pretend to be the agent. The same rules as the contract run here in your browser. No wallet needed, nothing is sent.</p>
      <div className="bp-app-try-grid">
        <div>
          <label htmlFor={rid} className="bp-app-label">Pay to</label>
          <input id={rid} list={`${rid}-list`} value={recipient} placeholder={mandate.recipients[0] ?? "account.testnet"} onChange={(e) => setRecipient(e.target.value)} className="bp-app-input" autoComplete="off" spellCheck={false} />
          <datalist id={`${rid}-list`}>{mandate.recipients.map((r) => <option key={r} value={r} />)}</datalist>
        </div>
        <div>
          <label htmlFor={aid} className="bp-app-label">Amount (USDC)</label>
          <input id={aid} inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} className="bp-app-input" />
        </div>
        <div>
          <label htmlFor={sid} className="bp-app-label">Already spent (USDC)</label>
          <input id={sid} inputMode="decimal" value={spent} onChange={(e) => setSpent(e.target.value)} className="bp-app-input" />
        </div>
      </div>
      <div className="bp-app-try-actions">
        <button type="button" className="bp-btn bp-btn-primary" onClick={go}>Send payment</button>
        <span className="bp-app-hint">Or try an attack:</span>
        <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" onClick={() => attack("attacker.testnet", "1")}>Unknown recipient</button>
        <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" onClick={() => attack(mandate.recipients[0] ?? "", String(cap + 1))}>Over the cap</button>
        <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" onClick={() => { setSpent(String(budget)); attack(mandate.recipients[0] ?? "", String(Math.min(cap, 1))); }}>Budget used up</button>
      </div>
      <div role="status" aria-live="polite" className="bp-app-try-result" key={run?.n ?? 0}>
        {inputError ? <p className="text-bp-reject text-xs">{inputError}</p> : result === null ? <p className="bp-app-hint">Press a button to see what the contract would do.</p> : result.ok ? (
          <p><span className="bp-app-chip bp-app-chip-pass">ALLOWED</span> <span className="text-bp-muted text-xs">The payment passes every rule and would be sent.</span></p>
        ) : (
          <p><span className="bp-app-chip bp-app-chip-reject">REJECTED: {result.code}</span> <span className="text-bp-muted text-xs">{EXPLAIN[result.code]}</span></p>
        )}
      </div>
      <p className="bp-app-hint">Simulation only. The recorded runs on testnet are listed on the <a className="bp-app-inline" href="/verify">verify page</a>.</p>
    </section>
  );
}
