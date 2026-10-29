"use client";

// Page-level motion layer for the landing page: inertial scroll (Lenis) and
// staggered scroll reveals. Reveals use data attributes + the `translate`
// property so React-managed class names and transforms are never touched.
import { useEffect } from "react";
import Lenis from "lenis";

const REVEAL_SELECTOR = [
  ".bp-chapter-label",
  ".bp-hero-title",
  ".bp-section-title",
  ".bp-prose",
  ".bp-scene-host",
  ".bp-plate",
  "[data-reveal-item]",
].join(",");

export function SmoothScroll() {
  useEffect(() => {
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

    let lenis: Lenis | null = null;
    let raf = 0;
    if (!reduced) {
      lenis = new Lenis({
        duration: 1.15,
        easing: (t) => 1 - Math.pow(1 - t, 3.4),
        anchors: { offset: -64 },
        syncTouch: false,
      });
      const tick = (time: number) => {
        lenis?.raf(time);
        raf = requestAnimationFrame(tick);
      };
      raf = requestAnimationFrame(tick);
    }

    const targets = Array.from(
      document.querySelectorAll<HTMLElement>(REVEAL_SELECTOR),
    ).filter((el) => !el.hasAttribute("data-reveal"));

    let io: IntersectionObserver | null = null;
    if (!reduced && "IntersectionObserver" in window) {
      // Stagger siblings that enter together, per section.
      const perSection = new Map<Element, number>();
      io = new IntersectionObserver(
        (entries) => {
          for (const entry of entries) {
            if (!entry.isIntersecting) continue;
            const el = entry.target as HTMLElement;
            const section = el.closest("section") ?? document.body;
            const n = perSection.get(section) ?? 0;
            perSection.set(section, n + 1);
            window.setTimeout(() => perSection.set(section, Math.max(0, (perSection.get(section) ?? 1) - 1)), 500);
            el.style.setProperty("--bp-reveal-delay", `${Math.min(n, 4) * 90}ms`);
            el.setAttribute("data-reveal", "in");
            io?.unobserve(el);
          }
        },
        { threshold: 0.12, rootMargin: "0px 0px -6% 0px" },
      );
      for (const el of targets) {
        el.setAttribute("data-reveal", "armed");
        io.observe(el);
      }
    }

    return () => {
      cancelAnimationFrame(raf);
      lenis?.destroy();
      io?.disconnect();
      for (const el of targets) el.removeAttribute("data-reveal");
    };
  }, []);

  return null;
}
