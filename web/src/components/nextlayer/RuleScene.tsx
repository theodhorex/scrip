"use client";

import { useEffect, useRef, useState } from "react";
import { project, renderScene, type View } from "@/lib/iso";
import { GATE_ORDER } from "@/lib/scenes";
import { GATE_X, ruleScene, COLUMN_H, END_X } from "@/lib/rule-scene";
import { IsoSvg, type IsoLabel } from "./IsoSvg";
import { useDragYaw } from "./useDragYaw";
import { motionOK, onTick } from "./scroll-bus";

const RUN_MS = 1500, REST_YAW = -24;
const VIEW = { pitch: 26, scale: 1.55 };

export type RuleRun = { n: number; failIndex: number | null } | null;
type Props = { milli: number; stranger: boolean; approved: boolean; needsApproval: boolean; spentFrac: number; reservedFrac: number; run: RuleRun };

/** The contract's seven checks as seven walls. Everything here is also written out in the result text and the log: the figure is aria-hidden. */
export function RuleScene(p: Props) {
  const [tr, setTr] = useState<{ n: number; t: number }>({ n: -1, t: 1 });
  const wrap = useRef<HTMLDivElement>(null);
  const t0 = useRef(0);
  const { yaw, bind } = useDragYaw(REST_YAW);

  useEffect(() => {
    if (!p.run || !motionOK()) return;
    const n = p.run.n;
    t0.current = performance.now();
    let stop: (() => void) | null = onTick((_dt, now) => {
      const k = Math.min(1, (now - t0.current) / RUN_MS);
      setTr({ n, t: k });
      if (k >= 1 && stop) { stop(); stop = null; }
    });
    return () => { stop?.(); };
  }, [p.run]);

  const running = p.run !== null;
  const tt = running && motionOK() ? (tr.n === p.run?.n ? tr.t : 0) : 1;
  const sc = ruleScene({ ...p, run: p.run ? { failIndex: p.run.failIndex, t: tt } : null });
  const v: View = { yaw, ...VIEW };
  const faces = renderScene(sc.prisms, v);
  const labels: IsoLabel[] = GATE_X.map((x, i) => { const q = project([x + 1.5, -42, 42], v); return { x: q.x, y: q.y, text: String(i + 1), anchor: "middle" as const, tone: sc.failIndex === i && tt > 0.55 ? "reject" as const : sc.lit > i ? "bright" as const : undefined }; });
  const col = project([END_X + 23, 16, COLUMN_H + 8], v);
  labels.push({ x: col.x, y: col.y, text: "budget plane", anchor: "middle" });
  const failed = p.run?.failIndex ?? null;

  return (
    <figure className="nl-rscene" ref={wrap}>
      <div className="nl-rscene-svg" aria-hidden="true" data-nodes={faces.length} {...bind}>
        <IsoSvg viewBox="-250 -165 520 235" faces={faces} labels={labels} />
      </div>
      <figcaption>
        <ol className="nl-gates" aria-label="The seven checks, in the contract's order">
          {GATE_ORDER.map((g, i) => (
            <li key={g.code} data-state={failed === i && tt > 0.55 ? "fail" : sc.lit > i ? "pass" : undefined}><span>{i + 1}</span>{g.label}</li>
          ))}
        </ol>
        <p className="nl-note">Block size is the amount, the lane is the recipient, the extra bar is the approval. Drag to turn the figure. A rejected block stops at the first wall it breaks.</p>
      </figcaption>
    </figure>
  );
}
