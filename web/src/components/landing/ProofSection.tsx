"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  PROOF_DATA,
  explorerTxUrl,
  type ProofLandingData,
} from "@/lib/proof-data";
import { BlueprintFrame } from "./BlueprintFrame";
import { ProofScene, initialOpenDrawer } from "./iso/ProofScene";
import styles from "./ProofSection.module.css";
import { useAnimationActive } from "./useAnimationActive";
import { useReducedMotion } from "./useReducedMotion";

type Props = {
  data?: ProofLandingData;
};

export function ProofSection({ data = PROOF_DATA }: Props) {
  const prefersReducedMotion = useReducedMotion();
  const { containerRef, isViewportActive } = useAnimationActive<HTMLElement>();

  // Stable SSR-safe accessibility identifiers
  // Source: https://react.dev/reference/react/useId
  const receiptPanelId = useId();
  const liveRegionId = useId();

  // User manual interaction overrides initial automatic state
  // Source: https://react.dev/learn/you-might-not-need-an-effect
  const [selectedDrawer, setSelectedDrawer] = useState<number | null | undefined>(undefined);
  const [selectedAttackIndex, setSelectedAttackIndex] = useState<number | null>(null);
  const [copiedId, setCopiedId] = useState<string | null>(null);
  const [liveAnnouncement, setLiveAnnouncement] = useState<string>("");

  const defaultDrawer = initialOpenDrawer(prefersReducedMotion, isViewportActive);
  const openDrawerIndex = selectedDrawer !== undefined ? selectedDrawer : defaultDrawer;

  // Autoplay once when the diorama first enters the viewport: open drawers 01..07 slowly,
  // then stop. Any user interaction cancels it.
  const sceneHostRef = useRef<HTMLDivElement | null>(null);
  const autoTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const stepCount = data.steps.length;
  const cancelAutoplay = () => {
    for (const t of autoTimersRef.current) clearTimeout(t);
    autoTimersRef.current = [];
  };
  useEffect(() => {
    const el = sceneHostRef.current;
    if (!el || prefersReducedMotion || typeof IntersectionObserver === "undefined") return;
    const observer = new IntersectionObserver(
      (entries) => {
        if (!entries[0]?.isIntersecting) return;
        observer.disconnect();
        autoTimersRef.current = Array.from({ length: stepCount }, (_, i) =>
          setTimeout(() => setSelectedDrawer(i), 900 + i * 1300),
        );
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    const timers = autoTimersRef;
    return () => {
      observer.disconnect();
      for (const t of timers.current) clearTimeout(t);
    };
  }, [prefersReducedMotion, stepCount]);

  const handleToggleDrawer = (index: number) => {
    setSelectedAttackIndex(null);
    setSelectedDrawer((current) => {
      const active = current !== undefined ? current : defaultDrawer;
      const next = active === index ? null : index;
      if (next !== null) {
        const step = data.steps[next];
        setLiveAnnouncement(
          `Opened drawer ${next + 1}: ${step.label}. Transaction hash ${step.shortHash}.`,
        );
      } else {
        setLiveAnnouncement(`Closed drawer ${index + 1}.`);
      }
      return next;
    });
  };

  const handleSelectAttack = (index: number) => {
    setSelectedDrawer(null);
    setSelectedAttackIndex((current) => {
      const next = current === index ? null : index;
      if (next !== null) {
        const attack = data.attacks[next];
        setLiveAnnouncement(
          `Selected refused attack ${next + 1}: ${attack.label}, rejection code ${attack.rejectionCode}.`,
        );
      } else {
        setLiveAnnouncement(`Deselected refused attack ${index + 1}.`);
      }
      return next;
    });
  };

  const handleCopy = async (hash: string, label: string) => {
    try {
      if (typeof navigator !== "undefined" && navigator.clipboard?.writeText) {
        await navigator.clipboard.writeText(hash);
      } else {
        const textarea = document.createElement("textarea");
        textarea.value = hash;
        textarea.style.position = "fixed";
        textarea.style.opacity = "0";
        document.body.appendChild(textarea);
        textarea.select();
        document.execCommand("copy");
        document.body.removeChild(textarea);
      }
      setCopiedId(hash);
      setLiveAnnouncement(`Copied ${label} transaction id to clipboard`);
      setTimeout(() => {
        setCopiedId((current) => (current === hash ? null : current));
      }, 2000);
    } catch {
      setLiveAnnouncement("Failed to copy transaction hash");
    }
  };

  const isVisible = prefersReducedMotion || isViewportActive;
  const activeStep = openDrawerIndex !== null ? data.steps[openDrawerIndex] : null;
  const activeAttack =
    selectedAttackIndex !== null ? data.attacks[selectedAttackIndex] : null;

  return (
    <section id="testnet-proof" ref={containerRef} className="bp-section">
      <div className={styles.layout}>
        {/* Left column (35%): sticky on desktop while the diorama scrolls */}
        <div className={styles.sticky}>
          <div className="bp-chapter-label">
            <span className="text-bp-pass">04</span>
            <span>/</span>
            <span>Testnet proof</span>
          </div>

          <h2 className="mt-4 bp-display bp-section-title">
            It already happened on testnet.
          </h2>

          <p className="mt-5 text-base bp-prose" style={{ maxWidth: "44ch" }}>
            Every step from contract deployment to final reconciliation was recorded on
            NEAR testnet: real receipts, enforced invariants, no leftover accounts recorded in gate.json.
          </p>

          <dl
            data-reveal-item
            className="mt-6 max-w-[44ch] space-y-2.5 border-t border-bp-line pt-5 font-mono text-[13px]"
          >
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-bp-ink">Network</dt>
              <dd className="text-bp-pass font-bold uppercase bp-tabular">
                {data.network}
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-bp-ink">Execution sequence</dt>
              <dd className="text-bp-muted bp-tabular">
                {data.steps.length} on-chain receipts
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-bp-ink">Refused attacks</dt>
              <dd className="text-bp-reject font-bold bp-tabular">
                <span aria-hidden="true">✕ </span>
                {data.attacks.length} blocked
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-bp-ink">Clean exit</dt>
              <dd className="text-bp-pass font-bold bp-tabular">
                <span aria-hidden="true">✓ </span>
                {data.cleanup.leftoverCount} leftover accounts
              </dd>
            </div>
          </dl>

          <p data-reveal-item className={`mt-6 ${styles.try}`}>
            <span aria-hidden="true" className="text-bp-pass">
              ▶
            </span>
            <span>
              <b>Try it:</b> click any archive drawer to pull out its transaction
              receipt, or pick a refused attack card.
            </span>
          </p>
        </div>

        {/* Right column: Isometric Archive Cabinet Diorama + Readout Panel below */}
        <div
          ref={sceneHostRef}
          className="min-w-0 bp-scene-host"
          onPointerDownCapture={cancelAutoplay}
          onKeyDownCapture={cancelAutoplay}
          onClickCapture={cancelAutoplay}
        >
          <ProofScene
            data={data}
            openDrawerIndex={openDrawerIndex}
            selectedAttackIndex={selectedAttackIndex}
            isVisible={isVisible}
            prefersReducedMotion={prefersReducedMotion}
            receiptPanelId={receiptPanelId}
            onToggleDrawer={handleToggleDrawer}
            onSelectAttack={handleSelectAttack}
          />

          <BlueprintFrame
            tone={activeAttack ? "reject" : "pass"}
            className="mt-6 p-4 sm:p-5"
          >
            {/* Screen-reader aria-live announcement container */}
            <div
              id={liveRegionId}
              role="status"
              aria-live="polite"
              className="sr-only"
            >
              {liveAnnouncement}
            </div>

            {/* Quick drawer selector tabs */}
            <div className="flex flex-wrap items-center gap-1.5 border-b border-bp-line pb-3">
              <span className="text-[11px] font-mono uppercase tracking-wider text-bp-muted mr-1">
                Drawers:
              </span>
              {data.steps.map((step, idx) => {
                const isOpen = openDrawerIndex === idx;
                return (
                  <button
                    key={step.key}
                    type="button"
                    onClick={() => handleToggleDrawer(idx)}
                    aria-pressed={isOpen}
                    aria-controls={receiptPanelId}
                    aria-label={`Toggle drawer ${idx + 1}: ${step.label}`}
                    className={`${styles.focusable} px-2 py-1 rounded-xs font-mono text-[12px] border transition-colors cursor-pointer ${
                      isOpen
                        ? "bg-bp-surface-raised border-bp-pass text-bp-pass font-bold shadow-xs"
                        : "bg-bp-canvas border-bp-line text-bp-muted hover:text-bp-ink hover:border-bp-line-strong"
                    }`}
                  >
                    <span>{String(idx + 1).padStart(2, "0")}</span>
                    <span className="hidden sm:inline ml-1.5">{step.label}</span>
                  </button>
                );
              })}
            </div>

            {/* Active drawer or attack dossier card */}
            <div id={receiptPanelId} className="pt-3">
              {activeStep && (
                <div className="space-y-3 font-mono text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold text-bp-pass px-2 py-0.5 rounded-xs bg-bp-surface-raised border border-bp-pass/40">
                        DRAWER {String(openDrawerIndex! + 1).padStart(2, "0")} / 07
                      </span>
                      <h3 className="font-mono text-sm sm:text-base font-bold text-bp-ink">
                        {activeStep.label}
                      </h3>
                    </div>
                    {activeStep.resultSummary && (
                      <span className="text-[11px] font-mono px-2 py-0.5 rounded-xs bg-bp-surface-raised border border-bp-line text-bp-pass font-medium">
                        {activeStep.resultSummary}
                      </span>
                    )}
                  </div>

                  <p className="text-xs sm:text-sm text-bp-muted leading-relaxed">
                    {activeStep.explanation}
                  </p>

                  <div className="pt-2 border-t border-bp-line flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2 font-mono text-xs">
                      <span className="text-bp-muted">Receipt:</span>
                      <span
                        title={activeStep.hash}
                        className="text-bp-ink bg-bp-canvas px-2 py-1 rounded-xs border border-bp-line font-bold"
                      >
                        {activeStep.shortHash}
                      </span>
                    </div>

                    <div className="flex items-center gap-2">
                      <button
                        type="button"
                        onClick={() => handleCopy(activeStep.hash, activeStep.label)}
                        aria-label={`Copy transaction id for ${activeStep.label}: ${activeStep.shortHash}`}
                        aria-live="polite"
                        className="px-2.5 py-1 bg-bp-canvas hover:bg-bp-surface-raised border border-bp-line-strong text-bp-ink hover:text-bp-pass font-mono text-xs rounded-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bp-pass cursor-pointer"
                      >
                        {copiedId === activeStep.hash ? "✓ Copied" : "Copy tx id"}
                      </button>

                      <a
                        href={activeStep.explorerUrl}
                        target="_blank"
                        rel="noopener noreferrer"
                        aria-label={`Open ${activeStep.label} transaction ${activeStep.shortHash} on NearBlocks explorer in new tab`}
                        className="px-2.5 py-1 bg-bp-canvas hover:bg-bp-surface-raised border border-bp-line-strong text-bp-pass font-mono text-xs rounded-xs transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-bp-pass inline-flex items-center gap-1"
                      >
                        <span>Explorer</span>
                        <span aria-hidden="true">↗</span>
                      </a>
                    </div>
                  </div>
                </div>
              )}

              {activeAttack && (
                <div className="space-y-3 font-mono text-[13px]">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div className="flex items-center gap-2">
                      <span className="text-xs font-mono font-bold text-bp-reject px-2 py-0.5 rounded-xs bg-bp-reject-dim border border-bp-reject/40">
                        REFUSED ATTACK {String(selectedAttackIndex! + 1).padStart(2, "0")} / 05
                      </span>
                      <h3 className="font-mono text-sm sm:text-base font-bold text-bp-ink">
                        {activeAttack.label}
                      </h3>
                    </div>
                    <span className="text-xs font-mono font-bold px-2 py-0.5 rounded-xs bg-bp-reject-dim text-bp-reject border border-bp-reject/40">
                      {activeAttack.rejectionCode}
                    </span>
                  </div>

                  <p className="text-xs sm:text-sm text-bp-muted leading-relaxed">
                    {activeAttack.note}
                  </p>

                  <div className="pt-2 border-t border-bp-line flex flex-wrap items-center justify-between gap-2 font-mono text-xs">
                    <span className="text-bp-muted">
                      Outcome:{" "}
                      <strong className="text-bp-reject font-semibold">
                        HTTP {activeAttack.httpStatus}
                      </strong>
                    </span>

                    {activeAttack.txHash ? (
                      <div className="flex items-center gap-2">
                        <span
                          title={activeAttack.txHash}
                          className="text-bp-muted bg-bp-canvas px-2 py-1 rounded-xs border border-bp-line"
                        >
                          {activeAttack.shortTx}
                        </span>
                        <button
                          type="button"
                          onClick={() =>
                            handleCopy(activeAttack.txHash!, activeAttack.label)
                          }
                          aria-label={`Copy transaction id for ${activeAttack.label}: ${activeAttack.shortTx}`}
                          aria-live="polite"
                          className="px-2.5 py-1 bg-bp-canvas hover:bg-bp-surface-raised border border-bp-line-strong text-bp-ink hover:text-bp-pass text-xs rounded-xs transition-colors cursor-pointer"
                        >
                          {copiedId === activeAttack.txHash ? "✓ Copied" : "Copy tx id"}
                        </button>
                        <a
                          href={explorerTxUrl(activeAttack.txHash)}
                          target="_blank"
                          rel="noopener noreferrer"
                          aria-label={`Open rejected attack transaction ${activeAttack.shortTx} on NearBlocks in new tab`}
                          className="px-2.5 py-1 bg-bp-canvas hover:bg-bp-surface-raised border border-bp-line-strong text-bp-pass text-xs rounded-xs inline-flex items-center gap-1"
                        >
                          <span>Explorer</span>
                          <span aria-hidden="true">↗</span>
                        </a>
                      </div>
                    ) : (
                      <span className="text-bp-muted/80">
                        Blocked by facilitator relay before hitting contract
                      </span>
                    )}
                  </div>
                </div>
              )}

              {!activeStep && !activeAttack && (
                <div className="space-y-2 py-2 font-mono text-[13px]">
                  <div className="flex items-center gap-2">
                    <span className="text-xs font-mono font-semibold text-bp-muted">
                      All archive drawers closed
                    </span>
                  </div>
                  <p className="text-xs sm:text-sm text-bp-muted">
                    Click or press Enter on any archive drawer (01-07) on the left to
                    pull out its on-chain receipt, or select a refused attack card on the
                    right.
                  </p>
                </div>
              )}
            </div>

            {/* Clean Exit reconciliation summary bar */}
            <div className="mt-4 pt-3 border-t border-bp-line grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-[13px] bp-tabular">
              <div>
                <div className="text-bp-muted">Leftover</div>
                <div className="text-bp-pass font-semibold">
                  {data.cleanup.leftoverCount} accounts
                </div>
              </div>
              <div>
                <div className="text-bp-muted">Funder balance</div>
                <div className="text-bp-pass font-semibold">
                  {data.cleanup.funderUsdcBefore} USDC
                </div>
              </div>
              <div>
                <div className="text-bp-muted">Vault left</div>
                <div className="text-bp-pass font-semibold">
                  {data.cleanup.contractUsdcLeft} USDC
                </div>
              </div>
              <div>
                <div className="text-bp-muted">Withdrawn</div>
                <div className="text-bp-ink font-semibold">
                  {data.cleanup.withdrawnUsdc} USDC
                </div>
              </div>
            </div>

            <p className="mt-3 pt-2.5 border-t border-bp-line font-mono text-[13px] text-bp-muted">
              Reconciliation recorded in gate.json: no leftover accounts, funder USDC
              unchanged. The funder paid a small amount of NEAR for gas.
            </p>
          </BlueprintFrame>

          <div data-reveal-item className={`${styles.figures} ${styles.figuresRow}`}>
            <div>
              <div className={styles.bigNum}>{data.steps.length}</div>
              <p className={styles.bigCap}>
                <b>On-chain receipts</b>, deploy to withdraw, on {data.network}.
              </p>
            </div>
            <div>
              <div className={styles.bigNum}>{data.attacks.length}</div>
              <p className={styles.bigCap}>
                <b>Attacks refused</b> with a rejection code each.
              </p>
            </div>
            <div>
              <div className={styles.bigNum}>{data.cleanup.leftoverCount}</div>
              <p className={styles.bigCap}>
                <b>Accounts left over</b> after the clean exit.
              </p>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
