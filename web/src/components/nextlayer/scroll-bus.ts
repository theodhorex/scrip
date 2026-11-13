// One shared requestAnimationFrame scroll loop for the whole page. Subscribers get called at most once per frame.
type Sub = (y: number, vh: number) => void;
const subs = new Set<Sub>();
let ticking = false;
let bound = false;

function frame() {
  ticking = false;
  const y = window.scrollY;
  const vh = window.innerHeight;
  subs.forEach((fn) => fn(y, vh));
}
function request() {
  if (!ticking) {
    ticking = true;
    requestAnimationFrame(frame);
  }
}
export function onScroll(fn: Sub): () => void {
  subs.add(fn);
  if (!bound) {
    bound = true;
    window.addEventListener("scroll", request, { passive: true });
    window.addEventListener("resize", request, { passive: true });
  }
  request();
  return () => {
    subs.delete(fn);
    if (subs.size === 0 && bound) {
      bound = false;
      window.removeEventListener("scroll", request);
      window.removeEventListener("resize", request);
    }
  };
}
export const motionOK = () => !matchMedia("(prefers-reduced-motion: reduce)").matches;
export const EASE_OUT = (t: number) => 1 - Math.pow(1 - t, 4);

// One shared animation ticker for 3D scenes. Runs only while somebody is subscribed (scenes subscribe while visible).
type Tick = (dt: number, now: number) => void;
const ticks = new Set<Tick>();
let tickRaf = 0;
let lastT = 0;
function loop(t: number) {
  const dt = Math.min(64, t - (lastT || t));
  lastT = t;
  ticks.forEach((fn) => fn(dt, t));
  tickRaf = ticks.size ? requestAnimationFrame(loop) : 0;
  if (!ticks.size) lastT = 0;
}
export function onTick(fn: Tick): () => void {
  ticks.add(fn);
  if (!tickRaf) tickRaf = requestAnimationFrame(loop);
  return () => { ticks.delete(fn); };
}
