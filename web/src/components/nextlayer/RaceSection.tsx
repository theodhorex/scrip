"use client";

import { useEffect, useRef, useState } from "react";
import { SectionHead } from "./Section";
import { RACE, formatRecorded } from "./data";
import { motionOK } from "./scroll-bus";
import "./base.css";
import "./race.css";

const N = RACE.totalAttempts;
const MAX = Math.max(Number(RACE.naive.spentUsdc), Number(RACE.scrip.spentUsdc), Number(RACE.budgetUsdc)) * 1.15;
const BUDGET = Number(RACE.budgetUsdc);

type Lane = { key: "naive" | "scrip"; title: string; sub: string; paid: number; spent: number };
const LANES: Lane[] = [
  { key: "naive", title: "Naive contract", sub: "no running budget", paid: RACE.naive.paymentsPaid, spent: Number(RACE.naive.spentUsdc) },
  { key: "scrip", title: "Scrip contract", sub: "reserve, then pay", paid: RACE.scrip.paymentsPaid, spent: Number(RACE.scrip.spentUsdc) },
];

export function RaceSection() {
  const [playing, setPlaying] = useState(false);
  const [speed, setSpeed] = useState(1);
  const refs = useRef<Record<string, { bar: HTMLElement | null; over: HTMLElement | null; txt: HTMLElement | null }>>({ naive: { bar: null, over: null, txt: null }, scrip: { bar: null, over: null, txt: null } });
  const attemptRef = useRef<HTMLSpanElement>(null);
  const raf = useRef(0);
  const sectionRef = useRef<HTMLDivElement>(null);

  function paint(k: number) {
    // k in 0..1 across the N attempts. The recording stores totals per contract, not the order of the 30 attempts,
    // so each bar is filled evenly up to its recorded total (interpolated, not a replay of real timing).
    const attempt = Math.round(k * N);
    if (attemptRef.current) attemptRef.current.textContent = `attempt ${String(attempt).padStart(2, "0")} of ${N}`;
    for (const l of LANES) {
      const r = refs.current[l.key];
      const v = l.spent * k;
      const within = Math.min(v, BUDGET);
      const over = Math.max(0, v - BUDGET);
      if (r.bar) r.bar.style.transform = `scaleX(${(within / MAX).toFixed(4)})`;
      if (r.over) { r.over.style.left = `${(BUDGET / MAX) * 100}%`; r.over.style.width = `${(1 - BUDGET / MAX) * 100}%`; r.over.style.transform = `scaleX(${(over / (MAX - BUDGET)).toFixed(4)})`; }
      if (r.txt) r.txt.textContent = `${Math.round(l.paid * k)} paid, ${v.toFixed(2)} USDC`;
    }
  }

  // show the recorded end state first (also the reduced-motion state)
  useEffect(() => { paint(1); return () => cancelAnimationFrame(raf.current); }, []);

  function replay() {
    cancelAnimationFrame(raf.current);
    if (!motionOK()) { paint(1); setPlaying(false); return; }
    setPlaying(true);
    const dur = (N * RACE.paceMs * 2.4) / speed; // 1x = 5.8 s so the eye can follow 30 attempts
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / dur);
      paint(k < 1 ? Math.floor(k * N) / N : 1);
      if (k < 1) raf.current = requestAnimationFrame(step); else setPlaying(false);
    };
    paint(0);
    raf.current = requestAnimationFrame(step);
  }

  return (
    <section className="nl-sec" id="race" aria-labelledby="race-title">
      <div className="nl-wrap">
        <SectionHead id="race" n={3} label="Recorded run" lines={["Thirty payments,", "one budget."]}
          lede={<>An agent fires {N} payments of {RACE.paymentUsdc} USDC at a budget of {RACE.budgetUsdc} USDC. Same burst, two contracts.</>}
          todo="Press Replay recorded run and watch the two bars fill."
          plain="What happens when an agent goes wild. Without a limit it kept paying past the budget. With Scrip it stopped at the budget." />
        <div className="nl-race" ref={sectionRef}>
          <div className="nl-race-stage">
            {LANES.map((l) => (
              <div className="nl-lane" key={l.key}>
                <div className="nl-lane-top">
                  <h3>{l.title} <span className="nl-note">{l.sub}</span></h3>
                  <span className="mono" ref={(el) => { refs.current[l.key].txt = el; }}>{l.paid} paid, {l.spent.toFixed(2)} USDC</span>
                </div>
                <div className="nl-track" role="img" aria-label={`${l.title}: ${l.paid} payments paid, ${l.spent.toFixed(2)} USDC, budget ${BUDGET.toFixed(2)}`}>
                  <div className="nl-bar" ref={(el) => { refs.current[l.key].bar = el; }} />
                  <div className="nl-bar-over" ref={(el) => { refs.current[l.key].over = el; }} />
                  <span className="nl-race-line" style={{ left: `${(BUDGET / MAX) * 100}%` }}><span>{l.key === "naive" ? "budget 1.00" : ""}</span></span>
                </div>
                {l.key === "naive" ? <p className="nl-note" style={{ marginTop: 8 }}>Past the line (red): {RACE.naive.overBudgetUsdc} USDC paid beyond the budget.</p> : <p className="nl-note" style={{ marginTop: 8 }}>Stopped at the line. {RACE.scrip.attempts - RACE.scrip.paymentsPaid} of {RACE.scrip.attempts} requests did not pay.</p>}
              </div>
            ))}
            <div className="nl-race-ctl">
              <button type="button" className="nl-btn" data-primary onClick={replay} disabled={playing}>{playing ? "Replaying" : "Replay recorded run"}</button>
              <label>Speed<input type="range" min={0.5} max={4} step={0.5} value={speed} onChange={(e) => setSpeed(Number(e.target.value))} aria-valuetext={`${speed} times`} /><span className="mono">{speed}x</span></label>
              <span className="nl-attempt" ref={attemptRef} aria-hidden="true">attempt {N} of {N}</span>
            </div>
            <p className="nl-note" style={{ marginTop: 18 }}>
              The recording stores totals per contract, not the order of the {N} attempts, so the replay fills each bar evenly up to its recorded total. It is not a re-enactment of real timing.
            </p>
          </div>
          <div>
            <dl className="nl-race-facts">
              <div><dt>Network</dt><dd>{RACE.network}</dd></div>
              <div><dt>Recorded</dt><dd>{formatRecorded(RACE.startedAt)}</dd></div>
              <div><dt>Attempts</dt><dd>{N} x {RACE.paymentUsdc} USDC</dd></div>
              <div><dt>Budget</dt><dd>{RACE.budgetUsdc} USDC</dd></div>
              <div><dt>Naive paid</dt><dd>{RACE.naive.paymentsPaid} ({RACE.naive.spentUsdc} USDC)</dd></div>
              <div><dt>Scrip paid</dt><dd>{RACE.scrip.paymentsPaid} ({RACE.scrip.spentUsdc} USDC)</dd></div>
              <div><dt>Burst length</dt><dd>about {RACE.scrip.burstSeconds} s</dd></div>
            </dl>
            <p className="nl-note" style={{ marginTop: 16 }}>Source: results/attack.json.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
