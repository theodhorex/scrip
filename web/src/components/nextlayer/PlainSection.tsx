import { SectionHead } from "./Section";
import "./base.css";
import "./plain.css";
import "./read.css";

/** Plain-language entry for people who have never heard of NEAR or mandates. No jargon without its meaning next to it. */
const POINTS = [
  { k: "The problem", t: "AI agents are starting to pay for things on their own.", b: "To do that today, you hand an agent a wallet or a secret key. If the agent is tricked or just makes a mistake, it can spend everything in it." },
  { k: "The idea", t: "Think of a company card with a spending limit.", b: "You decide the total budget, the most it may pay at once, and who it may pay. The agent can ask to spend. It cannot spend more than you allowed, whatever it is told." },
  { k: "Why you can rely on it", t: "The limit is enforced by code, not by a promise.", b: "The rules live in a smart contract on the NEAR blockchain, a public program whose rules are visible to everyone. The agent cannot change them; only the owner can tighten or revoke them. Even if the agent&apos;s own key is stolen, it cannot get past them." },
  { k: "Where it stands", t: "A working prototype on a test network.", b: "Everything on this page runs on NEAR testnet with play money. No real funds are involved, and it has not been independently audited." },
] as const;

const ROLES = [
  { w: "Owner", d: "You. You put the money in and set the limits." },
  { w: "Agent", d: "The AI program that wants to pay. It can ask, nothing more." },
  { w: "Contract", d: "The program on the blockchain that checks every request and holds the money." },
  { w: "Guardian", d: "An optional second account that can approve big payments or make the rules stricter." },
] as const;

const WORDS = [
  ["Mandate", "One agent's set of limits: budget, per-payment cap, allowed recipients, expiry."],
  ["Budget", "The most the agent can spend in total under one mandate."],
  ["Per-payment cap", "The most it can spend in a single payment."],
  ["Approval threshold", "Payments above this amount need the guardian to approve that exact payment first."],
  ["Recipient allowlist", "The accounts the agent is allowed to pay. Anyone else is refused."],
  ["Smart contract", "A program that lives on a blockchain and runs exactly as written."],
  ["NEAR / testnet", "NEAR is the blockchain used here. Testnet is its practice network with no real money."],
  ["USDC", "A dollar-pegged digital currency. Here it is the test version."],
  ["Relayer", "A service that pays the network fees so the agent does not need to hold any funds."],
  ["Nonce", "A one-time number that stops the same approval from being reused."],
  ["NEP-141, NEP-297, NEP-366", "Names of NEAR technical standards (token, event log, fee sponsoring). Safe to skip."],
] as const;

export function PlainSection() {
  return (
    <section className="nl-sec" id="what" aria-labelledby="what-title">
      <div className="nl-wrap">
        <SectionHead id="what" n={0} label="In plain words" lines={["A spending limit", "for your AI agent."]}
          lede="Scrip lets an AI agent pay for things within limits you set, and makes those limits impossible for the agent to break." />
        <ol className="nl-points">
          {POINTS.map((p, i) => (
            <li key={p.k} data-reveal="rise" style={{ "--i": i % 2 } as React.CSSProperties}>
              <span className="nl-point-k">{p.k}</span>
              <div><h3>{p.t}</h3><p className="nl-body">{p.b}</p></div>
            </li>
          ))}
        </ol>
        <div className="nl-who" data-reveal="rise">
          <h3>Who is who</h3>
          <dl>{ROLES.map((r) => <div key={r.w}><dt>{r.w}</dt><dd>{r.d}</dd></div>)}</dl>
        </div>
        <div className="nl-plain-cta" data-reveal="rise">
          <a className="nl-pill" href="#rules">Try it: break a rule</a>
          <a className="nl-ghost" href="#how">See how it works</a>
          <a className="nl-ghost" href="#limits">Read the limits first</a>
        </div>
        <details className="nl-glossary">
          <summary>Words used on this page</summary>
          <dl>{WORDS.map(([w, d]) => <div key={w}><dt>{w}</dt><dd>{d}</dd></div>)}</dl>
        </details>
      </div>
    </section>
  );
}
