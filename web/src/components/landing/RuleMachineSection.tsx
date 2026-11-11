"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import {
  MANDATE_BUDGET_USDC,
  MANDATE_CAP_USDC,
  MERCHANT_ACCOUNT,
  MERCHANT_SHORT,
  ATTACKER_ACCOUNT,
  AUTO_DEMO_HONEST_USDC,
  AUTO_DEMO_ATTACK_USDC,
  stepDialUsdc,
  applyLeverPull,
  createInitialMachineState,
  computeAutoDemoSequence,
  type GateStatus,
  type PacketStage,
  type RuleMachineState,
} from "@/lib/rule-machine";
import type { RejectCode } from "@/lib/rules";
import { BlueprintFrame } from "./BlueprintFrame";
import { RuleMachineScene } from "./iso/RuleMachineScene";
import { useAnimationActive } from "./useAnimationActive";
import { useReducedMotion } from "./useReducedMotion";

export function RuleMachineSection() {
  const prefersReducedMotion = useReducedMotion();
  const { containerRef, isViewportActive } = useAnimationActive<HTMLElement>();

  // True once the diorama has actually been seen (not merely mounted). One-shot.
  const [hasBeenSeen, setHasBeenSeen] = useState(false);
  const sceneHostRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const el = sceneHostRef.current;
    if (!el) return;
    if (typeof IntersectionObserver === "undefined") {
      const t = setTimeout(() => setHasBeenSeen(true), 0);
      return () => clearTimeout(t);
    }
    const observer = new IntersectionObserver(
      (entries) => {
        if (entries.some((e) => e.isIntersecting)) {
          setHasBeenSeen(true);
          observer.disconnect();
        }
      },
      { threshold: 0.4 },
    );
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // Interactive control inputs
  const [recipient, setRecipient] = useState<string>(MERCHANT_ACCOUNT);
  const [amountUsdc, setAmountUsdc] = useState<number>(0.2);

  // Machine state (budget, nonce, logs)
  const [machineState, setMachineState] = useState<RuleMachineState>(() =>
    createInitialMachineState(),
  );

  // Live animation playback state
  const [gateStates, setGateStates] = useState<[GateStatus, GateStatus, GateStatus]>([
    "idle",
    "idle",
    "idle",
  ]);
  const [activeCode, setActiveCode] = useState<RejectCode | null>(null);
  const [packetStage, setPacketStage] = useState<PacketStage>("idle");
  const [packetTone, setPacketTone] = useState<"pass" | "reject">("pass");
  const [packetLabel, setPacketLabel] = useState<string>("");
  const [leverDown, setLeverDown] = useState<boolean>(false);
  const [sparkGate, setSparkGate] = useState<0 | 1 | 2 | null>(null);
  const [isAnimating, setIsAnimating] = useState<boolean>(false);

  // Auto-demo tracking
  const userTouchedRef = useRef<boolean>(false);
  const hasAutoDemoRunRef = useRef<boolean>(false);
  const machineStateRef = useRef<RuleMachineState>(machineState);
  useEffect(() => {
    machineStateRef.current = machineState;
  }, [machineState]);
  const animationTimersRef = useRef<ReturnType<typeof setTimeout>[]>([]);

  const clearAllTimers = useCallback(() => {
    animationTimersRef.current.forEach((t) => clearTimeout(t));
    animationTimersRef.current = [];
  }, []);

  useEffect(() => {
    return () => clearAllTimers();
  }, [clearAllTimers]);

  // Execute an animated sequence of frames
  const runSequence = useCallback(
    (
      currentRecipient: string,
      currentAmount: number,
      onComplete?: (finalState: RuleMachineState) => void,
    ) => {
      clearAllTimers();
      setIsAnimating(true);

      const prevState = machineStateRef.current;
      const { evaluation, frames, nextState } = applyLeverPull(prevState, {
        recipient: currentRecipient,
        amountUsdc: currentAmount,
      });

      if (prefersReducedMotion) {
        // Jump immediately to final frame
        const lastFrame = frames[frames.length - 1];
        setGateStates(lastFrame.gates);
        setActiveCode(lastFrame.activeCode);
        setPacketStage(lastFrame.stage);
        setPacketTone(evaluation.ok ? "pass" : "reject");
        setPacketLabel(`${currentAmount.toFixed(2)} USDC`);
        setLeverDown(false);
        setSparkGate(null);
        setIsAnimating(false);
        machineStateRef.current = nextState;
        setMachineState(nextState);
        if (onComplete) onComplete(nextState);
        return;
      }

      let accumulatedTime = 0;
      frames.forEach((frame, idx) => {
        const isLast = idx === frames.length - 1;
        const timerId = setTimeout(() => {
          setGateStates(frame.gates);
          setActiveCode(frame.activeCode);
          setPacketStage(frame.stage);
          setPacketTone(evaluation.ok ? "pass" : "reject");
          setPacketLabel(`${currentAmount.toFixed(2)} USDC`);
          setLeverDown(frame.leverDown);
          setSparkGate(frame.sparkGate);

          if (isLast) {
            const settleTimer = setTimeout(() => {
              setLeverDown(false);
              setSparkGate(null);
              setIsAnimating(false);
              machineStateRef.current = nextState;
              setMachineState(nextState);
              if (onComplete) onComplete(nextState);
            }, 300);
            animationTimersRef.current.push(settleTimer);
          }
        }, accumulatedTime);

        animationTimersRef.current.push(timerId);
        accumulatedTime += frame.durationMs;
      });
    },
    [clearAllTimers, prefersReducedMotion],
  );

  // Auto-demo triggered once when entering viewport
  useEffect(() => {
    if (!hasBeenSeen || !isViewportActive || hasAutoDemoRunRef.current || userTouchedRef.current) {
      return;
    }

    hasAutoDemoRunRef.current = true;

    if (prefersReducedMotion) {
      const timer = setTimeout(() => {
        const { step2 } = computeAutoDemoSequence();
        setRecipient(ATTACKER_ACCOUNT);
        setAmountUsdc(AUTO_DEMO_ATTACK_USDC);
        setGateStates(["reject", "idle", "idle"]);
        setActiveCode("RECIPIENT_NOT_ALLOWED");
        setPacketStage("rejected");
        setPacketTone("reject");
        setPacketLabel(`${AUTO_DEMO_ATTACK_USDC.toFixed(2)} USDC`);
        setMachineState(step2.nextState);
      }, 0);
      animationTimersRef.current.push(timer);
      return;
    }

    // Two-step automated showcase:
    // Step 1: Valid Merchant payment
    // Step 2: Attacker payment (rejected at Gate 1)
    const initialDelay = setTimeout(() => {
      if (userTouchedRef.current) return;
      setRecipient(MERCHANT_ACCOUNT);
      setAmountUsdc(AUTO_DEMO_HONEST_USDC);

      runSequence(MERCHANT_ACCOUNT, AUTO_DEMO_HONEST_USDC, () => {
        if (userTouchedRef.current) return;
        const pauseTimer = setTimeout(() => {
          if (userTouchedRef.current) return;
          setRecipient(ATTACKER_ACCOUNT);
          setAmountUsdc(AUTO_DEMO_ATTACK_USDC);
          runSequence(ATTACKER_ACCOUNT, AUTO_DEMO_ATTACK_USDC);
        }, 900);
        animationTimersRef.current.push(pauseTimer);
      });
    }, 450);

    animationTimersRef.current.push(initialDelay);
  }, [hasBeenSeen, isViewportActive, prefersReducedMotion, runSequence]);

  const markUserTouched = () => {
    if (!userTouchedRef.current) {
      userTouchedRef.current = true;
      clearAllTimers();
      setIsAnimating(false);
      setLeverDown(false);
      setSparkGate(null);
    }
  };

  const handleSelectRecipient = (target: string) => {
    markUserTouched();
    setRecipient(target);
  };

  const handleStepDial = (deltaSteps: number) => {
    markUserTouched();
    setAmountUsdc((prev) => stepDialUsdc(prev, deltaSteps));
  };

  const handlePullLever = () => {
    markUserTouched();
    if (isAnimating) return;
    runSequence(recipient, amountUsdc);
  };

  const handleReset = () => {
    markUserTouched();
    clearAllTimers();
    setIsAnimating(false);
    setGateStates(["idle", "idle", "idle"]);
    setActiveCode(null);
    setPacketStage("idle");
    setPacketTone("pass");
    setPacketLabel("");
    setLeverDown(false);
    setSparkGate(null);
    setRecipient(MERCHANT_ACCOUNT);
    setAmountUsdc(0.2);
    setMachineState(createInitialMachineState());
  };

  const handleRunDemo = () => {
    userTouchedRef.current = false;
    clearAllTimers();
    setGateStates(["idle", "idle", "idle"]);
    setActiveCode(null);
    setPacketStage("idle");
    setMachineState(createInitialMachineState());
    setRecipient(MERCHANT_ACCOUNT);
    setAmountUsdc(AUTO_DEMO_HONEST_USDC);

    runSequence(MERCHANT_ACCOUNT, AUTO_DEMO_HONEST_USDC, () => {
      const timer = setTimeout(() => {
        setRecipient(ATTACKER_ACCOUNT);
        setAmountUsdc(AUTO_DEMO_ATTACK_USDC);
        runSequence(ATTACKER_ACCOUNT, AUTO_DEMO_ATTACK_USDC);
      }, 700);
      animationTimersRef.current.push(timer);
    });
  };

  const gateBadge = (idx: 0 | 1 | 2) => {
    const s = gateStates[idx];
    if (s === "pass") return "✓ PASS";
    if (s === "reject") return "✕ REJECT";
    return "· IDLE";
  };

  const gateClass = (idx: 0 | 1 | 2) => {
    const s = gateStates[idx];
    if (s === "pass") return "border-bp-pass bg-bp-pass-dim/40";
    if (s === "reject") return "border-bp-reject bg-bp-reject-dim/40";
    return "border-bp-line bg-bp-canvas";
  };

  const badgeColor = (idx: 0 | 1 | 2) => {
    const s = gateStates[idx];
    if (s === "pass") return "text-bp-pass font-bold";
    if (s === "reject") return "text-bp-reject font-bold";
    return "text-bp-muted";
  };

  return (
    <section id="rules" ref={containerRef} className="bp-section">
      <div className="bp-container grid gap-10">
        {/* Left Column: Chapter Narrative & Object Instructions */}
        <div className="max-w-[64ch]">
          <div className="bp-chapter-label mb-3">
            <span className="text-bp-pass font-bold">01</span>
            <span>/</span>
            <span>The rule machine</span>
          </div>

          <h2 className="bp-display bp-section-title max-w-[14ch]">
            Three gates. One verdict.
          </h2>

          <p className="mt-4 bp-prose text-[15px] sm:text-base max-w-[55ch]">
            The contract is designed to check every payment before any funds move.
            This diorama mirrors those rules in your browser. Payments pass through three sequential policy gates: allowlisted recipient,
            per-payment cap, and cumulative budget. If any gate trips, execution
            halts atomically and the payment is rejected.
          </p>

          <p className="mt-5 text-[13px] font-mono text-bp-muted max-w-[52ch] leading-relaxed">
            <span className="text-bp-pass mr-1.5" aria-hidden="true">
              ↳
            </span>
            Pick a recipient, set the amount, pull the lever.
          </p>

          <div className="mt-4 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={handleRunDemo}
              disabled={isAnimating}
              className="bp-btn bp-btn-secondary bp-btn-sm disabled:opacity-50"
            >
              Replay demo
            </button>
            <button
              type="button"
              onClick={handleReset}
              className="bp-btn bp-btn-secondary bp-btn-sm"
            >
              Reset
            </button>
          </div>
        </div>

        {/* Right Column: Isometric Diorama & Readout Panels */}
        <div className="space-y-6 min-w-0">
          {/* Diorama Container */}
          <BlueprintFrame
            tone={activeCode ? "reject" : "default"}
            className="p-2 sm:p-4 overflow-hidden relative"
          >
            <div ref={sceneHostRef} className="w-full bp-scene-host">
              <RuleMachineScene
                recipient={recipient}
                amountUsdc={amountUsdc}
                nonce={machineState.nonce}
                spentUsdc={machineState.spentUsdc}
                remainingUsdc={machineState.remainingUsdc}
                remainingRatio={machineState.remainingRatio}
                gateStates={gateStates}
                activeCode={activeCode}
                packetStage={packetStage}
                packetTone={packetTone}
                packetLabel={packetLabel}
                leverDown={leverDown}
                sparkGate={sparkGate}
                isRunning={isAnimating}
                reducedMotion={prefersReducedMotion}
                onSelectRecipient={handleSelectRecipient}
                onStepDial={handleStepDial}
                onPullLever={handlePullLever}
                onReset={handleReset}
              />
            </div>
          </BlueprintFrame>

          {/* Live Accessibility & Feedback Announcement Region */}
          <div
            aria-live="polite"
            className="p-3.5 rounded-xs border border-bp-line bg-bp-canvas text-xs font-mono flex items-start justify-between gap-3"
          >
            <div className="flex items-start gap-2 min-w-0">
              <span
                className={
                  activeCode
                    ? "text-bp-reject font-bold"
                    : gateStates[0] === "pass"
                      ? "text-bp-pass font-bold"
                      : "text-bp-muted"
                }
              >
                <span aria-hidden="true">{activeCode ? "✕" : gateStates[0] === "pass" ? "✓" : "▶"}</span>
              </span>
              <span className="text-bp-ink leading-relaxed break-words">
                {machineState.lastMessage}
              </span>
            </div>
            {activeCode && (
              <span className="shrink-0 text-xs font-mono px-2 py-0.5 rounded-xs bg-bp-reject-dim text-bp-reject border border-bp-reject/40 font-bold">
                {activeCode}
              </span>
            )}
          </div>

          {/* Three Sequential Gate Status Cards */}
          <div className="grid grid-cols-1 sm:grid-cols-3 gap-3">
            {/* Gate 1 */}
            <div className={`rounded-xs border p-3 sm:p-4 transition-all duration-300 ${gateClass(0)}`}>
              <div className="flex items-center justify-between mb-1.5 text-xs font-mono">
                <span className="text-bp-muted uppercase">Gate 1</span>
                <span className={badgeColor(0)}>{gateBadge(0)}</span>
              </div>
              <h3 className="font-mono text-sm font-bold text-bp-ink">Recipient</h3>
              <p className="text-xs text-bp-muted mt-1 leading-snug">
                Must be allowlisted ({MERCHANT_SHORT})
              </p>
            </div>

            {/* Gate 2 */}
            <div className={`rounded-xs border p-3 sm:p-4 transition-all duration-300 ${gateClass(1)}`}>
              <div className="flex items-center justify-between mb-1.5 text-xs font-mono">
                <span className="text-bp-muted uppercase">Gate 2</span>
                <span className={badgeColor(1)}>{gateBadge(1)}</span>
              </div>
              <h3 className="font-mono text-sm font-bold text-bp-ink">Per-Payment Cap</h3>
              <p className="text-xs text-bp-muted mt-1 leading-snug">
                ≤ {MANDATE_CAP_USDC} USDC / payment
              </p>
            </div>

            {/* Gate 3 */}
            <div className={`rounded-xs border p-3 sm:p-4 transition-all duration-300 ${gateClass(2)}`}>
              <div className="flex items-center justify-between mb-1.5 text-xs font-mono">
                <span className="text-bp-muted uppercase">Gate 3</span>
                <span className={badgeColor(2)}>{gateBadge(2)}</span>
              </div>
              <h3 className="font-mono text-sm font-bold text-bp-ink">Budget</h3>
              <p className="text-xs text-bp-muted mt-1 leading-snug">
                spent + amt ≤ {MANDATE_BUDGET_USDC} USDC
              </p>
            </div>
          </div>

          {/* Recent Evaluations Log (5 Most Recent) */}
          <BlueprintFrame tone="default" className="p-4 sm:p-5">
            <span className="text-xs font-mono uppercase tracking-wider text-bp-muted block mb-3">
              Recent Evaluations Log (Max 5)
            </span>
            {machineState.history.length === 0 ? (
              <p className="text-xs font-mono text-bp-muted py-2">
                No payment evaluations yet. Pull the diorama lever above to evaluate.
              </p>
            ) : (
              <div className="divide-y divide-bp-line">
                {machineState.history.map((h) => (
                  <div
                    key={h.id}
                    className="py-2.5 flex flex-wrap items-center justify-between gap-2 text-xs font-mono"
                  >
                    <div className="flex items-center gap-2">
                      <span className="text-bp-muted">#{h.id}</span>
                      <span className="text-bp-ink font-semibold bp-tabular">
                        {h.amountUsdc} USDC
                      </span>
                      <span className="text-bp-muted">→ {h.recipientShort}</span>
                    </div>
                    <div className="flex items-center gap-2">
                      {h.result.ok ? (
                        <span className="text-bp-pass font-bold">
                          <span aria-hidden="true">✓ </span>ACCEPTED (Rem: {h.remainingUsdc} USDC)
                        </span>
                      ) : (
                        <span className="text-bp-reject font-bold">
                          <span aria-hidden="true">✕ </span>REJECTED: {h.result.code}
                        </span>
                      )}
                    </div>
                  </div>
                ))}
              </div>
            )}
          </BlueprintFrame>

          <div
            data-reveal-item
            className="pt-8 flex flex-wrap items-baseline gap-x-5 gap-y-2"
          >
            <span className="bp-display bp-tabular text-[clamp(3.5rem,8vw,6rem)] leading-none text-bp-ink">
              {gateStates.length}
            </span>
            <span className="text-[13px] font-mono text-bp-muted leading-relaxed max-w-[60ch]">
              <span className="text-bp-pass mr-1.5" aria-hidden="true">
                ↳
              </span>
              gates in strict order, first failure wins. Cap {MANDATE_CAP_USDC} USDC,
              budget {MANDATE_BUDGET_USDC} USDC.
            </span>
          </div>
        </div>
      </div>
    </section>
  );
}
