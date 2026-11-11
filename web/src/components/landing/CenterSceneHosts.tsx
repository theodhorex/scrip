"use client";

import { useEffect } from "react";

const PHONE = "(max-width: 639px)";

/**
 * On phones each diorama is wider than the viewport and scrolls sideways.
 * Start every .bp-scene-host centred on the scene instead of its left edge.
 * A host is centred once, and never again after the visitor has scrolled it.
 */
export function CenterSceneHosts() {
  useEffect(() => {
    const mq = window.matchMedia(PHONE);
    const touched = new WeakSet<Element>();
    const centred = new WeakSet<Element>();
    const cleanups: Array<() => void> = [];

    const centre = () => {
      if (!mq.matches) return;
      document.querySelectorAll<HTMLElement>(".bp-scene-host").forEach((el) => {
        if (touched.has(el) || centred.has(el)) return;
        if (el.scrollWidth <= el.clientWidth) return;
        el.scrollLeft = (el.scrollWidth - el.clientWidth) / 2;
        centred.add(el);
      });
    };

    document.querySelectorAll<HTMLElement>(".bp-scene-host").forEach((el) => {
      const mark = () => touched.add(el);
      el.addEventListener("pointerdown", mark, { passive: true });
      el.addEventListener("wheel", mark, { passive: true });
      cleanups.push(() => {
        el.removeEventListener("pointerdown", mark);
        el.removeEventListener("wheel", mark);
      });
    });

    centre();
    const raf = requestAnimationFrame(centre);
    mq.addEventListener("change", centre);
    window.addEventListener("load", centre);
    return () => {
      cancelAnimationFrame(raf);
      mq.removeEventListener("change", centre);
      window.removeEventListener("load", centre);
      cleanups.forEach((f) => f());
    };
  }, []);

  return null;
}
