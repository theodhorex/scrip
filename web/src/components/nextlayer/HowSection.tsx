"use client";

import { useEffect, useRef, useState } from "react";
import { SectionHead } from "./Section";
import { TweenNum } from "./TweenNum";
import { onScroll } from "./scroll-bus";
import { HowScene } from "./HowScene";
import "./base.css";
import "./how.css";

/** Illustrative mandate for the walkthrough. The same numbers drive the rule machine below. Not recorded data. */
const STEPS = [
  {
    title: "The owner funds a mandate.",
    plain: "You put the money in and set the limits.",
    body: "The owner deposits test USDC into the Scrip contract and creates a mandate: a budget, a cap per payment, an approval threshold, the recipients that are allowed, an expiry and a guardian account. The contract holds the money. The agent never does.",
    code: "create_mandate(agent, budget, per_payment_cap,\n  approval_threshold, recipients, expires_at, guardian)",
    ledger: { deposited: 1.5, budget: 1.0, reserved: 0, spent: 0 },
  },
  {
    title: "The agent gets a key that can do one thing.",
    plain: "The agent gets a key that can only ask to pay. Nothing else.",
    body: "The agent signs with a function-call access key bound to request_payment on the Scrip contract. That key cannot send native NEAR, add or delete keys, or change the rules, and it cannot attach a deposit. A relayer pays the gas through a NEP-366 delegate action, so the agent holds no NEAR at all.",
    code: "receiver_id:  scrip contract\nmethod_names: [\"request_payment\"]\nallowance:    relayer-sponsored (NEP-366)",
    ledger: { deposited: 1.5, budget: 1.0, reserved: 0, spent: 0 },
  },
  {
    title: "The agent asks. The contract checks, in order.",
    plain: "Every request goes through the same checks. One failure and it is refused.",
    body: "request_payment(mandate_id, recipient, amount, nonce) runs a fixed sequence of checks and the first failure wins. If every check passes, the amount is reserved before any token moves, so a burst of requests cannot be paid twice from the same budget.",
    code: "1 status, expiry   2 recipient allowed\n3 amount <= cap    4 open requests < 32\n5 spent + reserved + amount <= budget\n6 above threshold? needs guardian approval",
    ledger: { deposited: 1.5, budget: 1.0, reserved: 0.2, spent: 0 },
  },
  {
    title: "The transfer settles, or the reservation is released.",
    plain: "Money moves only after the checks pass, and every step is recorded.",
    body: "The contract calls ft_transfer on the token, and a callback moves the reservation: success turns it into spent, failure releases it. Each step logs a NEP-297 event, so the whole history is readable from the chain.",
    code: 'EVENT_JSON:{"standard":"scrip","version":"1.0.0",\n  "event":"settled","data":[{"mandate_id":1,\n  "request_id":0,"recipient":"shop.testnet","amount":"200000"}]}',
    ledger: { deposited: 1.5, budget: 1.0, reserved: 0, spent: 0.2 },
  },
] as const;

export function HowSection() {
  const [active, setActive] = useState(0);
  const secRef = useRef<HTMLElement>(null);
  const listRef = useRef<HTMLOListElement>(null);
  const progress = useRef(0);

  useEffect(() => {
    const list = listRef.current;
    if (!list) return;
    const items = Array.from(list.querySelectorAll<HTMLElement>(".nl-step"));
    let cur = 0;
    return onScroll((_y, vh) => {
      const r = list.getBoundingClientRect();
      const p = Math.min(1, Math.max(0, (vh * 0.5 - r.top) / r.height));
      list.style.setProperty("--p", p.toFixed(4));
      progress.current = p;
      let best = 0, d = Infinity;
      items.forEach((it, i) => {
        const b = it.getBoundingClientRect();
        const dist = Math.abs(b.top + b.height / 2 - vh * 0.5);
        if (dist < d) { d = dist; best = i; }
      });
      if (best !== cur) { cur = best; setActive(best); }
    });
  }, []);

  const L = STEPS[active].ledger;
  const free = Math.max(0, Math.min(L.budget, L.deposited) - L.spent - L.reserved);
  const pct = (v: number) => `${(v / L.deposited) * 100}%`;

  return (
    <section className="nl-sec nl-how" id="how" aria-labelledby="how-title" ref={secRef}>
      <div className="nl-wrap">
        <SectionHead id="how" n={1} label="How it works" lines={["Four steps from", "deposit to payment."]}
          lede="The agent can ask for money. Only the contract decides whether it moves."
          todo="Just scroll. The picture and the numbers on the left follow each step."
          plain="You put money in and set limits. The agent can only ask to pay. A program on the blockchain checks every request and refuses anything outside your limits." />
        <div className="nl-how-grid">
          <aside className="nl-ledger" aria-label="Ledger for the worked example">
            <p className="nl-ledger-tag">Worked example (illustrative numbers). USDC, test token.</p>
            <dl>
              <div className="nl-ledger-row"><dt>Deposited</dt><dd><TweenNum value={L.deposited} /></dd></div>
              <div className="nl-ledger-row" data-hot><dt>Budget</dt><dd><TweenNum value={L.budget} /></dd></div>
              <div className="nl-ledger-row"><dt>Reserved</dt><dd><TweenNum value={L.reserved} /></dd></div>
              <div className="nl-ledger-row"><dt>Spent</dt><dd><TweenNum value={L.spent} /></dd></div>
              <div className="nl-ledger-row" data-key><dt>Free</dt><dd><TweenNum value={free} /></dd></div>
            </dl>
            <div className="nl-meter" role="img" aria-label={`Spent ${L.spent.toFixed(2)}, reserved ${L.reserved.toFixed(2)}, free ${free.toFixed(2)} of a budget of ${L.budget.toFixed(2)}`}>
              <div className="nl-meter-spent" style={{ width: pct(L.spent), transition: "width .7s cubic-bezier(.22,1,.36,1)" }} />
              <div className="nl-meter-res" style={{ left: pct(L.spent), width: pct(L.reserved), transition: "all .7s cubic-bezier(.22,1,.36,1)" }} />
              <span className="nl-budgetline" style={{ left: pct(L.budget) }} />
            </div>
            <div className="nl-meter-caption"><span>0</span><span>budget {L.budget.toFixed(2)} (never crossed)</span><span>deposited {L.deposited.toFixed(2)}</span></div>
            <HowScene step={active} progress={progress} />
          </aside>
          <ol className="nl-steps" ref={listRef}>
            <span className="nl-steps-fill" aria-hidden="true" />
            {STEPS.map((s, i) => (
              <li className="nl-step" key={s.title} data-active={i === active ? "" : undefined} aria-current={i === active ? "step" : undefined}>
                <span className="nl-step-n">Step {i + 1} of 4</span>
                <h3>{s.title}</h3>
                <p className="nl-plainstep">{s.plain}</p>
                <details className="nl-tech"><summary>Technical detail</summary>
                  <p className="nl-body">{s.body}</p>
                  <code className="nl-code">{s.code}</code>
                </details>
              </li>
            ))}
          </ol>
        </div>
      </div>
    </section>
  );
}
