import test from "node:test";
import assert from "node:assert/strict";
import { journey, progressOf, RUNWAY_VH } from "./journey.ts";

test("at p = 0 the hero is exactly the measured hero: no zoom, no shift, copy and plate fully visible", () => {
  const j = journey(0);
  assert.equal(j.scale, 1);
  assert.equal(j.ty, 0);
  assert.equal(j.copy, 1);
  assert.equal(j.plate, 1);
  assert.equal(j.white, 0);
  assert.equal(j.text, 0);
  assert.equal(j.nav, 1);
});

test("the camera only moves forward: scale never decreases as p grows", () => {
  let prev = 0;
  for (let p = 0; p <= 1.0001; p += 0.01) { const s = journey(p).scale; assert.ok(s >= prev - 1e-9); prev = s; }
  assert.ok(journey(1).scale > 8);
});

test("journey is a pure function of p: same input, same output, any order (so scrolling back retraces it)", () => {
  const a = journey(0.5), b = journey(0.9), c = journey(0.5);
  assert.deepEqual(a, c);
  assert.notDeepEqual(a, b);
});

test("the light floods white in the middle and is gone again at the end (black room)", () => {
  assert.ok(journey(0.8).white > 0.95);
  assert.equal(journey(1).white, 0);
  assert.ok(journey(0.85).text > 0.9);
});

test("all outputs stay in range and clamp outside 0..1", () => {
  for (const p of [-5, 0, 0.3, 0.7, 1, 4]) {
    const j = journey(p);
    for (const k of ["copy", "plate", "white", "text", "nav", "hint"]) assert.ok(j[k] >= 0 && j[k] <= 1, `${k} at ${p}`);
  }
  assert.deepEqual(journey(-5), journey(0));
  assert.deepEqual(journey(4), journey(1));
});

test("progressOf maps scroll position over the runway and clamps", () => {
  const vh = 800, runway = RUNWAY_VH * vh;
  assert.equal(progressOf(0, vh), 0);
  assert.equal(progressOf(runway - vh, vh), 1);
  assert.equal(progressOf(99999, vh), 1);
  assert.ok(Math.abs(progressOf((runway - vh) / 2, vh) - 0.5) < 1e-9);
});

import { anchorDuration } from "./journey.ts";
test("link jumps: short ones stay quick, long ones through the door take longer, capped", () => {
  assert.equal(anchorDuration(0, 800), 1.2);
  assert.ok(anchorDuration(800, 800) < anchorDuration(4000, 800));
  assert.ok(anchorDuration(4800 * 2, 800) <= 7);
  assert.ok(anchorDuration(5 * 800, 800) >= 4);
});
