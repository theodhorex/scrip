// Tiny orthographic 3D for the landing's SVG scenes: prisms, visible faces, painter's order, pose blending.
// Pure functions, no DOM. World: x right, y away from the viewer, z up. Erasable TS only (node --test).

export type V3 = [number, number, number];
export type View = { yaw: number; pitch: number; scale: number };
export type Tone = "matte" | "reject" | "line" | "bright" | "floor" | "shadow";
export type Prism = { id: string; pts: [number, number][]; z: number; h: number; tone: Tone; opacity: number };
export type Face = { key: string; points: string; shade: 0 | 1 | 2; tone: Tone; opacity: number; depth: number };

const RAD = Math.PI / 180;

/** Orthographic projection after a yaw turn about z. Larger depth = farther from the viewer. */
export function project(p: V3, v: View): { x: number; y: number; d: number } {
  const c = Math.cos(v.yaw * RAD), s = Math.sin(v.yaw * RAD);
  const xr = p[0] * c - p[1] * s;
  const yr = p[0] * s + p[1] * c;
  const ph = v.pitch * RAD;
  return { x: xr * v.scale + 0, y: (-p[2] * Math.cos(ph) - yr * Math.sin(ph)) * v.scale + 0, d: yr };
}

export function box(id: string, x: number, y: number, z: number, w: number, d: number, h: number, tone: Tone = "matte"): Prism {
  return { id, pts: [[x, y], [x + w, y], [x + w, y + d], [x, y + d]], z, h, tone, opacity: 1 };
}

const area = (pts: [number, number][]) => pts.reduce((a, p, i) => { const q = pts[(i + 1) % pts.length]; return a + (p[0] * q[1] - q[0] * p[1]); }, 0) / 2;
const fmt = (n: number) => (Math.round(n * 10) / 10).toString();
const poly = (ps: { x: number; y: number }[]) => ps.map((p) => `${fmt(p.x)},${fmt(p.y)}`).join(" ");

/** Visible faces of one prism: its top and every side whose outward normal points at the viewer. */
export function facesOf(p: Prism, v: View): Face[] {
  const ccw = area(p.pts) > 0;
  const c = Math.cos(v.yaw * RAD), s = Math.sin(v.yaw * RAD);
  const out: Face[] = [];
  p.pts.forEach((a, i) => {
    const b = p.pts[(i + 1) % p.pts.length];
    const dx = b[0] - a[0], dy = b[1] - a[1];
    const n: [number, number] = ccw ? [dy, -dx] : [-dy, dx];
    const nxr = n[0] * c - n[1] * s;
    const nyr = n[0] * s + n[1] * c;
    if (nyr >= -1e-9) return; // faces away from (or edge-on to) the viewer
    const q = [[a[0], a[1], p.z], [b[0], b[1], p.z], [b[0], b[1], p.z + p.h], [a[0], a[1], p.z + p.h]].map((t) => project(t as V3, v));
    out.push({ key: `${p.id}:s${i}`, points: poly(q), shade: nxr < 0 ? 1 : 2, tone: p.tone, opacity: p.opacity, depth: q.reduce((m, t) => m + t.d, 0) / 4 });
  });
  out.sort((x, y) => y.depth - x.depth);
  const top = p.pts.map((t) => project([t[0], t[1], p.z + p.h], v));
  out.push({ key: `${p.id}:top`, points: poly(top), shade: 0, tone: p.tone, opacity: p.opacity, depth: top.reduce((m, t) => m + t.d, 0) / top.length });
  return out;
}

const centerDepth = (p: Prism, v: View) => {
  const cx = p.pts.reduce((m, t) => m + t[0], 0) / p.pts.length, cy = p.pts.reduce((m, t) => m + t[1], 0) / p.pts.length;
  return project([cx, cy, p.z + p.h / 2], v).d;
};

/** All faces, farther prisms first (painter's algorithm). Ties: lower prisms first. */
export function renderScene(prisms: Prism[], v: View): Face[] {
  return [...prisms]
    .sort((a, b) => centerDepth(b, v) - centerDepth(a, v) || a.z - b.z)
    .flatMap((p) => facesOf(p, v));
}

const mix = (a: number, b: number, t: number) => a + (b - a) * t;

/** Blend two poses by prism id. A prism missing on one side fades; the rest move. */
export function lerpScene(a: Prism[], b: Prism[], t: number): Prism[] {
  const out: Prism[] = [];
  const bm = new Map(b.map((p) => [p.id, p]));
  const am = new Map(a.map((p) => [p.id, p]));
  for (const p of a) {
    const q = bm.get(p.id);
    if (q && q.pts.length === p.pts.length) out.push({ ...q, pts: p.pts.map((pt, i) => [mix(pt[0], q.pts[i][0], t), mix(pt[1], q.pts[i][1], t)] as [number, number]), z: mix(p.z, q.z, t), h: mix(p.h, q.h, t), opacity: mix(p.opacity, q.opacity, t) });
    else if (t < 1) out.push({ ...p, opacity: p.opacity * (1 - t) });
  }
  for (const q of b) if (!am.has(q.id) && t > 0) out.push({ ...q, opacity: q.opacity * t });
  return out;
}

/** Side lengths proportional to the numbers (the largest gets `maxSide`). Used so box sizes carry data. */
export function nestDims(values: number[], maxSide: number): number[] {
  const m = Math.max(...values);
  return values.map((v) => (v / m) * maxSide);
}

/**
 * Extrude an upright outline (points are [x, up]) along y into `layers` thin slabs, far slab first,
 * then the front face. Layers read as stacked sheets; only side strips that face the viewer are returned.
 */
export function extrudeY(id: string, outline: [number, number][] | number[][], y0: number, depth: number, layers: number, v: View, tone: Tone = "matte", opacity = 1): Face[] {
  const pts = outline as [number, number][];
  const ccw = area(pts) > 0;
  const c = Math.cos(v.yaw * RAD), s = Math.sin(v.yaw * RAD), ph = v.pitch * RAD;
  const out: Face[] = [];
  const step = depth / layers;
  for (let l = layers - 1; l >= 0; l--) {
    const ya = y0 + l * step, yb = ya + step;
    pts.forEach((a, i) => {
      const b = pts[(i + 1) % pts.length];
      const dx = b[0] - a[0], dz = b[1] - a[1];
      const n: [number, number] = ccw ? [dz, -dx] : [-dz, dx]; // outward normal in the x-up plane
      const nyr = n[0] * s; // y' component after yaw
      if (nyr * -Math.cos(ph) + n[1] * Math.sin(ph) <= 1e-9) return;
      const q = [[a[0], ya, a[1]], [b[0], ya, b[1]], [b[0], yb, b[1]], [a[0], yb, a[1]]].map((t) => project(t as V3, v));
      out.push({ key: `${id}:l${l}:s${i}`, points: poly(q), shade: n[0] * c < 0 ? 1 : 2, tone, opacity, depth: q.reduce((m, t) => m + t.d, 0) / 4 });
    });
  }
  const front = pts.map((p) => project([p[0], y0, p[1]], v));
  out.push({ key: `${id}:front`, points: poly(front), shade: 0, tone, opacity, depth: front.reduce((m, t) => m + t.d, 0) / front.length });
  return out;
}
