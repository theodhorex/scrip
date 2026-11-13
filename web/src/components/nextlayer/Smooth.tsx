"use client";

import { useEffect } from "react";
import Lenis from "lenis";
import { anchorDuration } from "@/lib/journey";
import { motionOK } from "./scroll-bus";

const ease = (t: number) => (t < 0.5 ? 4 * t * t * t : 1 - Math.pow(-2 * t + 2, 3) / 2); // in-out: slow start and end, no rush through the door

/**
 * Inertial wheel scrolling for the landing (lenis is already a dependency of the old landing, nothing new).
 * Lenis only eases the real scroll position, so the door journey, the sticky ledger and every scroll-driven
 * figure keep reading window.scrollY and retrace exactly on reverse. Off under reduced motion; touch keeps native scrolling.
 * In-page links get a duration in proportion to their distance, so "How it works" glides through the door instead of snapping.
 */
export function Smooth() {
  useEffect(() => {
    if (!motionOK()) return;
    const lenis = new Lenis({ duration: 1.5, easing: (t) => 1 - Math.pow(1 - t, 3.4), wheelMultiplier: 0.8, syncTouch: false });
    let raf = 0;
    const tick = (time: number) => { lenis.raf(time); raf = requestAnimationFrame(tick); };
    raf = requestAnimationFrame(tick);
    const onClick = (e: MouseEvent) => {
      if (e.defaultPrevented || e.button !== 0 || e.metaKey || e.ctrlKey || e.shiftKey || e.altKey) return;
      const a = (e.target as Element).closest?.("a[href^='#']") as HTMLAnchorElement | null;
      const id = a?.getAttribute("href")?.slice(1);
      if (!a || !id || id.includes("?")) return;
      const el = id === "top" ? document.documentElement : document.getElementById(id);
      if (!el) return;
      e.preventDefault();
      const y = id === "top" ? 0 : el.getBoundingClientRect().top + window.scrollY - 72;
      lenis.scrollTo(y, { duration: anchorDuration(y - window.scrollY, window.innerHeight), easing: ease });
      history.replaceState(null, "", `#${id}`);
    };
    document.addEventListener("click", onClick);
    return () => { document.removeEventListener("click", onClick); cancelAnimationFrame(raf); lenis.destroy(); };
  }, []);
  return null;
}
