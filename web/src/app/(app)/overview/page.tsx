import Link from "next/link";

const GUARANTEES = [
  {
    title: "Budget reserved before transfer",
    body: "The contract reserves budget before the transfer is sent, so concurrent requests are checked against one running total.",
  },
  {
    title: "Recipient allowlist",
    body: "Transfers are limited to destination accounts the owner approved in advance.",
  },
  {
    title: "Guardian approval above threshold",
    body: "Payments above the approval threshold need an explicit guardian approval before they are sent.",
  },
];

export default function Home() {
  return (
    <div className="bp-app-stack">
      <header className="bp-app-head">
        <div>
          <span className="bp-chapter-label">Overview</span>
          <h1 className="bp-app-title">Capped spending mandates for AI agents.</h1>
          <p className="bp-app-lede">
            Autonomous agents cannot safely hold unconstrained private keys, because what is
            approved is not bound to what is executed. Without on-chain invariant enforcement,
            concurrent race conditions or prompt injections can drain an agent&apos;s allocated
            balance.
          </p>
        </div>
        <div className="flex flex-wrap gap-3">
          <Link href="/mandates" className="bp-btn bp-btn-primary">Explore mandates</Link>
          <Link href="/attack" className="bp-btn bp-btn-secondary">View attack demo</Link>
        </div>
      </header>

      <section aria-labelledby="enforce-heading">
        <h2 id="enforce-heading" className="bp-app-section-title">
          What the Scrip mandate is designed to enforce on-chain
        </h2>
        <ul role="list" className="bp-app-grid3">
          {GUARANTEES.map((g, i) => (
            <li
              key={g.title}
              className="bp-plate bp-app-plate bp-app-enter"
              style={{ "--bp-app-delay": `${i * 90}ms` } as React.CSSProperties}
            >
              <span className="bp-app-chip bp-app-chip-pass" aria-hidden="true">
                <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8">
                  <path d="M1.5 5.2 4 7.5l4.5-5" />
                </svg>
                RULE
              </span>
              <h3 className="mt-4 text-base font-semibold text-bp-ink">{g.title}</h3>
              <p className="mt-2 text-sm leading-relaxed text-bp-muted">{g.body}</p>
            </li>
          ))}
        </ul>
        <p className="mt-5 max-w-[62ch] text-xs leading-relaxed text-bp-muted">
          Status: specification and spike stage. The contract is not deployed yet, so these
          behaviors are design goals, not verified results.
        </p>
      </section>
    </div>
  );
}
