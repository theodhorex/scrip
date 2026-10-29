"use client";

// Eased cursor parallax: tilts/shifts one element toward the pointer using a
// single rAF loop that sleeps once the motion has settled. Fine pointers only,
// off for reduced motion, and paused while `active` is false.
import { useEffect, useRef } from "react";

type Options = {
  /** Max translation in px at the viewport edge. */
  shift?: number;
  /** Max tilt in degrees at the viewport edge. */
  tilt?: number;
};

export function useCursorParallax<T extends HTMLElement>(active: boolean, { shift = 14, tilt = 2.2 }: Options = {}) {
  const ref = useRef<T>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || !active) return;
    if (!window.matchMedia("(pointer: fine)").matches) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    let tx = 0;
    let ty = 0;
    let cx = 0;
    let cy = 0;
    let raf = 0;

    const frame = () => {
      cx += (tx - cx) * 0.075;
      cy += (ty - cy) * 0.075;
      el.style.transform = `perspective(1600px) translate3d(${(cx * shift).toFixed(2)}px, ${(cy * shift * 0.7).toFixed(2)}px, 0) rotateX(${(-cy * tilt).toFixed(3)}deg) rotateY(${(cx * tilt).toFixed(3)}deg)`;
      if (Math.abs(tx - cx) > 0.001 || Math.abs(ty - cy) > 0.001) {
        raf = requestAnimationFrame(frame);
      } else {
        raf = 0;
      }
    };
    const kick = () => {
      if (!raf) raf = requestAnimationFrame(frame);
    };
    const onMove = (e: PointerEvent) => {
      tx = (e.clientX / window.innerWidth) * 2 - 1;
      ty = (e.clientY / window.innerHeight) * 2 - 1;
      kick();
    };
    const onLeave = () => {
      tx = 0;
      ty = 0;
      kick();
    };

    window.addEventListener("pointermove", onMove, { passive: true });
    document.documentElement.addEventListener("pointerleave", onLeave);
    return () => {
      window.removeEventListener("pointermove", onMove);
      document.documentElement.removeEventListener("pointerleave", onLeave);
      if (raf) cancelAnimationFrame(raf);
      el.style.transform = "";
    };
  }, [active, shift, tilt]);

  return ref;
}
