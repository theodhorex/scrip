import { Suspense } from "react";
import Link from "next/link";
import { notFound } from "next/navigation";
import { connection } from "next/server";
import { getMandate, listEvents } from "@/lib/amanat";
import { formatTime, formatUsdc, remaining } from "@/lib/format";
import { BudgetBar } from "@/components/BudgetBar";
import { ChainError } from "@/components/ChainError";
import { EventLog } from "@/components/EventLog";
import { LoadingState } from "@/components/LoadingState";
import { SampleDataBanner } from "@/components/SampleDataBanner";
import { Stat } from "@/components/Stat";
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
    ["Owner", mandate.owner],
    ["Guardian", mandate.guardian],
    ["Agent", mandate.agent],
    ["Token", mandate.token],
  ];

  return (
    <div className="bp-app-stack">
      <div>
        <header className="bp-app-head">
          <div>
            <div className="bp-chapter-label bp-app-crumbs">
              <Link href="/mandates" className="bp-app-inline">Mandates</Link>
              <span aria-hidden="true">/</span>
              <span className="bp-app-mono text-bp-ink">#{mandate.id}</span>
            </div>
            <h1 className="bp-app-title">Mandate #{mandate.id}</h1>
            <p className="bp-app-lede">
              Budget, limits, parties and audit trail for one agent spending mandate.
            </p>
          </div>
          <div className="flex flex-col items-start gap-2 sm:items-end">
            <StatusBadge status={mandate.status} />
            <span className="bp-app-mono text-xs text-bp-muted">Token {mandate.token}</span>
          </div>
        </header>
        <SampleDataBanner />

        <section aria-labelledby="budget-heading">
          <h2 id="budget-heading" className="bp-app-section-title">Budget allocation</h2>
          <div className="bp-plate bp-app-plate">
            <BudgetBar
              spent={mandate.spent}
              reserved={mandate.reserved}
              budget={mandate.budget}
              showLegend
            />
          </div>
        </section>
      </div>

      <section aria-labelledby="params-heading">
        <h2 id="params-heading" className="bp-app-section-title">Spending parameters</h2>
        <dl className="bp-app-grid3">
          <Stat label="Total budget" value={formatUsdc(mandate.budget)} hint="Maximum cumulative limit authorized" mono />
          <Stat label="Spent" value={formatUsdc(mandate.spent)} hint="Settled payments disbursed to recipients" mono />
          <Stat label="Reserved" value={formatUsdc(mandate.reserved)} hint="Earmarked for in-flight requests" mono />
          <Stat
            label="Remaining"
            value={formatUsdc(remaining(mandate.budget, mandate.spent, mandate.reserved))}
            hint="Available budget = budget - spent - reserved"
            mono
          />
          <Stat label="Withdrawn" value={formatUsdc(mandate.withdrawn)} hint="Reclaimed by mandate owner" mono />
          <Stat label="Per-payment cap" value={formatUsdc(mandate.perPaymentCap)} hint="Ceiling for any single autonomous request" mono />
          <Stat label="Approval threshold" value={formatUsdc(mandate.approvalThreshold)} hint="Amounts above this trigger guardian consent" mono />
          <Stat label="Open requests" value={mandate.openRequests.toString()} hint="Currently pending in-flight intents" mono />
          <Stat label="Expiration" value={formatTime(mandate.expiresAtMs)} hint="UTC timestamp when mandate ceases execution" mono />
        </dl>
      </section>

      <div className="bp-plate bp-plate-pass bp-app-notice">
        <span className="bp-app-chip bp-app-chip-pass" aria-hidden="true">INVARIANT</span>
        <div>
          <p className="bp-app-notice-title">Design invariant: spent + reserved must never exceed budget.</p>
          <p className="bp-app-notice-body">
            The contract is specified to reserve budget before it sends a transfer, so parallel
            requests share one running total. This is a design goal; it is not yet verified on testnet.
          </p>
        </div>
      </div>

      <section aria-labelledby="parties-heading">
        <h2 id="parties-heading" className="bp-app-section-title">Parties &amp; accounts</h2>
        <dl className="bp-plate bp-app-rows">
          {parties.map(([label, value]) => (
            <div key={label} className="bp-app-row">
              <dt className="bp-kicker">{label}</dt>
              <dd className="bp-app-mono m-0 text-sm text-bp-ink break-all">{value}</dd>
            </div>
          ))}
        </dl>
      </section>

      <section aria-labelledby="allow-heading">
        <h2 id="allow-heading" className="bp-app-section-title">
          Recipient allowlist <span className="bp-kicker">{mandate.recipients.length}</span>
        </h2>
        {mandate.recipients.length === 0 ? (
          <div role="status" className="bp-plate bp-app-empty">
            <h3 className="bp-app-notice-title">No recipients configured</h3>
            <p className="bp-app-notice-body">Without an allowlisted recipient, no transfer can be sent.</p>
          </div>
        ) : (
          <ul role="list" className="bp-plate bp-app-rows">
            {mandate.recipients.map((rec) => (
              <li key={rec} className="bp-app-row">
                <span className="bp-app-mono text-sm text-bp-ink break-all">{rec}</span>
                <span className="bp-app-chip bp-app-chip-pass">
                  <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
                    <path d="M1.5 5.2 4 7.5l4.5-5" />
                  </svg>
                  ALLOWED
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="events-heading">
        <h2 id="events-heading" className="bp-app-section-title">Event audit trail</h2>
        <EventLog events={events} />
      </section>
    </div>
  );
}
