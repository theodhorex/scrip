// Isometric SVG primitives shared by every landing diorama.
// World axes: x runs right-down, y runs left-down, z runs up. Light comes from the top-left,
// so the top face is the lightest, the y-facing (left) face is mid, the x-facing (right) face is darkest.
import type { CSSProperties, ReactNode } from "react";

export const ISO_SCALE = 1;
const COS = Math.cos(Math.PI / 6);
const SIN = 0.5;

export type Pt = readonly [number, number, number];

/** World (x, y, z) to screen (sx, sy). One world unit is one pixel along an axis at scale 1. */
export function isoProject([x, y, z]: Pt, scale = ISO_SCALE): [number, number] {
  return [(x - y) * COS * scale, ((x + y) * SIN - z) * scale];
}

function pts(points: Pt[], scale: number): string {
  return points.map((p) => isoProject(p, scale).map((n) => n.toFixed(2)).join(",")).join(" ");
}

/** Tone helpers: a base colour gives three face colours via color-mix (supported in current browsers). */
export function tone(base: string) {
  return {
    top: `color-mix(in srgb, ${base} 78%, white)`,
    left: base,
    right: `color-mix(in srgb, ${base} 62%, black)`,
    edge: `color-mix(in srgb, ${base} 50%, white)`,
  };
}

type BoxProps = {
  x: number;
  y: number;
  z?: number;
  w: number;
  d: number;
  h: number;
  /** Base colour (CSS colour or var()). */
  color: string;
  scale?: number;
  /** Extra stroke colour for edges, default a light tint of the base. */
  edge?: string;
  /** Glow opacity 0..1 for emissive faces (screens, slots). */
  glow?: number;
  className?: string;
  style?: CSSProperties;
  children?: ReactNode;
};

export function IsoBox({ x, y, z = 0, w, d, h, color, scale = ISO_SCALE, edge, glow = 0, className, style, children }: BoxProps) {
  const t = tone(color);
  const top: Pt[] = [[x, y, z + h], [x + w, y, z + h], [x + w, y + d, z + h], [x, y + d, z + h]];
  const right: Pt[] = [[x + w, y, z], [x + w, y + d, z], [x + w, y + d, z + h], [x + w, y, z + h]];
  const left: Pt[] = [[x, y + d, z], [x + w, y + d, z], [x + w, y + d, z + h], [x, y + d, z + h]];
  const stroke = edge ?? t.edge;
  return (
    <g className={className} style={style}>
      <polygon points={pts(left, scale)} fill={t.left} stroke={stroke} strokeWidth={0.6} strokeLinejoin="round" />
      <polygon points={pts(right, scale)} fill={t.right} stroke={stroke} strokeWidth={0.6} strokeLinejoin="round" />
      <polygon points={pts(top, scale)} fill={t.top} stroke={stroke} strokeWidth={0.6} strokeLinejoin="round" />
      {glow > 0 && <polygon points={pts(top, scale)} fill="var(--bp-pass)" opacity={glow} />}
      {children}
    </g>
  );
}

type CylProps = {
  x: number;
  y: number;
  z?: number;
  r: number;
  h: number;
  color: string;
  scale?: number;
  className?: string;
};

/** Upright cylinder: side drawn as a gradient body between two ellipses. */
export function IsoCylinder({ x, y, z = 0, r, h, color, scale = ISO_SCALE, className }: CylProps) {
  const t = tone(color);
  const [cx, cyBottom] = isoProject([x, y, z], scale);
  const rx = r * COS * 2 * scale * 0.5 * 2; // horizontal radius on screen
  const ry = r * SIN * 2 * scale * 0.5 * 2 * 0.5 + r * 0.0; // vertical radius (compressed by the view)
  const topY = cyBottom - h * scale;
  const id = `cyl-${Math.round(cx)}-${Math.round(cyBottom)}-${Math.round(r)}`;
  return (
    <g className={className}>
      <defs>
        <linearGradient id={id} x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor={t.top} />
          <stop offset="0.45" stopColor={t.left} />
          <stop offset="1" stopColor={t.right} />
        </linearGradient>
      </defs>
      <path
        d={`M ${cx - rx} ${topY} L ${cx - rx} ${cyBottom} A ${rx} ${ry} 0 0 0 ${cx + rx} ${cyBottom} L ${cx + rx} ${topY} Z`}
        fill={`url(#${id})`}
        stroke={t.edge}
        strokeWidth={0.6}
      />
      <ellipse cx={cx} cy={topY} rx={rx} ry={ry} fill={t.top} stroke={t.edge} strokeWidth={0.6} />
    </g>
  );
}

/** Ground plate with a faint isometric grid. */
export function IsoGround({ w, d, color = "var(--bp-surface)", cell = 40, scale = ISO_SCALE }: { w: number; d: number; color?: string; cell?: number; scale?: number }) {
  const lines: ReactNode[] = [];
  for (let i = 0; i <= w; i += cell) {
    lines.push(<polyline key={`x${i}`} points={pts([[i, 0, 0], [i, d, 0]], scale)} stroke="var(--bp-line-strong)" strokeWidth={0.5} fill="none" opacity={0.55} />);
  }
  for (let j = 0; j <= d; j += cell) {
    lines.push(<polyline key={`y${j}`} points={pts([[0, j, 0], [w, j, 0]], scale)} stroke="var(--bp-line-strong)" strokeWidth={0.5} fill="none" opacity={0.55} />);
  }
  return (
    <g>
      <IsoBox x={0} y={0} z={-14} w={w} d={d} h={14} color={color} scale={scale} />
      {lines}
    </g>
  );
}

/** Projected polyline in world space, used for conveyors and cables. */
export function IsoLine({ points, scale = ISO_SCALE, ...rest }: { points: Pt[]; scale?: number } & Omit<React.SVGProps<SVGPolylineElement>, "points">) {
  return <polyline points={pts(points, scale)} fill="none" strokeLinejoin="round" strokeLinecap="round" {...rest} />;
}

/** Contact shadow under an object: a soft ellipse on the ground. */
export function IsoShadow({ x, y, w, d, scale = ISO_SCALE }: { x: number; y: number; w: number; d: number; scale?: number }) {
  const [cx, cy] = isoProject([x + w / 2, y + d / 2, 0], scale);
  return <ellipse cx={cx} cy={cy + 4} rx={(w + d) * 0.38 * scale} ry={(w + d) * 0.17 * scale} fill="#000" opacity={0.28} />;
}
