"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { LandingHeroDemoData } from "@/lib/landing-data";
import { HERO_FINAL_STEP, HERO_TOTAL_STEPS, deriveHeroStep } from "./hero-state";
import { HeroScene } from "./HeroScene";
import { useReducedMotion } from "./useReducedMotion";
import { useAnimationActive } from "./useAnimationActive";
import { useCursorParallax } from "./useCursorParallax";

type Props = {
  data: LandingHeroDemoData;
};

// Story episodes: each one starts at a step of the 8-step state machine in hero-state.ts.
const EPISODES = [
  { label: "Fund", from: 0, to: 1 },
  { label: "Request", from: 2, to: 3 },
  { label: "Paid", from: 4, to: 4 },
  { label: "Hijack", from: 5, to: 5 },
  { label: "Blocked", from: 6, to: 7 },
] as const;

export function HeroSection({ data }: Props) {
  const prefersReducedMotion = useReducedMotion();
  const { containerRef, isViewportActive } = useAnimationActive<HTMLElement>();
  const [isPlayingOverride, setIsPlayingOverride] = useState<boolean | null>(null);
  const [step, setStep] = useState(0);

  const shouldAnimate = (isPlayingOverride ?? !prefersReducedMotion) && isViewportActive;
  const activeStep =
    !shouldAnimate && prefersReducedMotion && isPlayingOverride === null ? HERO_FINAL_STEP : step;

  useEffect(() => {
    if (!shouldAnimate) return;
    const intervalMs = activeStep === 6 || activeStep === 7 ? 3200 : 2500;
    const timer = setTimeout(() => setStep((prev) => (prev + 1) % HERO_TOTAL_STEPS), intervalMs);
    return () => clearTimeout(timer);
  }, [shouldAnimate, activeStep]);

  const parallaxRef = useCursorParallax<HTMLDivElement>(isViewportActive);
  const derived = deriveHeroStep(activeStep, data);
  const activeEpisode = EPISODES.findIndex((e) => activeStep >= e.from && activeStep <= e.to);

  const togglePlayback = () => setIsPlayingOverride((prev) => (prev === null ? prefersReducedMotion : !prev));
  const jumpTo = (from: number) => {
    setIsPlayingOverride(false);
    setStep(from);
  };

  return (
    <section ref={containerRef} className="bp-hero-section">
      <div className="bp-container grid gap-10 lg:grid-cols-[minmax(0,5fr)_minmax(0,7fr)] lg:items-center">
        <div>
          <div className="bp-kicker inline-flex items-center gap-2 px-2.5 py-1 rounded-xs border border-bp-line-strong bg-bp-surface text-bp-muted mb-6">
            <span className="bp-beacon-dot inline-block w-2 h-2 rounded-full bg-bp-pass" />
            <span>NEAR testnet · capped mandates for AI agents</span>
          </div>

          <h1 className="bp-display bp-hero-title">Keys can be stolen. Funds can&apos;t.</h1>

          <p className="mt-6 text-lg bp-prose">
            Your agent holds a key that can call exactly one method,{" "}
            <code className="text-bp-ink font-mono bg-bp-surface px-1.5 py-0.5 rounded-xs border border-bp-line text-sm">
              request_payment
            </code>
            . The contract decides every payment: who, how much, how much in total, until when.
          </p>

          <div className="mt-8 flex flex-wrap items-center gap-4">
            <a href="#the-race" className="bp-btn bp-btn-primary">
              See the attack
            </a>
            <Link href="/overview" className="bp-btn bp-btn-secondary">
              Open the dashboard
            </Link>
          </div>

          <div className="mt-10" role="group" aria-label="Story episodes">
            <div className="flex items-center gap-2 mb-3">
              <button
                type="button"
                onClick={togglePlayback}
                aria-label={shouldAnimate ? "Pause the story" : "Play the story"}
                className="bp-btn bp-btn-secondary bp-btn-sm"
              >
                {shouldAnimate ? "❚❚ Pause" : "▶ Play"}
              </button>
              <span className="text-xs font-mono text-bp-muted">The story of one payment</span>
            </div>
            <ol className="grid grid-cols-5 gap-2 list-none p-0 m-0">
              {EPISODES.map((e, i) => {
                const on = i === activeEpisode;
                return (
                  <li key={e.label}>
                    <button
                      type="button"
                      onClick={() => jumpTo(e.from)}
                      aria-current={on ? "step" : undefined}
                      className="w-full text-left cursor-pointer group"
                    >
                      <span className={`block h-0.5 mb-2 ${on ? "bg-bp-pass" : i < activeEpisode ? "bg-bp-line-strong" : "bg-bp-line"}`} />
                      <span className={`block text-[13px] font-mono ${on ? "text-bp-ink" : "text-bp-muted"} group-hover:text-bp-ink`}>
                        <span className="text-bp-pass sm:mr-1">{i + 1}</span>
                        <span className="hidden sm:inline">{e.label}</span>
                      </span>
                    </button>
                  </li>
                );
              })}
            </ol>
            <p className="sm:hidden mt-2 text-[13px] font-mono text-bp-ink" aria-hidden="true">
              <span className="text-bp-pass">{String(activeEpisode + 1).padStart(2, "0")} / {String(EPISODES.length).padStart(2, "0")}</span>{" "}
              {EPISODES[activeEpisode]?.label}
            </p>
          </div>
        </div>

        <div className="lg:-mr-32 bp-scene-host">
          <div ref={parallaxRef} className="bp-hero-parallax">
            <HeroScene data={data} derived={derived} animate={shouldAnimate} />
          </div>
          <p className="mt-1 text-xs font-mono text-bp-muted">
            <span className="text-bp-pass">01</span> recipient · <span className="text-bp-pass">02</span> per-payment cap · <span className="text-bp-pass">03</span> budget
          </p>
          <div aria-live={shouldAnimate ? "off" : "polite"} className="mt-2 text-[13px] font-mono text-bp-ink min-h-[3.2em]">
            <span className="text-bp-pass mr-2">▶</span>
            {derived.caption}
          </div>
        </div>
      </div>
    </section>
  );
}
