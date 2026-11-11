// The scroll journey "through the door": one pure function from progress p (0..1) to everything that moves.
// No DOM, no time: scrolling backwards retraces it exactly. Erasable TS only (node --test).

/** Height of the pinned runway in viewport heights. The scroll distance is RUNWAY_VH - 1 viewport heights. */
export const RUNWAY_VH = 4.8;
/** Zoom factor reached when the camera is inside the door. The light door is about 215 design units wide of 1487. */
export const MAX_SCALE = 9;
/** Upward shift (design units) that carries the door from its place to the middle of the frame. */
export const SHIFT_UP = 58;

const clamp = (v: number, a = 0, b = 1) => Math.min(b, Math.max(a, v));
const smooth = (a: number, b: number, p: number) => { const t = clamp((p - a) / (b - a)); return t * t * (3 - 2 * t); };

export type Journey = {
  scale: number; ty: number;
  copy: number; plate: number; nav: number; hint: number;
  white: number; text: number;
};

export function journey(pRaw: number): Journey {
  const p = clamp(pRaw);
  const k = smooth(0.02, 0.8, p);
  const flood = smooth(0.58, 0.78, p);
  const black = smooth(0.88, 1, p);
  return {
    scale: Math.pow(MAX_SCALE, k),
    ty: 0 - SHIFT_UP * k + 0,
    copy: 1 - smooth(0.0, 0.16, p),
    nav: 1 - smooth(0.4, 0.62, p),
    hint: 1 - smooth(0, 0.05, p),
    plate: 1 - smooth(0.84, 0.94, p),
    white: flood * (1 - black),
    text: smooth(0.76, 0.86, p) * (1 - smooth(0.96, 1, p)),
  };
}

/** Progress of the pinned runway from the scroll position. */
export function progressOf(scrollY: number, vh: number): number {
  return clamp(scrollY / ((RUNWAY_VH - 1) * vh));
}

/** Seconds a link jump takes. Long jumps (through the door) get time in proportion to the distance, so the zoom never rushes. */
export function anchorDuration(distancePx: number, vh: number): number {
  const screens = Math.abs(distancePx) / Math.max(1, vh);
  return Math.min(7, Math.max(1.2, 1.2 + screens * 0.8));
}
