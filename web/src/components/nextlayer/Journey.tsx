"use client";

import { useEffect } from "react";
import { journey, progressOf } from "@/lib/journey";
import { motionOK, onScroll, onTick } from "./scroll-bus";

const SMOOTH_MS = 120; // time constant of the camera: it glides to the scroll position instead of stepping with it

/**
 * Drives "walking through the door". Scroll position -> target p; the camera follows p with a critically damped glide
 * (so wheel notches and trackpad bursts never show as steps), and every frame writes transform/opacity straight onto
 * the few elements involved. No CSS variables on a shared parent, so nothing else is restyled while you scroll.
 * Only active on landscape screens with motion allowed. Also: a small pointer parallax on the hero layers (<= 10 design units).
 */
export function Journey() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>("[data-nl-journey]");
    if (!root || !motionOK() || !matchMedia("(min-aspect-ratio: 11/10)").matches) return;
    const q = <T extends HTMLElement>(s: string) => Array.from(root.querySelectorAll<T>(s));
    const media = q(".nl-plate-video, .nl-plate-still"), plate = q(".nl-plate"), hero = q(".nl-hero"), logos = q(".nl-logos"),
      top = q(".nl-topbar"), flood = q(".nl-flood"), text = q(".nl-flood-text"), fade = q(".nl-hint, .nl-door");
    const all = [...media, ...plate, ...hero, ...logos, ...top, ...flood, ...text, ...fade];

    let target = 0, shown = -1, vh = innerHeight, stopTick: (() => void) | null = null;

    const paint = (p: number) => {
      const j = journey(p), u = vh / 1058;
      const tf = `translateX(calc(-50% - ${0.5 * u}px)) translateY(${(j.ty * u).toFixed(2)}px) scale(${j.scale.toFixed(4)})`;
      media.forEach((e) => { e.style.transform = tf; });
      plate.forEach((e) => { e.style.opacity = j.plate.toFixed(4); });
      hero.forEach((e) => { e.style.opacity = j.copy.toFixed(4); e.style.translate = `0 ${((1 - j.copy) * -28 * u).toFixed(2)}px`; });
      logos.forEach((e) => { e.style.opacity = j.copy.toFixed(4); });
      top.forEach((e) => { e.style.opacity = j.nav.toFixed(4); });
      flood.forEach((e) => { e.style.opacity = j.white.toFixed(4); });
      text.forEach((e) => { e.style.opacity = j.text.toFixed(4); e.style.translate = `0 ${((1 - j.text) * 24 * u).toFixed(2)}px`; });
      fade.forEach((e) => { e.style.opacity = j.hint.toFixed(4); });
      root.dataset.p0 = p < 0.04 ? "1" : "";
    };

    const step = (dt: number) => {
      const k = 1 - Math.exp(-dt / SMOOTH_MS);
      shown = shown < 0 ? target : shown + (target - shown) * k;
      if (Math.abs(target - shown) < 0.0002) { shown = target; paint(shown); stopTick?.(); stopTick = null; return; }
      paint(shown);
    };
    const off = onScroll((y, h) => {
      vh = h;
      target = progressOf(y - root.offsetTop, h);
      if (shown < 0) { shown = target; paint(shown); }
      else if (!stopTick && Math.abs(target - shown) >= 0.0002) stopTick = onTick(step);
    });

    const fine = matchMedia("(pointer: fine)").matches;
    const set = (k: string, v: number) => root.style.setProperty(k, v.toFixed(4));
    const move = (e: PointerEvent) => { set("--px", (e.clientX / innerWidth - 0.5) * 2); set("--py", (e.clientY / innerHeight - 0.5) * 2); };
    const leave = () => { set("--px", 0); set("--py", 0); };
    if (fine) { root.addEventListener("pointermove", move, { passive: true }); root.addEventListener("pointerleave", leave); }
    return () => {
      off(); stopTick?.();
      root.removeEventListener("pointermove", move); root.removeEventListener("pointerleave", leave);
      all.forEach((e) => { e.style.transform = ""; e.style.opacity = ""; e.style.translate = ""; });
    };
  }, []);
  return null;
}
