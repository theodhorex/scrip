"use client";

import { useEffect } from "react";
import { EASE_OUT, motionOK, onScroll } from "./scroll-bus";

/**
 * Page-level motion, mounted once. Everything is opt-in through data attributes:
 *   [data-reveal]  rise | clip | line | wave | title   (CSS does the work, this only adds .is-in)
 *   [data-count]   count-up of a small integer when first seen
 *   .nl-pill       magnetic pull, at most 6px
 * Under prefers-reduced-motion nothing is hidden and nothing moves: the end state is the page.
 */
export function Motion() {
  useEffect(() => {
    const root = document.querySelector<HTMLElement>(".nl");
    if (!root || !motionOK()) return;
    root.classList.add("nl-anim");

    const io = new IntersectionObserver(
      (entries) => {
        for (const e of entries) {
          if (!e.isIntersecting) continue;
          const el = e.target as HTMLElement;
          el.classList.add("is-in");
          io.unobserve(el);
          const c = el.closest<HTMLElement>(".nl-idx")?.querySelector<HTMLElement>("[data-count]");
          if (c && !c.dataset.done) countUp(c);
        }
      },
      { rootMargin: "0px 0px -12% 0px", threshold: 0.01 },
    );
    root.querySelectorAll("[data-reveal]").forEach((el) => io.observe(el));
    // idx counters sit above their title; start them when the idx row itself is seen
    const io2 = new IntersectionObserver((entries) => {
      for (const e of entries) if (e.isIntersecting) { const c = e.target.querySelector<HTMLElement>("[data-count]"); if (c && !c.dataset.done) countUp(c); io2.unobserve(e.target); }
    });
    root.querySelectorAll(".nl-idx").forEach((el) => io2.observe(el));

    // magnetic pills (<= 6px), pointer devices only
    const fine = matchMedia("(pointer: fine)").matches;
    const move = (ev: PointerEvent) => {
      const pill = (ev.target as Element).closest<HTMLElement>(".nl-pill");
      if (!pill) return;
      const b = pill.getBoundingClientRect();
      const dx = ((ev.clientX - (b.left + b.width / 2)) / b.width) * 12;
      const dy = ((ev.clientY - (b.top + b.height / 2)) / b.height) * 12;
      pill.style.translate = `${Math.max(-6, Math.min(6, dx))}px ${Math.max(-6, Math.min(6, dy))}px`;
    };
    const leave = (ev: PointerEvent) => {
      const pill = (ev.target as Element).closest?.(".nl-pill") as HTMLElement | null;
      if (pill) pill.style.translate = "";
    };
    if (fine) {
      root.addEventListener("pointermove", move);
      root.addEventListener("pointerout", leave);
    }

    // hero video: slow push (<= 6%) and fade into the page background while the hero leaves
    const stage = root.querySelector<HTMLElement>("[data-nl-stage]");
    const off = onScroll((y, vh) => {
      if (!stage) return;
      const p = Math.min(1, Math.max(0, y / vh));
      stage.style.setProperty("--vp", p.toFixed(4));
    });

    // "rooms passed through": each section head grows into place as it arrives (scale 0.93 -> 1) and keeps
    // drifting up past the viewer as it leaves (1 -> 1.04). `scale` is its own property, so reveals are untouched.
    const heads = Array.from(root.querySelectorAll<HTMLElement>(".nl-head"));
    const dolly = onScroll((_y, vh) => {
      for (const h of heads) {
        const r = h.getBoundingClientRect();
        if (r.bottom < -vh * 0.5 || r.top > vh * 1.2) continue;
        const enter = Math.min(1, Math.max(0, (vh * 1.0 - r.top) / (vh * 0.55)));
        const leave = Math.min(1, Math.max(0, (vh * 0.1 - r.bottom) / (vh * 0.5)));
        h.style.scale = String(0.93 + 0.07 * EASE_OUT(enter) + 0.04 * leave);
        h.style.transformOrigin = "0 100%";
      }
    });

    return () => {
      dolly();
      for (const h of heads) { h.style.scale = ""; h.style.transformOrigin = ""; }
      io.disconnect();
      io2.disconnect();
      off();
      root.classList.remove("nl-anim");
      root.removeEventListener("pointermove", move);
      root.removeEventListener("pointerout", leave);
    };
  }, []);
  return null;
}

function countUp(el: HTMLElement) {
  el.dataset.done = "1";
  const to = Number(el.dataset.count);
  const pad = Number(el.dataset.pad ?? 0);
  const t0 = performance.now();
  const step = (t: number) => {
    const k = Math.min(1, (t - t0) / 700);
    el.textContent = String(Math.round(to * EASE_OUT(k))).padStart(pad, "0");
    if (k < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}
