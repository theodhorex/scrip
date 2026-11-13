"use client";

import { useEffect, useRef, useState, type RefObject } from "react";
import { lerpScene, project, renderScene, type Prism, type View } from "@/lib/iso";
import { howScene, type Scene } from "@/lib/scenes";
import { IsoSvg, type IsoLabel, type IsoLine } from "./IsoSvg";
import { EASE_OUT, motionOK, onTick } from "./scroll-bus";

const PITCH = 28, SCALE = 1.9, SWITCH_MS = 750, LOOP_MS = 4200;
const REST_YAW = -26;

type Frame = { prisms: Prism[]; scene: Scene; yaw: number };

function draw(f: Frame) {
  const v: View = { yaw: f.yaw, pitch: PITCH, scale: SCALE };
  const faces = renderScene(f.prisms, v);
  const labels: IsoLabel[] = f.scene.labels.map((l) => { const p = project(l.at, v); return { x: p.x, y: p.y, text: l.text, tone: l.tone, anchor: l.anchor }; });
  const lines: IsoLine[] = f.scene.lines.map((l) => { const a = project(l.a, v), b = project(l.b, v); return { a: [a.x, a.y], b: [b.x, b.y], tone: l.tone, dash: l.dash }; });
  return { faces, labels, lines };
}

/** Sticky isometric figure for the four steps. The yaw follows scroll progress, the pose follows the active step. */
export function HowScene({ step, progress }: { step: number; progress: RefObject<number> }) {
  const [frame, setFrame] = useState<Frame | null>(null);
  const wrap = useRef<HTMLDivElement>(null);
  const stepRef = useRef(step);
  const from = useRef<Prism[]>([]);
  const last = useRef<Prism[]>([]);
  const t0 = useRef(0);
  const lastYaw = useRef(REST_YAW);

  useEffect(() => {
    from.current = last.current;
    t0.current = performance.now();
    stepRef.current = step;
  }, [step]);

  useEffect(() => {
    const el = wrap.current;
    if (!el || !motionOK()) return;
    let stop: (() => void) | null = null;
    const io = new IntersectionObserver(([e]) => {
      if (e.isIntersecting && !stop) {
        stop = onTick((_dt, now) => {
          const s = stepRef.current;
          const k = Math.min(1, (now - t0.current) / SWITCH_MS);
          const yaw = REST_YAW + (progress.current ?? 0) * 34;
          const looping = s === 2;
          if (k >= 1 && !looping && Math.abs(yaw - lastYaw.current) < 0.05) return;
          lastYaw.current = yaw;
          const scene = howScene(s, (now % LOOP_MS) / LOOP_MS);
          const prisms = k < 1 && from.current.length ? lerpScene(from.current, scene.prisms, EASE_OUT(k)) : scene.prisms;
          last.current = prisms;
          setFrame({ prisms, scene, yaw });
        });
      } else if (!e.isIntersecting && stop) { stop(); stop = null; }
    });
    io.observe(el);
    return () => { io.disconnect(); stop?.(); };
  }, [progress]);

  const f = frame ?? (() => { const scene = howScene(step, 0.6); return { prisms: scene.prisms, scene, yaw: REST_YAW }; })();
  const { faces, labels, lines } = draw(f);
  return (
    <div className="nl-hscene" ref={wrap} aria-hidden="true" data-nodes={faces.length}>
      <IsoSvg viewBox="-240 -260 480 340" faces={faces} labels={labels} lines={lines} />
    </div>
  );
}
