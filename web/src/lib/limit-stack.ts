// Pure layout for the exploded plate stack in #limits. Plate 0 is the bottom one: the guarantee. Erasable TS only.
import type { Prism } from "./iso";
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { box } from "./iso.ts";

export const PLATE = { w: 150, d: 104, h: 5 } as const;

/** explode 0..1 spreads the plates, active (or -1) lifts one plate out and marks it. */
export function stackPrisms(n: number, explode: number, active: number): Prism[] {
  const gap = 2 + 15 * Math.min(1, Math.max(0, explode));
  const out: Prism[] = [];
  for (let i = 0; i < n; i++) {
    const lift = i === active ? 11 : 0;
    const z = i * (PLATE.h + gap) + lift;
    const tone = i === active ? "bright" : "matte";
    out.push(box(`plate-${i}`, -PLATE.w / 2, -PLATE.d / 2, z, PLATE.w, PLATE.d, PLATE.h, tone));
  }
  return out;
}

/** World z of the top face of plate i, so labels can sit on it. */
export const plateTop = (i: number, explode: number, active: number) => i * (PLATE.h + 2 + 15 * Math.min(1, Math.max(0, explode))) + (i === active ? 11 : 0) + PLATE.h;
