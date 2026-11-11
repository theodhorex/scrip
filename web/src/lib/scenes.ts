// Pure scene definitions for the landing's isometric figures. Numbers come from the worked example
// (the same mandate as the ledger and the rule machine). Erasable TS only (node --test).
import type { Prism, V3 } from "./iso";
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { box, nestDims } from "./iso.ts";

export const MANDATE = { deposited: 1.5, budget: 1.0, cap: 0.4, threshold: 0.25 } as const;

/** The order the contract checks a payment. The 3D gates are drawn in exactly this order (tested against rules.ts). */
export const GATE_ORDER = [
  { code: "NOT_ACTIVE", label: "active" },
  { code: "EXPIRED", label: "expiry" },
  { code: "RECIPIENT_NOT_ALLOWED", label: "recipient" },
  { code: "OVER_PER_PAYMENT_CAP", label: "cap" },
  { code: "TOO_MANY_OPEN", label: "open <= 32" },
  { code: "OVER_BUDGET", label: "budget" },
  { code: "NEEDS_APPROVAL", label: "approval" },
] as const;

export type SceneLabel = { at: V3; text: string; tone?: "reject" | "bright"; anchor?: "start" | "middle" | "end" };
export type SceneLine = { a: V3; b: V3; tone?: "reject" | "bright" | "faint"; dash?: boolean };
export type Scene = { prisms: Prism[]; labels: SceneLabel[]; lines: SceneLine[] };

const SIDE = 120; // world units of the largest nested box

/** Step 1: nested boxes whose side lengths are the four numbers of the mandate, threshold <= cap <= budget <= deposit. */
export function nestedMandate(): { prisms: Prism[]; sides: number[] } {
  const sides = nestDims([MANDATE.threshold, MANDATE.cap, MANDATE.budget, MANDATE.deposited], SIDE);
  const tones = ["matte", "line", "line", "line"] as const;
  const names = ["threshold", "cap", "budget", "deposit"];
  const prisms = sides.map((s, i) => box(`n-${names[i]}`, -s / 2, -s / 2, 0, s, s, s, tones[i]));
  return { prisms, sides };
}

/** Where payment blocks sit on the lane at a point of the loop (phase 0..1). Pure so it can be tested. */
export function payments(phase: number): { ok: { x: number; z: number; landed: boolean }; bad: { x: number; bounced: boolean } } {
  const ease = (t: number) => 1 - Math.pow(1 - Math.min(1, Math.max(0, t)), 3);
  const okT = phase / 0.45;
  const ok = okT < 1 ? { x: -90 + 110 * ease(okT) , z: 0, landed: false } : { x: 20 + 50 * ease((phase - 0.45) / 0.15), z: 0, landed: phase > 0.6 };
  const badIn = (phase - 0.5) / 0.2;
  const badOut = (phase - 0.7) / 0.25;
  const bad = phase < 0.5 ? { x: -90, bounced: false } : phase < 0.7 ? { x: -90 + 76 * ease(badIn), bounced: false } : { x: -14 - 76 * ease(badOut), bounced: true };
  return { ok, bad };
}

export function howScene(step: number, phase: number): Scene {
  const base: Prism[] = [];
  const labels: SceneLabel[] = [];
  const lines: SceneLine[] = [];
  const lane = box("lane", -100, -30, -2, 200, 60, 2, "line");
  if (step === 0) {
    const { prisms, sides } = nestedMandate();
    base.push(...prisms);
    const names = [`approval above ${MANDATE.threshold.toFixed(2)}`, `cap ${MANDATE.cap.toFixed(2)}`, `budget ${MANDATE.budget.toFixed(2)}`, `deposited ${MANDATE.deposited.toFixed(2)}`];
    sides.forEach((s, i) => labels.push(i === 0 ? { at: [-s / 2 - 6, -s / 2, s], text: names[i], anchor: "end" as const } : { at: [s / 2 + 6, -s / 2, s - (i === 1 ? 0 : 0)], text: names[i], tone: i === 2 ? "bright" as const : undefined }));
  } else if (step === 1) {
    base.push(box("key-bow", -90, -9, 10, 26, 6, 26, "matte"), box("key-shaft", -64, -9, 19, 110, 6, 8, "matte"));
    const teeth = [-30, -6, 18, 42];
    teeth.forEach((x, i) => base.push(box(`key-t${i}`, x, -9, 5, 10, 6, 14, i === 2 ? "bright" : "line")));
    base.push(box("relayer", -90, 40, 0, 24, 24, 24, "matte"));
    lines.push({ a: [-78, 52, 24], b: [-77, -6, 36], dash: true });
    labels.push({ at: [8, -9, 38], text: "request_payment: the only tooth", tone: "bright" }, { at: [-40, -9, -18], text: "all other methods: locked" }, { at: [-60, 56, 12], text: "relayer pays gas (NEP-366)" });
  } else if (step === 2) {
    base.push(lane, box("gate", 18, -30, 0, 3, 60, 96, "bright"));
    const { ok, bad } = payments(phase);
    base.push(box("pay-ok", ok.x, -12, 0, 22, 22, 14, ok.x > 20 ? "matte" : "bright"));
    base.push(box("pay-bad", bad.x, 6, 0, 30, 22, 22, "reject"));
    base.push(box("spent", 56, -12, 0, 26, 24, 14, "matte"));
    if (ok.landed) base.push(box("spent2", 56, -12, 14, 26, 24, 12, "matte"));
    labels.push({ at: [18, -30, 100], text: "gate: 7 checks in order", tone: "bright", anchor: "middle" }, { at: [56, -12, 40], text: "spent" });
    if (bad.x > -60 && phase > 0.55) labels.push({ at: [-40, 30, 8], text: "OVER_PER_PAYMENT_CAP", tone: "reject" });
  } else {
    base.push(lane, box("gate", 18, -30, 0, 3, 60, 14, "bright"), box("spent", 56, -12, 0, 26, 24, 14, "matte"), box("spent2", 56, -12, 14, 26, 24, 12, "matte"));
    base.push(box("budget-plate", -30, -22, 34, 44, 44, 4, "line"));
    base.push(box("free", -92, -12, 0, 30, 24, 16, "bright"));
    base.push(box("owner", -100, 18, -2, 36, 40, 2, "line"));
    labels.push({ at: [-30, -22, 44], text: "budget plate lifted" }, { at: [-96, 14, 22], text: "free goes back to the owner", tone: "bright" }, { at: [18, -30, 22], text: "gate closed" });
  }
  return { prisms: base, labels, lines };
}
