"use client";

import { useEffect, useRef, useState } from "react";
import type { LandingRaceData } from "@/lib/landing-data";
import {
  PACKET_END_TICKS,
  RaceScene,
  type RaceSpeed,
} from "./iso/RaceScene";
import { useAnimationActive } from "./useAnimationActive";
import { useReducedMotion } from "./useReducedMotion";

type Props = {
  data: LandingRaceData;
};

const BASE_STEP_MS = 105;

export function RaceSection({ data }: Props) {
  const prefersReducedMotion = useReducedMotion();
  const { containerRef, isViewportActive } = useAnimationActive<HTMLElement>();

  // One-shot: the burst autoplays the first time the diorama is actually seen.
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

  const maxTick = data.totalAttempts + PACKET_END_TICKS;

  // Derived state without setState-in-effect:
  // When reduced-motion is preferred and the user hasn't manually triggered a run,
  // display the completed final state immediately.
  // Source: https://react.dev/learn/you-might-not-need-an-effect
  const [manualRunId, setManualRunId] = useState(0);
  const [tick, setTick] = useState(0);
  const [paused, setPaused] = useState(false);
  const [speed, setSpeed] = useState<RaceSpeed>(1);

  const isStaticReducedInitial = prefersReducedMotion && manualRunId === 0;
  const effectiveTick = isStaticReducedInitial ? maxTick : tick;
  const isComplete = effectiveTick >= maxTick;
  const isRunning =
    !isStaticReducedInitial &&
    hasBeenSeen &&
    !paused &&
    !isComplete &&
    isViewportActive;

  const stepMs = speed === 0.5 ? BASE_STEP_MS * 2 : BASE_STEP_MS;

  useEffect(() => {
    if (!isRunning) return;
    const timer = setTimeout(() => {
      setTick((prev) => Math.min(maxTick, prev + 1));
    }, stepMs);
    return () => clearTimeout(timer);
  }, [isRunning, effectiveTick, maxTick, stepMs]);

  const startFreshRun = () => {
    setManualRunId((prev) => prev + 1);
    setPaused(false);
    setTick(0);
  };

  const handleFire = () => {
    if (isComplete || isStaticReducedInitial) {
      startFreshRun();
    } else {
      setPaused((prev) => !prev);
    }
  };

  const handleToggleSpeed = () => {
    setSpeed((prev) => (prev === 1 ? 0.5 : 1));
  };

  const dispatched = Math.min(data.totalAttempts, effectiveTick);
  const scripRejected = Math.max(
    0,
    data.totalAttempts - data.scrip.paymentsPaid,
  );
  const burstSecondsRounded = Math.round(Number(data.naive.burstSeconds));

  const liveAnnouncement = isComplete
    ? `Result: Naive contract paid ${data.naive.paymentsPaid} of ${data.totalAttempts} (${data.naive.spentUsdc} USDC, leaked ${data.naive.overBudgetUsdc} USDC). Scrip vault locked at ${data.scrip.paymentsPaid} of ${data.totalAttempts} (${data.scrip.spentUsdc} USDC) and bounced ${scripRejected} excess calls with OVER_BUDGET.`
    : paused
      ? `Burst paused at ${dispatched} of ${data.totalAttempts} requests.`
      : `Firing ${data.totalAttempts} parallel ${data.paymentUsdc} USDC requests against a ${data.budgetUsdc} USDC budget.`;

  return (
    <section id="the-race" ref={containerRef} className="bp-section">
      <div className="bp-container grid gap-10">
        {/* Left narrative column */}
        <div className="max-w-[64ch]">
          <div className="bp-chapter-label mb-3">
            <span className="text-bp-pass font-bold">02</span>
            <span>/</span>
            <span>The race</span>
          </div>

          <h2 className="bp-display bp-section-title max-w-[14ch]">
            Thirty shots at a one-dollar vault.
          </h2>

          <p className="mt-4 bp-prose text-[15px] sm:text-base">
            {data.totalAttempts} parallel {data.paymentUsdc} USDC requests hit a{" "}
            {data.budgetUsdc} USDC mandate in a ~{burstSecondsRounded}s burst.
            The naive contract checks balance inside an async callback and leaks{" "}
            {data.naive.overBudgetUsdc} USDC. Scrip reserves atomically up
            front and drops the blast bar at {data.scrip.spentUsdc} USDC.
          </p>

          <p className="mt-5 text-[13px] font-mono text-bp-muted max-w-[52ch] leading-relaxed">
            <span className="text-bp-pass mr-1.5" aria-hidden="true">
              ↳
            </span>
            Press Fire {data.totalAttempts} on the deck to replay the burst.
          </p>

          <div className="mt-4 flex flex-wrap gap-2.5">
            <button
              type="button"
              onClick={startFreshRun}
              className="bp-btn bp-btn-secondary bp-btn-sm"
            >
              Replay
            </button>
            <button
              type="button"
              onClick={handleToggleSpeed}
              aria-pressed={speed === 0.5}
              className="bp-btn bp-btn-secondary bp-btn-sm"
            >
              {speed === 0.5 ? "● 0.5x slow" : "○ 0.5x slow"}
            </button>
          </div>
        </div>

        {/* Right diorama + readout below */}
        <div ref={sceneHostRef} className="min-w-0 bp-scene-host">
          <RaceScene
            data={data}
            tick={effectiveTick}
            maxTick={maxTick}
            stepMs={stepMs}
            isRunning={isRunning}
            isViewportActive={isViewportActive}
            speed={speed}
            onFire={handleFire}
            onRunAgain={startFreshRun}
            onToggleSpeed={handleToggleSpeed}
          />

          {/* Readout panel below the diorama */}
          <div className="mt-4 bp-plate p-3.5 sm:p-4 space-y-2.5">
            <div className="flex flex-wrap items-center justify-between gap-2 text-[13px] font-mono text-bp-muted border-b border-bp-line pb-2">
              <span className="bp-tabular">
                Dispatched{" "}
                <strong className="text-bp-ink">{dispatched}</strong>/
                {data.totalAttempts} · speed{" "}
                <strong className="text-bp-ink">{speed}x</strong>
              </span>
              <span className="bp-tabular">
                Naive{" "}
                <strong className="text-bp-reject">
                  {data.naive.spentUsdc}
                </strong>{" "}
                (+{data.naive.overBudgetUsdc}) · Scrip{" "}
                <strong className="text-bp-pass">
                  {data.scrip.spentUsdc}
                </strong>{" "}
                (<code className="text-bp-reject">OVER_BUDGET</code> ×
                {scripRejected})
              </span>
            </div>

            <div
              aria-live="polite"
              className="text-[13px] font-mono text-bp-ink leading-relaxed"
            >
              <span className="text-bp-pass mr-2" aria-hidden="true">
                ▶
              </span>
              {liveAnnouncement}
            </div>

            <p className="text-[13px] font-mono text-bp-muted leading-relaxed pt-1 border-t border-bp-line">
              {data.totalAttempts} pre-signed payments, ~{burstSecondsRounded} s
              burst, recorded on NEAR {data.network},{" "}
              <code className="text-bp-ink">results/attack.json</code>, on 30 Oct 2026,
              before later contract changes; a re-run is planned before the final freeze.
            </p>
          </div>

          <div
            data-reveal-item
            className="pt-8 grid gap-x-12 gap-y-6 sm:grid-cols-2"
          >
            <div>
              <span className="bp-display bp-tabular block text-[clamp(3.5rem,8vw,6rem)] leading-none text-bp-reject">
                +{data.naive.overBudgetUsdc}
              </span>
              <span className="mt-2 block text-[13px] font-mono text-bp-muted leading-relaxed">
                <span className="text-bp-reject mr-1.5" aria-hidden="true">
                  ✕
                </span>
                Naive leaked past the {data.budgetUsdc} USDC budget.
              </span>
            </div>
            <div>
              <span className="bp-display bp-tabular block text-[clamp(3.5rem,8vw,6rem)] leading-none text-bp-pass">
                {data.scrip.spentUsdc}
              </span>
              <span className="mt-2 block text-[13px] font-mono text-bp-muted leading-relaxed">
                <span className="text-bp-pass mr-1.5" aria-hidden="true">
                  ✓
                </span>
                Scrip held the line; {scripRejected} calls got OVER_BUDGET.
              </span>
            </div>
          </div>
        </div>
      </div>
    </section>
  );
}
