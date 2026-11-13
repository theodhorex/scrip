"use client";

import { useEffect, useRef, useState } from "react";
import { project, renderScene, type View } from "@/lib/iso";
import { plateTop, stackPrisms } from "@/lib/limit-stack";
import { SectionHead } from "./Section";
import { IsoSvg, type IsoLabel } from "./IsoSvg";
import { useDragYaw } from "./useDragYaw";
import { motionOK, onTick } from "./scroll-bus";
import "./base.css";
import "./limits.css";

/** Source: README "Not Built & Limitations" and contracts/scrip/F45_RESOLUTION.md. Not softened on purpose. */
const LIMITS = [
  { t: "Testnet only.", b: "No mainnet contract is deployed. Nothing here has ever held real money." },
  { t: "No third-party audit.", b: "The contract went through internal review rounds plus unit, property and mutation tests. No independent firm has reviewed it." },
  { t: "The demo agent is a script, not an LLM.", b: "It always obeys the injected instruction on purpose, to test whether the contract holds. It says nothing about how a real model behaves." },
  { t: "Counterparty signals need an indexer.", b: "Account age and history cannot come from a node RPC alone. The counterparty guard is a client-side module and is not wired into the main payment flow." },
  { t: "All mandates share one token pool.", b: "Mandates on one deployment share the contract's NEP-141 balance, and isolation is bookkeeping. You also have to trust the token contract itself." },
  { t: "The contract cannot be upgraded.", b: "There is no migrate function and the full-access key was burnt at initialisation. A fix means a new deployment and a withdrawal." },
  { t: "A lost callback locks that mandate's funds.", b: "Measured callback gas is 7 to 8 times under the pinned limit, but if one were ever lost, only the guardian can settle it, and only as transferred. A lost guardian key leaves it locked. Other mandates are not affected." },
  { t: "A stolen agent key still spends.", b: "Up to what is left of the budget, to allowed recipients, under the per-payment cap. Scrip bounds the loss. It does not make theft impossible." },
] as const;

const N = LIMITS.length + 1; // plate 0 is the guarantee at the bottom; limit i sits on plate N-1-i so the stack reads like the list
const REST_YAW = -30;

/** Exploded stack: one plate per limit. Hover, focus or click a limit and its plate lifts out. Decorative: the list is the content. */
function LimitStack({ active }: { active: number }) {
  const [explode, setExplode] = useState(0);
  const wrap = useRef<HTMLDivElement>(null);
  const target = useRef(0);
  const { yaw, bind } = useDragYaw(REST_YAW, 40);

  useEffect(() => {
    const el = wrap.current;
    if (!el) return;
    const fast = !motionOK();
    let stop: (() => void) | null = null;
    let cur = 0;
    const io = new IntersectionObserver(([e]) => {
      target.current = e.isIntersecting ? 1 : 0;
      if (fast) { setExplode(target.current); return; }
      if (e.isIntersecting && !stop) {
        stop = onTick((dt) => {
          cur += (target.current - cur) * Math.min(1, dt / 260);
          if (Math.abs(target.current - cur) < 0.003) { cur = target.current; setExplode(cur); if (stop && target.current === 0) { stop(); stop = null; } return; }
          setExplode(cur);
        });
      }
    }, { threshold: 0.35 });
    io.observe(el);
    return () => { io.disconnect(); stop?.(); };
  }, []);

  const act = active < 0 ? -1 : N - 1 - active;
  const v: View = { yaw, pitch: 30, scale: 1.6 };
  const faces = renderScene(stackPrisms(N, explode, act), v);
  const labels: IsoLabel[] = [];
  const base = project([PLATE_HALF, 0, plateTop(0, explode, act)], v);
  labels.push({ x: base.x + 8, y: base.y, text: "bottom: budget ceiling", tone: act === 0 ? "bright" : undefined });
  if (act > 0) { const q = project([PLATE_HALF, 0, plateTop(act, explode, act)], v); labels.push({ x: q.x + 8, y: q.y, text: `limit ${active + 1}`, tone: "bright" }); }
  return (
    <div className="nl-lstack" ref={wrap} aria-hidden="true" data-nodes={faces.length} {...bind}>
      <IsoSvg viewBox="-200 -250 500 330" faces={faces} labels={labels} />
    </div>
  );
}
const PLATE_HALF = 75;

export function LimitsSection() {
  const [pinned, setPinned] = useState(-1);
  const [hover, setHover] = useState(-1);
  const active = hover >= 0 ? hover : pinned;
  return (
    <section className="nl-sec" id="limits" aria-labelledby="limits-title">
      <div className="nl-wrap">
        <SectionHead id="limits" n={7} label="Limits" lines={["What does not", "exist yet."]}
          lede="Read this before anything else on the page. It is the same list as the repository README."
          plain="An honest list of what is not ready yet. Scrip is a testnet prototype: do not put real money in it." />
        <div className="nl-limits-grid">
          <ol className="nl-limits-list">
            {LIMITS.map((l, i) => (
              <li className="nl-limit" key={l.t} data-reveal="rise" data-active={active === i ? "" : undefined} style={{ "--i": i % 3 } as React.CSSProperties}
                onMouseEnter={() => setHover(i)} onMouseLeave={() => setHover(-1)}>
                <div>
                  <h3><button type="button" className="nl-limit-btn" aria-pressed={pinned === i} onClick={() => setPinned(pinned === i ? -1 : i)} onFocus={() => setHover(i)} onBlur={() => setHover(-1)}>{l.t}</button></h3>
                  <p className="nl-body">{l.b}</p>
                </div>
              </li>
            ))}
          </ol>
          <div className="nl-lstack-col">
            <LimitStack active={active} />
            <p className="nl-note">Eight plates, one per limit, standing on the one thing that does hold: the contract checks spent + reserved + amount against the budget on every payment. Hover, focus or press a limit to lift its plate. Drag to turn.</p>
          </div>
        </div>
      </div>
    </section>
  );
}
