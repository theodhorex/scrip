"use client";

import { useEffect, useId, useRef, useState } from "react";
import {
  applyChange,
  type Change,
  type GuardianMandate,
  type GuardianRejectCode,
  type GuardianState,
} from "@/lib/guardian";
import { formatUsdc6 } from "@/lib/proof-data";
import { BlueprintFrame } from "./BlueprintFrame";
import { GuardianScene, type LeverKey, type LeverSpec } from "./iso/GuardianScene";
import styles from "./GuardianSection.module.css";
import { useAnimationActive } from "./useAnimationActive";
import { useReducedMotion } from "./useReducedMotion";

// Vault deposit and initial mandate policy values (6-decimal USDC base units),
// matching `guardian.test.mjs` and the funded step in `gate.json`.
const DEPOSIT_UNITS = "1250000";
const DEMO_ILLEGAL_BUDGET_UNITS = "1350000";
const FIXED_NOW_MS = 1_700_000_000_000;
const FIXED_EXPIRY_MS = 1_800_000_000_000;

const INITIAL_MANDATE: GuardianMandate = {
  id: 1,
  status: "Active",
  budget: "1000000",
  perPaymentCap: "500000",
  approvalThreshold: "300000",
  expiresAtMs: FIXED_EXPIRY_MS,
  recipients: ["merchant.near"],
};

const DEMO_STATE: GuardianState = {
  deposited: DEPOSIT_UNITS,
  spent: "0",
  reserved: "0",
  withdrawn: "0",
  nowMs: FIXED_NOW_MS,
};

const LEVERS: readonly LeverSpec[] = [
  {
    key: "budget",
    label: "Budget",
    shortLabel: "BUDGET",
    stepUnits: 100_000,
    boundRule: `Max ${formatUsdc6(DEPOSIT_UNITS)} USDC deposit`,
  },
  {
    key: "perPaymentCap",
    label: "Per-payment cap",
    shortLabel: "PAY CAP",
    stepUnits: 100_000,
    boundRule: "Max current Budget",
  },
  {
    key: "approvalThreshold",
    label: "Approval threshold",
    shortLabel: "THRESHOLD",
    stepUnits: 50_000,
    boundRule: "Max Per-payment cap",
  },
];

// Real invariant result for the headline figure: loosening Budget past the deposit.
const ILLEGAL_LOOSEN = applyChange("loosen", INITIAL_MANDATE, DEMO_STATE, {
  Budget: DEMO_ILLEGAL_BUDGET_UNITS,
});
const CEILING_CODE = ILLEGAL_LOOSEN.ok ? null : ILLEGAL_LOOSEN.code;

function buildChange(key: LeverKey, nextUnits: string): Change {
  if (key === "budget") return { Budget: nextUnits };
  if (key === "perPaymentCap") return { PerPaymentCap: nextUnits };
  return { ApprovalThreshold: nextUnits };
}

export function GuardianSection() {
  const prefersReducedMotion = useReducedMotion();
  const { containerRef, isViewportActive } = useAnimationActive<HTMLElement>();
  // Stable SSR-safe live region ID for assistive technologies.
  // Source: https://react.dev/reference/react/useId
  const liveRegionId = useId();

  const [mandate, setMandate] = useState<GuardianMandate>(INITIAL_MANDATE);
  const [rejections, setRejections] = useState<Record<LeverKey, GuardianRejectCode | null>>({
    budget: null,
    perPaymentCap: null,
    approvalThreshold: null,
  });
  const [lastRejectedCode, setLastRejectedCode] = useState<GuardianRejectCode | null>(null);
  const [shaking, setShaking] = useState<Record<LeverKey, boolean>>({
    budget: false,
    perPaymentCap: false,
    approvalThreshold: false,
  });
  const [statusMessage, setStatusMessage] = useState<string>(
    `Control desk ready. Vault holds ${formatUsdc6(DEPOSIT_UNITS)} USDC; slide any lever or press ◀ / ▶ to test contract policy bounds.`,
  );

  const shakeTimersRef = useRef<Partial<Record<LeverKey, ReturnType<typeof setTimeout>>>>({});

  useEffect(() => {
    const timers = shakeTimersRef.current;
    return () => {
      for (const timer of Object.values(timers)) {
        if (timer) clearTimeout(timer);
      }
    };
  }, []);

  const shouldAnimate = !prefersReducedMotion && isViewportActive;

  const triggerShake = (key: LeverKey) => {
    if (!shouldAnimate) return;
    const prevTimer = shakeTimersRef.current[key];
    if (prevTimer) clearTimeout(prevTimer);
    setShaking((prev) => ({ ...prev, [key]: true }));
    shakeTimersRef.current[key] = setTimeout(() => {
      setShaking((prev) => ({ ...prev, [key]: false }));
    }, 400);
  };

  const evaluateLeverChange = (
    key: LeverKey,
    mode: "tighten" | "loosen",
    targetUnits: bigint,
  ) => {
    const lever = LEVERS.find((l) => l.key === key)!;
    const nextStr = targetUnits.toString();
    const res = applyChange(mode, mandate, DEMO_STATE, buildChange(key, nextStr));

    if (res.ok) {
      setMandate(res.mandate);
      setRejections((prev) => ({ ...prev, [key]: null }));
      setLastRejectedCode(null);
      setStatusMessage(
        `${mode === "tighten" ? "Tightened" : "Loosened"} ${lever.label} to ${formatUsdc6(nextStr)} USDC. Accepted by contract policy.`,
      );
    } else {
      setRejections((prev) => ({ ...prev, [key]: res.code }));
      setLastRejectedCode(res.code);
      triggerShake(key);
      setStatusMessage(
        `Rejected ${mode} on ${lever.label} (${formatUsdc6(nextStr)} USDC) with ${res.code}. Lever stopped at boundary.`,
      );
    }
  };

  const handleStep = (key: LeverKey, mode: "tighten" | "loosen") => {
    const lever = LEVERS.find((l) => l.key === key)!;
    const currentUnits = BigInt(String(mandate[key]));
    const step = BigInt(lever.stepUnits);
    const targetUnits =
      mode === "tighten"
        ? currentUnits > step
          ? currentUnits - step
          : BigInt(0)
        : currentUnits + step;

    evaluateLeverChange(key, mode, targetUnits);
  };

  const handleSlideToUnits = (key: LeverKey, targetUnitsStr: string) => {
    const currentUnits = BigInt(String(mandate[key]));
    const targetUnits = BigInt(targetUnitsStr);
    if (targetUnits === currentUnits && targetUnits !== BigInt(0)) return;
    const resolvedMode: "tighten" | "loosen" =
      targetUnits > currentUnits ? "loosen" : "tighten";
    evaluateLeverChange(key, resolvedMode, targetUnits);
  };

  const handleDemoViolation = () => {
    const res = applyChange("loosen", mandate, DEMO_STATE, {
      Budget: DEMO_ILLEGAL_BUDGET_UNITS,
    });
    if (!res.ok) {
      setRejections((prev) => ({ ...prev, budget: res.code }));
      setLastRejectedCode(res.code);
      triggerShake("budget");
      setStatusMessage(
        `Rejected attempt to loosen Budget to ${formatUsdc6(DEMO_ILLEGAL_BUDGET_UNITS)} USDC past the ${formatUsdc6(DEPOSIT_UNITS)} USDC deposit ceiling: ${res.code}.`,
      );
    }
  };

  const handleReset = () => {
    setMandate(INITIAL_MANDATE);
    setRejections({
      budget: null,
      perPaymentCap: null,
      approvalThreshold: null,
    });
    setLastRejectedCode(null);
    setShaking({
      budget: false,
      perPaymentCap: false,
      approvalThreshold: false,
    });
    setStatusMessage(
      `Reset levers to ${formatUsdc6(String(INITIAL_MANDATE.budget))} / ${formatUsdc6(String(INITIAL_MANDATE.perPaymentCap))} / ${formatUsdc6(String(INITIAL_MANDATE.approvalThreshold))} USDC.`,
    );
  };

  // Autoplay once when the diorama first enters the viewport: one tighten, then one
  // loosen attempt past the deposit that gets refused. Any user interaction cancels it.
  const sceneHostRef = useRef<HTMLDivElement | null>(null);
  const autoTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);
  const actionsRef = useRef({ step: handleStep, violate: handleDemoViolation });
  useEffect(() => {
    actionsRef.current = { step: handleStep, violate: handleDemoViolation };
  });
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
        autoTimersRef.current = [
          setTimeout(() => actionsRef.current.step("budget", "tighten"), 900),
          setTimeout(() => actionsRef.current.violate(), 2600),
        ];
      },
      { threshold: 0.5 },
    );
    observer.observe(el);
    const timers = autoTimersRef;
    return () => {
      observer.disconnect();
      for (const t of timers.current) clearTimeout(t);
    };
  }, [prefersReducedMotion]);

  return (
    <section id="the-guardian" ref={containerRef} className="bp-section">
      <div className={styles.layout}>
        {/* Left column (35%): sticky on desktop while the diorama scrolls */}
        <div className={styles.sticky}>
          <div className="bp-chapter-label">
            <span className="text-bp-pass">03</span>
            <span>/</span>
            <span>The guardian</span>
          </div>

          <h2 className="mt-4 bp-display bp-section-title">
            Tighten anytime. Never loosen past the vault.
          </h2>

          <p className="mt-5 text-base bp-prose" style={{ maxWidth: "44ch" }}>
            The guardian can tighten limits whenever risk rises. Every loosening call
            must pass the contract&apos;s invariants, so no one can push a budget above
            the deposit, a cap above budget, or a threshold above cap.
          </p>

          <dl
            data-reveal-item
            className="mt-6 max-w-[44ch] space-y-2.5 border-t border-bp-line pt-5 font-mono text-[13px]"
          >
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-bp-ink">Budget ≤ Deposit</dt>
              <dd className="text-bp-muted bp-tabular">
                ≤ {formatUsdc6(DEPOSIT_UNITS)} USDC
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-bp-ink">Cap ≤ Budget</dt>
              <dd className="text-bp-muted bp-tabular">
                ≤ {formatUsdc6(String(mandate.budget))} USDC
              </dd>
            </div>
            <div className="flex items-baseline justify-between gap-3">
              <dt className="text-bp-ink">Threshold ≤ Cap</dt>
              <dd className="text-bp-muted bp-tabular">
                ≤ {formatUsdc6(String(mandate.perPaymentCap))} USDC
              </dd>
            </div>
          </dl>

          <p data-reveal-item className={`mt-6 ${styles.try}`}>
            <span aria-hidden="true" className="text-bp-pass">
              ▶
            </span>
            <span>
              <b>Try it:</b> press the coral bar to loosen the budget past the deposit and
              watch the contract refuse it.
            </span>
          </p>
        </div>

        {/* Right column (65%): diorama, then readout below */}
        <div
          ref={sceneHostRef}
          className="min-w-0 bp-scene-host"
          onPointerDownCapture={cancelAutoplay}
          onKeyDownCapture={cancelAutoplay}
          onClickCapture={cancelAutoplay}
        >
          <GuardianScene
            mandate={mandate}
            depositedUnits={DEPOSIT_UNITS}
            levers={LEVERS}
            rejections={rejections}
            shaking={shaking}
            animate={shouldAnimate}
            onStep={handleStep}
            onSlideToUnits={handleSlideToUnits}
            onDemoViolation={handleDemoViolation}
            onReset={handleReset}
          />

          <BlueprintFrame
            tone={lastRejectedCode ? "reject" : "pass"}
            className="mt-6 p-4 sm:p-5"
          >
            <div
              id={liveRegionId}
              role="status"
              aria-live="polite"
              className="space-y-3 font-mono text-[13px]"
            >
              <div className="flex flex-wrap items-center justify-between gap-2">
                <span className="text-bp-muted">Contract policy readout</span>
                {lastRejectedCode ? (
                  <span className="px-2 py-0.5 rounded-xs bg-bp-reject-dim text-bp-reject border border-bp-reject/50 font-semibold">
                    <span aria-hidden="true">✕ </span>
                    {lastRejectedCode}
                  </span>
                ) : (
                  <span className="px-2 py-0.5 rounded-xs bg-bp-pass-dim text-bp-pass border border-bp-pass/40 font-semibold">
                    <span aria-hidden="true">✓ </span>
                    INVARIANT OK
                  </span>
                )}
              </div>

              <p
                className={`leading-relaxed ${
                  lastRejectedCode ? "text-bp-reject" : "text-bp-ink"
                }`}
              >
                {statusMessage}
              </p>
            </div>

            <div className="mt-4 pt-3 border-t border-bp-line grid grid-cols-2 sm:grid-cols-4 gap-3 font-mono text-[13px] bp-tabular">
              <div>
                <div className="text-bp-muted">Deposit</div>
                <div className="text-bp-ink font-semibold">
                  {formatUsdc6(DEPOSIT_UNITS)} USDC
                </div>
              </div>
              <div>
                <div className="text-bp-muted">Budget</div>
                <div
                  className={`font-semibold ${
                    rejections.budget ? "text-bp-reject" : "text-bp-pass"
                  }`}
                >
                  <span aria-hidden="true">{rejections.budget ? "✕ " : "✓ "}</span>
                  {formatUsdc6(String(mandate.budget))} USDC
                  <span className="sr-only">{rejections.budget ? " (rule violated)" : " (rule ok)"}</span>
                </div>
              </div>
              <div>
                <div className="text-bp-muted">Pay cap</div>
                <div
                  className={`font-semibold ${
                    rejections.perPaymentCap ? "text-bp-reject" : "text-bp-pass"
                  }`}
                >
                  <span aria-hidden="true">{rejections.perPaymentCap ? "✕ " : "✓ "}</span>
                  {formatUsdc6(String(mandate.perPaymentCap))} USDC
                  <span className="sr-only">{rejections.perPaymentCap ? " (rule violated)" : " (rule ok)"}</span>
                </div>
              </div>
              <div>
                <div className="text-bp-muted">Threshold</div>
                <div
                  className={`font-semibold ${
                    rejections.approvalThreshold ? "text-bp-reject" : "text-bp-pass"
                  }`}
                >
                  <span aria-hidden="true">{rejections.approvalThreshold ? "✕ " : "✓ "}</span>
                  {formatUsdc6(String(mandate.approvalThreshold))} USDC
                  <span className="sr-only">{rejections.approvalThreshold ? " (rule violated)" : " (rule ok)"}</span>
                </div>
              </div>
            </div>

            <p className="mt-3 pt-2.5 border-t border-bp-line font-mono text-[13px] text-bp-muted">
              Rules mirrored from the contract; the same checks run on testnet.
            </p>
          </BlueprintFrame>

          <div data-reveal-item className={styles.figures}>
            <div className={styles.bigNum}>
              {formatUsdc6(DEPOSIT_UNITS)}
              <span className={styles.bigUnit}>USDC</span>
            </div>
            <p className={styles.bigCap}>
              <b>The deposit is the ceiling.</b> Loosening Budget to{" "}
              {formatUsdc6(DEMO_ILLEGAL_BUDGET_UNITS)} USDC is refused
              {CEILING_CODE ? (
                <>
                  {" "}
                  with <b>{CEILING_CODE}</b>
                </>
              ) : null}
              ; the same rule runs in the contract.
            </p>
          </div>
        </div>
      </div>
    </section>
  );
}
