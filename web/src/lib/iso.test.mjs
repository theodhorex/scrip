import test from "node:test";
import assert from "node:assert/strict";
import { project, box, facesOf, renderScene, lerpScene, nestDims } from "./iso.ts";

const V0 = { yaw: 0, pitch: 35, scale: 1 };

test("project: z moves up the screen, farther y moves up too, x moves right", () => {
  const o = project([0, 0, 0], V0);
  assert.deepEqual([o.x, o.y], [0, 0]);
  assert.ok(project([0, 0, 10], V0).y < 0);
  assert.ok(project([0, 10, 0], V0).y < 0);
  assert.ok(project([10, 0, 0], V0).x > 0);
});

test("a box seen straight on shows its top and its front face only", () => {
  const f = facesOf(box("b", 0, 0, 0, 10, 10, 10), V0);
  assert.equal(f.length, 2);
});

test("a box turned 30 degrees shows top plus two sides, with different shades", () => {
  const f = facesOf(box("b", 0, 0, 0, 10, 10, 10), { ...V0, yaw: 30 });
  assert.equal(f.length, 3);
  const sides = f.filter((x) => !x.key.endsWith(":top"));
  assert.notEqual(sides[0].shade, sides[1].shade);
});

test("scene draws far boxes before near ones", () => {
  const near = box("near", 0, 0, 0, 5, 5, 5);
  const far = box("far", 0, 50, 0, 5, 5, 5);
  const keys = renderScene([near, far], V0).map((f) => f.key.split(":")[0]);
  assert.ok(keys.indexOf("far") < keys.indexOf("near"));
});

test("nestDims keeps side lengths proportional to the numbers", () => {
  const d = nestDims([0.25, 0.4, 1, 1.5], 150);
  assert.deepEqual(d.map((x) => Math.round(x * 100) / 100), [25, 40, 100, 150]);
  assert.ok(d.every((x, i) => i === 0 || x > d[i - 1]));
});

test("lerpScene blends matching ids and fades ids that appear or vanish", () => {
  const a = [box("k", 0, 0, 0, 10, 10, 10), box("gone", 0, 0, 0, 1, 1, 1)];
  const b = [box("k", 20, 0, 0, 10, 10, 10), box("new", 0, 0, 0, 1, 1, 1)];
  const m = lerpScene(a, b, 0.5);
  const k = m.find((p) => p.id === "k");
  assert.equal(k.pts[0][0], 10);
  assert.equal(m.find((p) => p.id === "gone").opacity, 0.5);
  assert.equal(m.find((p) => p.id === "new").opacity, 0.5);
  assert.equal(lerpScene(a, b, 1).find((p) => p.id === "gone"), undefined);
});

import { extrudeY } from "./iso.ts";

test("extrudeY: an upright outline shows its front face; turning it reveals side strips", () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const flat = extrudeY("m", sq, 0, 6, 1, V0);
  assert.ok(flat.some((f) => f.key === "m:front"));
  const turned = extrudeY("m", sq, 0, 6, 1, { ...V0, yaw: 30 });
  assert.ok(turned.length > flat.length);
});

test("extrudeY draws far layers first and the front face last", () => {
  const sq = [[0, 0], [10, 0], [10, 10], [0, 10]];
  const f = extrudeY("m", sq, 0, 6, 4, { ...V0, yaw: 25 });
  assert.equal(f[f.length - 1].key, "m:front");
  const layerOf = (k) => Number(k.split(":l")[1]?.split(":")[0]);
  const ls = f.filter((x) => x.key.includes(":l")).map((x) => layerOf(x.key));
  assert.deepEqual(ls, [...ls].sort((a, b) => b - a));
});
