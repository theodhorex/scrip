"use client";

import { useEffect, useRef } from "react";
import { EASE_OUT, motionOK } from "./scroll-bus";

/** A number that eases to its new value (text only, no layout change). Reduced motion: jumps. */
export function TweenNum({ value, digits = 2, ms = 650 }: { value: number; digits?: number; ms?: number }) {
  const ref = useRef<HTMLSpanElement>(null);
  const cur = useRef(value);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const from = cur.current;
    if (!motionOK() || from === value) {
      cur.current = value;
      el.textContent = value.toFixed(digits);
      return;
    }
    let raf = 0;
    const t0 = performance.now();
    const step = (t: number) => {
      const k = Math.min(1, (t - t0) / ms);
      cur.current = from + (value - from) * EASE_OUT(k);
      el.textContent = cur.current.toFixed(digits);
      if (k < 1) raf = requestAnimationFrame(step);
    };
    raf = requestAnimationFrame(step);
    return () => cancelAnimationFrame(raf);
  }, [value, digits, ms]);
  return <span ref={ref} className="nl-tabular">{value.toFixed(digits)}</span>;
}
