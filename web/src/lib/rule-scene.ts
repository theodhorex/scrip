// Pure geometry for the rule machine's 3D lane. Seven walls in the contract's order, a block sized by the amount,
// a column that is the budget. Erasable TS only (node --test).
import type { Prism } from "./iso";
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { box } from "./iso.ts";
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { GATE_ORDER } from "./scenes.ts";

export const GATE_X: number[] = GATE_ORDER.map((_: unknown, i: number) => -78 + i * 30);
export const START_X = -122;
export const END_X = 128;
export const COLUMN_H = 52; // world height of the full budget (budget 1.00)
export const DEPOSIT_RATIO = 1.5;

/** Which wall stops a payment with this reject code. The three approval codes all belong to the last wall. */
export function gateIndexOf(code: string): number {
  if (code.startsWith("APPROVAL_")) return GATE_ORDER.length - 1;
  return GATE_ORDER.findIndex((g: { code: string }) => g.code === code);
}

export const blockSide = (milli: number) => 8 + (Math.min(600, Math.max(10, milli)) / 600) * 26;

/** How many walls the block's front has cleared, capped at `max`. */
const litBefore = (x: number, max: number) => Math.max(0, Math.min(max, Math.floor((x - GATE_X[0] + 14) / 30) + 1));
const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);

/** Position of the block at progress t (0..1) of one send. failIndex null = it passes every wall. */
export function runPos(failIndex: number | null, t: number): { x: number; bounced: boolean; lit: number } {
  if (failIndex === null || failIndex < 0) {
    const x = START_X + (END_X - START_X) * ease(t);
    return { x, bounced: false, lit: litBefore(x, GATE_X.length) };
  }
  const stop = GATE_X[failIndex] - 14;
  if (t < 0.55) {
    const x = START_X + (stop - START_X) * ease(t / 0.55);
    return { x, bounced: false, lit: litBefore(x, failIndex) };
  }
  const k = (t - 0.55) / 0.45;
  return { x: stop - (stop - START_X) * ease(k), bounced: true, lit: failIndex };
}

export type RuleSceneInput = {
  milli: number; stranger: boolean; approved: boolean; needsApproval: boolean;
  spentFrac: number; reservedFrac: number; // of the budget, 0..1
  run: { failIndex: number | null; t: number } | null;
};

export function ruleScene(i: RuleSceneInput): { prisms: Prism[]; lit: number; failIndex: number | null } {
  const prisms: Prism[] = [];
  const laneY = i.stranger ? 16 : -26;
  prisms.push(box("lane-a", -134, -40, -2, 280, 28, 2, "line"), box("lane-b", -134, 4, -2, 280, 28, 2, "line"));
  const pos = i.run ? runPos(i.run.failIndex, i.run.t) : { x: START_X, bounced: false, lit: 0 };
  const failIndex = i.run ? i.run.failIndex : null;
  const failing = i.run !== null && failIndex !== null && failIndex >= 0 && pos.bounced;
  GATE_X.forEach((x, g) => {
    const stopped = failing && failIndex === g;
    const passed = g < pos.lit;
    prisms.push(box(`g${g}`, x, -42, 0, 3, 76, stopped ? 40 : 34, stopped ? "reject" : passed ? "bright" : "matte"));
  });
  // approval = one extra lock bar across the last wall, open (raised) once approved
  if (i.needsApproval) {
    const last = GATE_X[GATE_X.length - 1];
    prisms.push(box("lock", last - 3, -42, i.approved ? 44 : 34, 9, 76, 4, i.approved ? "line" : "matte"));
  }
  const s = blockSide(i.milli);
  const rejected = failing;
  prisms.push(box("block", pos.x - s / 2, laneY - s / 2, 0, s, s, s * 0.7, rejected ? "reject" : "bright"));
  const spent = Math.min(1.5, Math.max(0, i.spentFrac)) * COLUMN_H;
  const res = Math.min(1.5, Math.max(0, i.reservedFrac)) * COLUMN_H;
  if (spent > 0.5) prisms.push(box("col-spent", END_X + 8, -20, 0, 30, 30, spent, "matte"));
  if (res > 0.5) prisms.push(box("col-res", END_X + 8, -20, spent, 30, 30, res, "bright"));
  prisms.push(box("plane", END_X + 2, -26, COLUMN_H, 42, 42, 1.5, "line"));
  return { prisms, lit: pos.lit, failIndex: failIndex ?? null };
}
