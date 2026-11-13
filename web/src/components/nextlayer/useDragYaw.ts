"use client";
import { useRef, useState, type PointerEvent } from "react";

/** Drag horizontally to turn a decorative 3D figure. Clamped, so it never shows the back. Touch keeps vertical scroll (touch-action: pan-y in CSS). */
export function useDragYaw(rest: number, range = 32) {
  const [yaw, setYaw] = useState(rest);
  const drag = useRef<{ x: number; yaw: number } | null>(null);
  const clamp = (v: number) => Math.max(rest - range, Math.min(rest + range, v));
  return {
    yaw,
    reset: () => setYaw(rest),
    bind: {
      onPointerDown: (e: PointerEvent<HTMLElement>) => { drag.current = { x: e.clientX, yaw }; e.currentTarget.setPointerCapture(e.pointerId); },
      onPointerMove: (e: PointerEvent<HTMLElement>) => { if (drag.current) setYaw(clamp(drag.current.yaw + (e.clientX - drag.current.x) * 0.25)); },
      onPointerUp: () => { drag.current = null; },
      onPointerCancel: () => { drag.current = null; },
      onDoubleClick: () => setYaw(rest),
    },
  };
}
