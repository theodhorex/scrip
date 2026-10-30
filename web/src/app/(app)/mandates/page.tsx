import { Suspense } from "react";
import Link from "next/link";
import { connection } from "next/server";
import { listMandates } from "@/lib/amanat";
import { formatTime, formatUsdc } from "@/lib/format";
import { BudgetBar } from "@/components/BudgetBar";
import { ChainError } from "@/components/ChainError";
import { LoadingState } from "@/components/LoadingState";
import { SampleDataBanner } from "@/components/SampleDataBanner";
import { StatusBadge } from "@/components/StatusBadge";

export default function MandatesPage() {
  return (
    <div>
      <header className="bp-app-head">
        <div>
          <span className="bp-chapter-label">Mandates</span>
          <h1 className="bp-app-title">Spending mandates</h1>
          <p className="bp-app-lede">
            Active and past spending boundaries configured for AI agents.
          </p>
        </div>
        <Link href="/mandates/new" className="bp-btn bp-btn-primary">+ Create mandate</Link>
      </header>

      <Suspense fallback={<LoadingState label="Loading mandates" />}>
        <MandatesContent />
      </Suspense>
    </div>
  );
}

// Reads the data source per request (Next.js "Streaming uncached data":
// 08-caching.md), so env and chain state are never frozen into the static shell.
async function MandatesContent() {
  await connection();
  let mandates;
  try {
    mandates = await listMandates();
  } catch (error) {
    return <ChainError error={error} />;
  }

  return (
    <>
      <SampleDataBanner />

      {mandates.length === 0 ? (
        <div role="status" className="bp-plate bp-app-empty">
          <div className="bp-app-empty-icon bp-app-mono" aria-hidden="true">0</div>
          <h2 className="bp-app-notice-title">No mandates registered</h2>
          <p className="bp-app-notice-body mx-auto max-w-md">
            Define a capped spending mandate for an agent to see it here.
          </p>
          <Link href="/mandates/new" className="bp-btn bp-btn-secondary bp-btn-sm mt-5">
            + Create a new mandate
          </Link>
        </div>
      ) : (
        <ul role="list" className="bp-app-grid2">
          {mandates.map((m, i) => (
            <li
              key={m.id}
              className="bp-plate bp-app-card bp-app-enter"
              style={{ "--bp-app-delay": `${i * 90}ms` } as React.CSSProperties}
            >
              <div>
                <div className="flex items-center justify-between gap-2">
                  <div className="flex items-center gap-3">
                    <span className="bp-app-chip">#{m.id}</span>
                    <span className="text-xs text-bp-muted">
                      Token <span className="bp-app-mono text-bp-ink">{m.token}</span>
                    </span>
                  </div>
                  <StatusBadge status={m.status} />
                </div>

                <div className="mt-5">
                  <span className="bp-kicker">Agent account</span>
                  <p className="bp-app-mono mt-1 truncate text-sm font-semibold text-bp-ink">{m.agent}</p>
                </div>

                <div className="mt-6 space-y-2">
                  <div className="flex flex-wrap items-baseline justify-between gap-x-4 text-xs">
                    <span className="bp-app-mono text-bp-ink">
                      {formatUsdc(m.spent)} <span className="text-bp-muted">of</span> {formatUsdc(m.budget)}
                    </span>
                    <span className="bp-app-mono text-bp-muted">
                      Cap per payment {formatUsdc(m.perPaymentCap)}
                    </span>
                  </div>
                  <BudgetBar spent={m.spent} reserved={m.reserved} budget={m.budget} showLegend />
                </div>
              </div>

              <div className="mt-6 flex items-center justify-between gap-2 border-t border-bp-line pt-4 text-xs">
                <span className="bp-app-mono text-bp-muted">Expires {formatTime(m.expiresAtMs)}</span>
                <Link href={`/mandates/${m.id}`} className="bp-app-link-cta">
                  View mandate <span aria-hidden="true">&rarr;</span>
                </Link>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  );
}
