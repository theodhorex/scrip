import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getMandate, listEvents } from "@/lib/scrip";
import { formatTime, formatUsdc, remaining, tokenName } from "@/lib/format";
import { EXPLORER_ACCOUNT_BASE } from "@/lib/network";
import { BudgetBar } from "@/components/BudgetBar";
import { ChainError } from "@/components/ChainError";
import { EventLog } from "@/components/EventLog";
import { LoadingState } from "@/components/LoadingState";
import { SampleDataBanner } from "@/components/SampleDataBanner";
import { StatusBadge } from "@/components/StatusBadge";

// No generateStaticParams: it would hit the chain at build time. Ids resolve per
// request inside Suspense (08-caching.md "Streaming uncached data" / "params").
export default function MandateDetailPage({
  params,
}: {
  params: Promise<{ id: string }>;
}) {
  return (
    <Suspense fallback={<LoadingState label="Loading mandate" />}>
      <MandateDetail params={params} />
    </Suspense>
  );
}

async function MandateDetail({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  if (!/^(0|[1-9]\d*)$/.test(id)) {
    notFound();
  }
  const mandateId = Number(id);

  await connection();
  let mandate;
  let events;
  try {
    mandate = await getMandate(mandateId);
    events = mandate ? await listEvents(mandate.id) : [];
  } catch (error) {
    return <ChainError error={error} />;
  }
  if (!mandate) {
    notFound();
  }

  const parties = [
    ["Owner", mandate.owner, "Funds the mandate, can revoke it and withdraw what is left"],
    ["Agent", mandate.agent, "Can only request payments, inside the rules below"],
    ["Guardian", mandate.guardian, "Approves payments above the threshold; can revoke"],
    ["Token", mandate.token, tokenName(mandate.token)],
  ];
  const left = remaining(mandate.budget, mandate.spent, mandate.reserved);
  const key = [
    ["Left to spend", formatUsdc(left)],
    ["Spent", formatUsdc(mandate.spent)],
    ["Cap per payment", formatUsdc(mandate.perPaymentCap)],
    ["Guardian approval above", formatUsdc(mandate.approvalThreshold)],
  ];
  const more = [
    ["Budget", formatUsdc(mandate.budget)],
    ["Reserved (in flight)", formatUsdc(mandate.reserved)],
    ["Withdrawn by owner", formatUsdc(mandate.withdrawn)],
    ["Open requests", mandate.openRequests.toString()],
    ["Expires", formatTime(mandate.expiresAtMs)],
  ];

  return (
    <div className="bp-app-stack">
      <header className="bp-app-head">
        <div>
          <div className="bp-chapter-label bp-app-crumbs">
            <Link href="/mandates" className="bp-app-inline">Mandates</Link>
            <span aria-hidden="true">/</span>
            <span className="bp-app-mono text-bp-ink">#{mandate.id}</span>
          </div>
          <h1 className="bp-app-title">Mandate #{mandate.id}</h1>
          <p className="bp-app-lede">
            {tokenName(mandate.token)} that <span className="font-mono text-bp-ink">{mandate.agent}</span> may spend under
            the rules below. Every figure on this page is read from the contract.
          </p>
        </div>
        <div className="nl-head-actions">
          <StatusBadge status={mandate.status} />
          <Link href="/try" className="bp-btn bp-btn-primary">Send a payment</Link>
          <a className="bp-btn bp-btn-secondary" href={`${EXPLORER_ACCOUNT_BASE}/${mandate.agent}`} target="_blank" rel="noopener noreferrer">Agent on the explorer</a>
        </div>
      </header>

      <SampleDataBanner />

      <section aria-labelledby="budget-heading">
        <h2 id="budget-heading" className="bp-app-section-title">Budget</h2>
        <dl className="nl-kv-key">
          {key.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <div className="nl-kv-bar">
          <BudgetBar spent={mandate.spent} reserved={mandate.reserved} budget={mandate.budget} showLegend />
        </div>
        <dl className="nl-kv-more">
          {more.map(([label, value]) => (
            <div key={label}>
              <dt>{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
        </dl>
        <p className="nl-ov-note">
          Invariant: spent + reserved never exceeds the budget. Each payment reserves its amount before the transfer
          leaves, so parallel requests share one running total. Checked by property tests and by a 30-payment parallel
          burst on testnet (<Link href="/attack" className="bp-app-inline">attack demo</Link>).
        </p>
      </section>

      <div className="bp-app-grid2">
        <section aria-labelledby="parties-heading">
          <h2 id="parties-heading" className="bp-app-section-title">Parties</h2>
          <dl className="nl-rows">
            {parties.map(([label, value, note]) => (
              <div key={label}>
                <dt>{label}</dt>
                <dd className="font-mono">{value}</dd>
                <dd className="nl-rows-note">{note}</dd>
              </div>
            ))}
          </dl>
        </section>

        <section aria-labelledby="allow-heading">
          <h2 id="allow-heading" className="bp-app-section-title">
            Allowed recipients <span className="bp-kicker">{mandate.recipients.length}</span>
          </h2>
          {mandate.recipients.length === 0 ? (
            <div role="status" className="bp-plate bp-app-empty">
              <h3 className="bp-app-notice-title">No recipients configured</h3>
              <p className="bp-app-notice-body">Without an allowlisted recipient, no transfer can be sent.</p>
            </div>
          ) : (
            <ul role="list" className="nl-rows">
              {mandate.recipients.map((rec) => (
                <li key={rec} className="nl-rows-flex">
                  <a className="bp-app-inline font-mono" href={`${EXPLORER_ACCOUNT_BASE}/${rec}`} target="_blank" rel="noopener noreferrer">{rec}</a>
                  <span className="bp-app-chip bp-app-chip-pass">ALLOWED</span>
                </li>
              ))}
              <li className="nl-rows-note">Any other account is refused with RECIPIENT_NOT_ALLOWED before a token moves.</li>
            </ul>
          )}
        </section>
      </div>

      <section aria-labelledby="events-heading">
        <h2 id="events-heading" className="bp-app-section-title">
          Event trail <span className="bp-kicker">{events.length} events, newest first</span>
        </h2>
        <EventLog events={events} />
      </section>
    </div>
  );
}
