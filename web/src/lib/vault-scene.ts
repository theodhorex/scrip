// Pure geometry for the footer figure: a vault door at the end of the seven gates, the mandate key, and the budget as a column.
// Everything drawn is a fact from the worked example (same mandate as the ledger): budget 1.00, spent 0.20, deposited 1.50. Erasable TS only.
import type { Prism, V3 } from "./iso";
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { box } from "./iso.ts";
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { GATE_ORDER, MANDATE } from "./scenes.ts";
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { GATE_X, START_X } from "./rule-scene.ts";

/** One plain sentence per wall, in the contract's order (same order as GATE_ORDER and rules.ts). */
export const GATE_NOTES: readonly string[] = [
  "The mandate must be active, not revoked.",
  "The mandate must not have expired.",
  "The payee must be on the allowed list.",
  "The amount must be above zero and within the per-payment cap.",
  "No more than 32 requests can be open at once.",
  "Spent + reserved + this amount must stay within the budget.",
  "Above the approval threshold, the guardian must have approved this exact payment.",
];

export const DOOR_X = 134;
export const SEGMENTS = 10; // the budget, in tenths
export const SPENT_SEGMENTS = Math.round((0.2 / MANDATE.budget) * SEGMENTS); // worked example: 0.20 spent
export const SEG_H = 6;
export const COLUMN_TOP = SEGMENTS * SEG_H;

export type VaultInput = { blockX: number; open: number; active: number };
export type VaultLabel = { at: V3; text: string; tone?: "reject" | "bright"; anchor?: "start" | "middle" | "end"; dx?: number };

/** Ground pieces (floor, shadows, light pool) are always painted first, in this array order, never depth-sorted against objects. */
export const isGround = (id: string) => id === "floor" || id.startsWith("sh-") || id.startsWith("pool");

/** x the block parks at when a wall is selected: just in front of it. */
export const parkX = (gate: number) => GATE_X[gate] - 16;

export function vaultScene(i: VaultInput): { prisms: Prism[]; labels: VaultLabel[] } {
  const P: Prism[] = [];
  const open = Math.min(1, Math.max(0, i.open));
  // ground and soft shadows (stepped, flat: no gradients)
  P.push(box("floor", -150, -76, -3, 360, 138, 3, "floor"));
  P.push(sh("sh-door", DOOR_X - 2, -38, 52, 80, 0.35), sh("sh-door2", DOOR_X - 8, -40, 38, 84, 0.2));
  GATE_X.forEach((x: number, g: number) => P.push(sh(`sh-g${g}`, x - 5, -34, 8, 68, 0.28)));
  P.push(sh("sh-col", 156, -70, 34, 34, 0.3));
  // light pool in front of the door: three stepped plates, like the hero's light on the floor
  [[96, 0.16], [72, 0.1], [48, 0.06]].forEach(([x, o]: number[], k: number) => P.push({ ...box(`pool${k}`, x, -22, 0.2, DOOR_X - x, 44, 0.4, "bright"), opacity: o }));
  // seven walls, in order; the selected one lifts a little and turns bright
  GATE_X.forEach((x: number, g: number) => {
    const on = g === i.active;
    P.push(box(`g${g}`, x, -34, on ? 4 : 0, 3, 68, on ? 40 : 34, on ? "bright" : "matte"));
    P.push(box(`g${g}cap`, x - 1, -35, (on ? 4 : 0) + (on ? 40 : 34), 5, 70, 2, on ? "bright" : "line"));
  });
  // vault door: frame, light panel behind, portcullis leaf that rises with `open`
  P.push(box("jamb-l", DOOR_X, -38, 0, 8, 9, 74, "matte"), box("jamb-r", DOOR_X, 29, 0, 8, 9, 74, "matte"));
  P.push(box("lintel", DOOR_X, -38, 66, 8, 76, 10, "matte"), box("lintel-cap", DOOR_X + 1, -37, 76, 6, 74, 2, "line"));
  P.push(box("light", DOOR_X + 3, -29, 0, 2, 58, 66, "bright"));
  P.push(box("leaf", DOOR_X - 4, -29, open * 60, 3, 58, 62, "matte"), box("leaf-bar", DOOR_X - 5, -29, open * 60 + 28, 1, 58, 3, "line"));
  // the mandate key: plinth with a bevelled cap, one tooth
  P.push(box("plinth", -142, -68, 0, 46, 26, 5, "matte"), box("plinth-cap", -140, -66, 5, 42, 22, 1.5, "line"));
  P.push(box("key-bow", -137, -61, 6.5, 11, 12, 3, "matte"), box("key-shaft", -126, -57, 6.5, 28, 4, 3, "matte"), box("key-tooth", -104, -57, 9.5, 4, 4, 4, "bright"));
  // the budget as a column of tenths: spent ones solid, free ones outlined, the plane on top is the budget
  for (let s = 0; s < SEGMENTS; s++) P.push(box(`seg${s}`, 158, -68, s * SEG_H, 30, 30, SEG_H - 1, s < SPENT_SEGMENTS ? "matte" : "line"));
  P.push(box("plane", 154, -72, COLUMN_TOP, 38, 38, 1.5, "bright"));
  // the payment block on its way (a request, not real money)
  P.push(box("block", i.blockX - 7, -8, 0, 14, 14, 10, "bright"));
  const labels: VaultLabel[] = [
    { at: [-142, -70, 30], text: "mandate key: one tooth", anchor: "start" },
    { at: [194, -72, COLUMN_TOP], text: "budget 1.00", tone: "bright", anchor: "start", dx: 6 },
    { at: [194, -72, SPENT_SEGMENTS * SEG_H], text: "spent 0.20", anchor: "start", dx: 6 },
  ];
  return { prisms: P, labels };
}

/** Number of walls the block's front has cleared. */
export function gatesPassed(x: number): number {
  return Math.max(0, Math.min(GATE_X.length, Math.floor((x - GATE_X[0] + 8) / 30) + 1));
}

function sh(id: string, x: number, y: number, w: number, d: number, o: number): Prism {
  return { ...box(id, x, y, 0.1, w, d, 0.1, "shadow"), opacity: o };
}

export { START_X, GATE_ORDER };
