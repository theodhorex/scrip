import Link from "next/link";
import { VERIFIED_STATS, VERIFIED_STATS_NOTE } from "@/lib/verified-stats";

const START = [
  {
    href: "/try",
    title: "Try to steal",
    body: "You get a real agent's key. Try to send its money somewhere the rules do not allow. Every click is a real transaction.",
    meta: "No wallet needed",
  },
  {
    href: "/mandates/new",
    title: "Make your own",
    body: "Connect a testnet wallet, give your own agent a budget and rules, then try to break it yourself.",
    meta: "Testnet wallet",
  },
  {
    href: "/attack",
    title: "Attack results",
    body: "30 payments fired at once at a 1 USDC budget, and 1,999 recorded attacks. None got through.",
    meta: "1,999 cases",
  },
  {
    href: "/verify",
    title: "Verify it yourself",
    body: "Do not trust us: this page reads every transaction we cite back from the chain and compares it with our claim.",
    meta: "Public RPC, no key",
  },
];

const RULES = [
  { title: "Budget, reserved first", body: "Each payment reserves its amount before the transfer leaves, so parallel requests share one running total and can never overspend." },
  { title: "Recipient allowlist", body: "Money can only go to accounts the owner listed. Anything else is refused before a token moves." },
  { title: "Cap per payment", body: "No single payment can exceed the cap, whatever the agent was told." },
  { title: "Guardian above a threshold", body: "Larger payments need a single-use approval from a guardian, bound to the exact recipient, amount and nonce." },
];

export default function Home() {
  return (
    <div className="bp-app-stack">
      <header className="bp-app-head">
        <div>
          <span className="bp-chapter-label">How it works</span>
          <h1 className="bp-app-title">Give agents a budget, not your keys.</h1>
          <p className="bp-app-lede">
            AI agents get tricked. Scrip keeps an agent&apos;s money in a NEAR contract with rules the agent cannot change:
            who it may pay, how much at a time, and how much in total. The agent can only ask. The contract decides.
          </p>
        </div>
        <div className="nl-head-actions">
          <Link href="/try" className="bp-btn bp-btn-primary">Try to steal</Link>
          <Link href="/mandates/new" className="bp-btn bp-btn-secondary">Make your own</Link>
        </div>
      </header>

      <section aria-labelledby="start-heading">
        <h2 id="start-heading" className="bp-app-section-title">Start here</h2>
        <ul role="list" className="nl-ov-cards">
          {START.map((s, i) => (
            <li key={s.href}>
              <Link href={s.href} className="nl-ov-card">
                <span className="nl-ov-idx">{String(i + 1).padStart(2, "0")}</span>
                <span className="nl-ov-title">{s.title}</span>
                <span className="nl-ov-body">{s.body}</span>
                <span className="nl-ov-foot">
                  <span>{s.meta}</span>
                  <span aria-hidden="true">→</span>
                </span>
              </Link>
            </li>
          ))}
        </ul>
      </section>

      <section aria-labelledby="enforce-heading">
        <h2 id="enforce-heading" className="bp-app-section-title">What the contract enforces</h2>
        <ol className="nl-ov-rules">
          {RULES.map((r) => (
            <li key={r.title}>
              <h3>{r.title}</h3>
              <p>{r.body}</p>
            </li>
          ))}
        </ol>
      </section>

      <section aria-labelledby="evidence-heading">
        <h2 id="evidence-heading" className="bp-app-section-title">
          Evidence <span className="bp-kicker">{VERIFIED_STATS_NOTE}</span>
        </h2>
        <dl className="nl-ov-stats">
          {VERIFIED_STATS.map((s) => (
            <div key={s.label}>
              <dt>{s.label}</dt>
              <dd>{s.value}</dd>
              <dd className="nl-ov-src">{s.source}</dd>
            </div>
          ))}
        </dl>
        <p className="nl-ov-note">
          Testnet only, with test tokens. The contract has not been audited by a third party. Every recorded transaction
          can be re-checked on the <Link href="/verify" className="bp-app-inline">verify page</Link>.
        </p>
      </section>
    </div>
  );
}
