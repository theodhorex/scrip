import type { Face } from "@/lib/iso";
import "./iso.css";

export type IsoLine = { a: [number, number]; b: [number, number]; tone?: "reject" | "bright" | "faint"; dash?: boolean };
export type IsoLabel = { x: number; y: number; text: string; tone?: "reject" | "bright"; anchor?: "start" | "middle" | "end" };

/** Draws projected faces. Always decorative: aria-hidden. The information lives in the text next to it. */
export function IsoSvg({ faces, lines = [], labels = [], viewBox, className }: { faces: Face[]; lines?: IsoLine[]; labels?: IsoLabel[]; viewBox: string; className?: string }) {
  return (
    <svg className={`iso ${className ?? ""}`} viewBox={viewBox} aria-hidden="true" focusable="false">
      {lines.map((l, i) => <line key={i} className="iso-l" data-tone={l.tone} data-dash={l.dash ? "1" : undefined} x1={l.a[0]} y1={l.a[1]} x2={l.b[0]} y2={l.b[1]} />)}
      {faces.map((f) => <polygon key={f.key} className="iso-f" data-shade={f.shade} data-tone={f.tone} points={f.points} opacity={f.opacity < 1 ? f.opacity : undefined} />)}
      {labels.map((t, i) => <text key={i} className="iso-t" data-tone={t.tone} x={t.x} y={t.y} textAnchor={t.anchor ?? "start"}>{t.text}</text>)}
    </svg>
  );
}
