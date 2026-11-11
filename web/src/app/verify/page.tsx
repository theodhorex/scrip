"use client";

import { useState, useEffect, useCallback, Suspense } from "react";
import { Nav } from "@/components/Nav";
import { EXPLORER_TX_BASE } from "@/lib/network";
import {
  extractVerificationItems,
  fetchAndVerifyTx,
  runWithConcurrencyLimit,
  type VerificationItem,
  type VerificationResult,
  type VerificationVerdict,
} from "@/lib/verify-tx";

const SAMPLE_TX = "9UpU5SNwVwasrD2thdMtyoh9vdTkBcgjWLKMM7xV3k78";
const SAMPLE_SENDER = "dma42992.envtest-theo-1747.testnet";

const CURL_SAMPLE = `curl -X POST https://rpc.testnet.fastnear.com \\
  -H "Content-Type: application/json" \\
  -d '{
    "jsonrpc": "2.0",
    "id": "verify-sample",
    "method": "EXPERIMENTAL_tx_status",
    "params": [
      "${SAMPLE_TX}",
      "${SAMPLE_SENDER}"
    ]
  }'`;

function shortenHash(hash: string): string {
  if (hash.length <= 16) return hash;
  return `${hash.slice(0, 8)}...${hash.slice(-8)}`;
}

export default function VerifyPage() {
  const [items] = useState<VerificationItem[]>(() => extractVerificationItems());
  const [results, setResults] = useState<Record<string, VerificationResult>>({});
  const [running, setRunning] = useState(true);
  const [completedCount, setCompletedCount] = useState(0);
  const [runId, setRunId] = useState(1);

  const handleRunAgain = useCallback(() => {
    setResults({});
    setCompletedCount(0);
    setRunning(true);
    setRunId((id) => id + 1);
  }, []);

  useEffect(() => {
    let canceled = false;

    void runWithConcurrencyLimit(
      items,
      3,
      async (item) => {
        const res = await fetchAndVerifyTx({
          txHash: item.txHash,
          senderId: item.senderId,
          claim: item.claim,
          rpcUrl: "https://rpc.testnet.fastnear.com",
          timeoutMs: 10_000,
        });
        return { item, res };
      },
      ({ item, res }) => {
        if (!canceled) {
          setResults((prev) => ({ ...prev, [item.id]: res }));
          setCompletedCount((c) => c + 1);
        }
      },
    ).finally(() => {
      if (!canceled) {
        setRunning(false);
      }
    });

    return () => {
      canceled = true;
    };
  }, [items, runId]);

  // Compute counts
  let verified = 0;
  let mismatched = 0;
  let unverifiable = 0;

  for (const item of items) {
    const res = results[item.id];
    if (!res) continue;
    if (res.verdict === "VERIFIED") verified++;
    else if (res.verdict === "MISMATCHED") mismatched++;
    else if (res.verdict === "UNVERIFIABLE") unverifiable++;
  }

  return (
    <div className="blueprint-grid bp-app-shell min-h-screen">
      <Suspense fallback={<header className="bp-app-nav" style={{ height: "3.75rem" }} />}>
        <Nav />
      </Suspense>

      <main className="bp-app-main">
        <header className="bp-app-head">
          <div>
            <span className="bp-chapter-label">Verification</span>
            <h1 className="bp-app-title">Verify it yourself</h1>
            <p className="bp-app-lede">
              Every on-chain claim in Scrip can be independently verified against public NEAR
              testnet RPC records without trusted intermediaries or private API keys.
            </p>
          </div>
          <div className="flex items-center gap-3">
            <button
              type="button"
              onClick={handleRunAgain}
              disabled={running}
              className="bp-btn bp-btn-primary min-h-[44px] min-w-[44px] px-5 py-2.5 disabled:opacity-50"
            >
              {running ? (
                <>
                  <span className="inline-block h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent motion-reduce:animate-none" />
                  Verifying ({completedCount}/{items.length})...
                </>
              ) : (
                "Run again"
              )}
            </button>
          </div>
        </header>

        <section aria-labelledby="summary-heading" className="mb-8">
          <h2 id="summary-heading" className="sr-only">
            Verification Summary
          </h2>

          <div
            role="status"
            aria-live="polite"
            className="bp-plate bp-app-plate flex flex-wrap items-center justify-between gap-4"
          >
            <div>
              <span className="bp-app-label">Verification status</span>
              <p className="mt-1 text-base font-semibold text-bp-ink">
                {verified} verified / {mismatched} mismatched / {unverifiable} unverifiable
              </p>
            </div>

            <div className="flex flex-wrap items-center gap-3">
              <span className="bp-app-chip bp-app-chip-pass">
                {verified} Verified
              </span>
              <span className="bp-app-chip bp-app-chip-reject">
                {mismatched} Mismatched
              </span>
              <span className="bp-app-chip">
                {unverifiable} Unverifiable
              </span>
            </div>
          </div>
        </section>

        <section aria-labelledby="tx-table-heading" className="mb-10">
          <div className="flex items-baseline justify-between mb-3">
            <h2 id="tx-table-heading" className="bp-app-section-title">
              Recorded Testnet Transactions
            </h2>
            <span className="text-xs font-mono text-bp-muted">
              {items.length} recorded items
            </span>
          </div>

          <div className="bp-plate bp-app-table-wrap">
            <table className="bp-app-table">
              <thead>
                <tr>
                  <th scope="col">Transaction / Item</th>
                  <th scope="col">Source</th>
                  <th scope="col">Sender</th>
                  <th scope="col">Claim</th>
                  <th scope="col">Verdict</th>
                </tr>
              </thead>
              <tbody>
                {items.map((item) => {
                  const res = results[item.id];
                  const verdict: VerificationVerdict | "CHECKING" = res
                    ? res.verdict
                    : "CHECKING";

                  return (
                    <tr key={item.id}>
                      <th scope="row">
                        <div className="font-medium text-bp-ink">{item.label}</div>
                        <div className="mt-1 font-mono text-xs text-bp-muted">
                          <a
                            href={`${EXPLORER_TX_BASE}/${item.txHash}`}
                            target="_blank"
                            rel="noopener noreferrer"
                            className="bp-app-inline inline-flex items-center gap-1 font-mono hover:text-bp-pass"
                            title={`View ${item.txHash} on NearBlocks`}
                          >
                            <span>{shortenHash(item.txHash)}</span>
                            <span aria-hidden="true">&nearr;</span>
                          </a>
                        </div>
                      </th>
                      <td>
                        <span className="font-mono text-xs text-bp-muted">
                          {item.source}
                        </span>
                      </td>
                      <td>
                        {item.senderId ? (
                          <span className="font-mono text-xs text-bp-ink">
                            {item.senderId}
                          </span>
                        ) : (
                          <span className="font-mono text-xs text-bp-muted italic">
                            No sender recorded
                          </span>
                        )}
                      </td>
                      <td>
                        <span className="font-mono text-xs">
                          {item.claim.expectedSuccess ? (
                            <span className="text-bp-pass">SUCCESS</span>
                          ) : (
                            <span className="text-bp-reject">
                              FAIL: {item.claim.expectedErrorCode || "REJECTED"}
                            </span>
                          )}
                        </span>
                      </td>
                      <td>
                        {verdict === "CHECKING" && (
                          <span className="bp-app-chip opacity-70">
                            Checking...
                          </span>
                        )}
                        {verdict === "VERIFIED" && (
                          <span className="bp-app-chip bp-app-chip-pass">
                            Verified
                          </span>
                        )}
                        {verdict === "MISMATCHED" && (
                          <div>
                            <span className="bp-app-chip bp-app-chip-reject">
                              Mismatched
                            </span>
                            {res?.reason && (
                              <p className="mt-1 text-xs text-bp-reject">
                                {res.reason}
                              </p>
                            )}
                          </div>
                        )}
                        {verdict === "UNVERIFIABLE" && (
                          <div>
                            <span className="bp-app-chip">
                              Unverifiable
                            </span>
                            {res?.reason && (
                              <p className="mt-1 text-xs text-bp-muted" title={res.reason}>
                                {res.reason}
                              </p>
                            )}
                          </div>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        </section>

        <section aria-labelledby="raw-curl-heading" className="bp-plate bp-app-plate mb-10">
          <h2 id="raw-curl-heading" className="bp-app-section-title">
            Raw RPC Verification (curl)
          </h2>
          <p className="bp-app-lede text-sm mb-4">
            You do not need this web app to verify any transaction. Anyone can query the public
            NEAR testnet RPC directly with standard command-line tools. Note that NEAR requires
            both the transaction hash and the sender account ID for status queries.
          </p>

          <pre className="bp-app-code">
            <code>{CURL_SAMPLE}</code>
          </pre>

          <div className="mt-4 text-xs font-mono text-bp-muted space-y-1">
            <p>Target endpoint: https://rpc.testnet.fastnear.com (Public, no API key needed)</p>
            <p>JSON-RPC Method: EXPERIMENTAL_tx_status</p>
            <p>Explorer fallback: https://testnet.nearblocks.io/txns/{SAMPLE_TX}</p>
          </div>
        </section>
      </main>
    </div>
  );
}
