"use client";

import { useEffect, useRef, useState } from "react";
import { facesOf, project, renderScene, type View } from "@/lib/iso";
import { GATE_ORDER } from "@/lib/scenes";
import { DOOR_X, GATE_NOTES, isGround, parkX, vaultScene } from "@/lib/vault-scene";
import { START_X } from "@/lib/rule-scene";
import { IsoSvg, type IsoLabel } from "./IsoSvg";
import { useDragYaw } from "./useDragYaw";
import { motionOK, onTick } from "./scroll-bus";

const REST_YAW = -38, PITCH = 34, SCALE = 1.6, LOOP_MS = 9000, AJAR = 0.3;
type Frame = { x: number; open: number; sway: number };

/** Where the idle walk has the block at time `ms`, and how far the door stands open. Illustration only, not a live call. */
function walk(ms: number) {
  const k = (ms % LOOP_MS) / LOOP_MS;
  const run = Math.min(1, k / 0.62);
  const e = 1 - Math.pow(1 - run, 2.2);
  const x = START_X + (DOOR_X - 18 - START_X) * e;
  const open = k < 0.5 ? AJAR : k < 0.62 ? AJAR + (1 - AJAR) * ((k - 0.5) / 0.12) : k < 0.9 ? 1 : 1 - (1 - AJAR) * ((k - 0.9) / 0.1);
  return { x: k < 0.9 ? x : START_X + (x - START_X) * (1 - (k - 0.9) / 0.1), open };
}

/**
 * The closing figure: the seven walls in the contract's order, the vault door they lead to, the mandate key with its one tooth,
 * and the budget as a column. Decorative (aria-hidden); the controls and the sentence below are the real content.
 */
export function VaultScene() {
  const [frame, setFrame] = useState<Frame>({ x: START_X, open: AJAR, sway: 0 });
  const [active, setActive] = useState(-1);
  const [opened, setOpened] = useState(false);
  const wrap = useRef<HTMLDivElement>(null);
  const sel = useRef(-1), forced = useRef(false), hold = useRef(false), cur = useRef<Frame>({ x: START_X, open: AJAR, sway: 0 });
  const { yaw, bind } = useDragYaw(REST_YAW, 38);

  useEffect(() => { sel.current = active; }, [active]);
  useEffect(() => { forced.current = opened; }, [opened]);

  useEffect(() => {
    const el = wrap.current;
    if (!el || !motionOK()) return;
    const calm = innerWidth <= 430;
    let stop: (() => void) | null = null;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !stop) {
        stop = onTick((dt, now) => {
          const c = cur.current;
          const w = walk(now);
          const s = sel.current;
          const tx = s >= 0 ? parkX(s) : w.x;
          const to = forced.current ? 1 : s >= 0 || hold.current ? AJAR : w.open;
          const k = Math.min(1, dt / 160);
          const nx = c.x + (tx - c.x) * k, no = c.open + (to - c.open) * k, ns = calm ? 0 : Math.sin(now / 3400) * 2.5;
          if (Math.abs(nx - c.x) < 0.02 && Math.abs(no - c.open) < 0.002 && Math.abs(ns - c.sway) < 0.02) return;
          cur.current = { x: nx, open: no, sway: ns };
          setFrame(cur.current);
        });
      } else if (!e.isIntersecting && stop) { stop(); stop = null; }
    }, { threshold: 0.2 });
    io.observe(el);
    return () => { io.disconnect(); stop?.(); };
  }, []);

  // reduced motion: no loop, but the controls still work, instantly
  const still = typeof window !== "undefined" && !motionOK();
  const shown: Frame = still ? { x: active >= 0 ? parkX(active) : START_X, open: opened ? 1 : AJAR, sway: 0 } : frame;
  const v: View = { yaw: yaw + shown.sway, pitch: PITCH, scale: SCALE };
  const scene = vaultScene({ blockX: shown.x, open: shown.open, active });
  const faces = [...scene.prisms.filter((p) => isGround(p.id)).flatMap((p) => facesOf(p, v)), ...renderScene(scene.prisms.filter((p) => !isGround(p.id)), v)];
  const labels: IsoLabel[] = scene.labels.map((l) => { const p = project(l.at, v); return { x: p.x + (l.dx ?? 0), y: p.y, text: l.text, tone: l.tone, anchor: l.anchor }; });

  return (
    <figure className="nl-vault" ref={wrap}>
      <div className="nl-vault-svg" aria-hidden="true" data-nodes={faces.length} {...bind}
        onPointerEnter={() => { hold.current = true; }} onPointerLeave={() => { hold.current = false; }}>
        <IsoSvg viewBox="-262 -195 600 360" faces={faces} labels={labels} />
      </div>
      <figcaption>
        <div className="nl-vault-ctl" role="group" aria-label="Walk through the seven checks">
          {GATE_ORDER.map((g, i) => (
            <button type="button" key={g.code} aria-pressed={active === i} data-on={active === i ? "" : undefined}
              onClick={() => setActive(active === i ? -1 : i)} onMouseEnter={() => setActive(i)} onFocus={() => setActive(i)}>
              <span>{i + 1}</span>{g.label}
            </button>
          ))}
          <button type="button" className="nl-vault-door" aria-pressed={opened} onClick={() => setOpened(!opened)}>{opened ? "Close the door" : "Open the door"}</button>
        </div>
        <p className="nl-vault-note" aria-live="polite">
          {active >= 0 ? <><strong>Check {active + 1} of 7.</strong> {GATE_NOTES[active]}</> : "Seven checks stand between an agent's request and the vault. The first failure refuses the payment. Hover or press a number to read one."}
        </p>
        <p className="nl-note">Worked example, not a live chain: budget 1.00, spent 0.20. Drag the figure to turn it.</p>
      </figcaption>
    </figure>
  );
}
