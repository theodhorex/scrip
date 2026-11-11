import test from "node:test";
import assert from "node:assert/strict";
import { GATE_ORDER, MANDATE } from "./scenes.ts";
import { GATE_NOTES, SEGMENTS, SPENT_SEGMENTS, COLUMN_TOP, SEG_H, DOOR_X, vaultScene, gatesPassed, parkX } from "./vault-scene.ts";
import { GATE_X } from "./rule-scene.ts";

const base = { blockX: -120, open: 0.3, active: -1 };
const byId = (s, id) => s.prisms.find((p) => p.id === id);

test("one note per wall, in the contract's order, all walls in front of the door", () => {
  assert.equal(GATE_NOTES.length, GATE_ORDER.length);
  assert.match(GATE_NOTES[5], /budget/);
  assert.match(GATE_NOTES[2], /allowed list/);
  GATE_X.forEach((x, i) => { assert.ok(x < DOOR_X); if (i) assert.ok(x > GATE_X[i - 1]); });
});
test("the budget column is the worked example: 0.20 of 1.00 is spent, the plane is the budget", () => {
  assert.equal(SEGMENTS, 10);
  assert.equal(SPENT_SEGMENTS, 2);
  assert.equal(MANDATE.budget, 1);
  const s = vaultScene(base);
  const segs = s.prisms.filter((p) => p.id.startsWith("seg"));
  assert.equal(segs.length, SEGMENTS);
  assert.equal(segs.filter((p) => p.tone === "matte").length, SPENT_SEGMENTS);
  assert.equal(byId(s, "plane").z, COLUMN_TOP);
  assert.equal(COLUMN_TOP, SEGMENTS * SEG_H);
});
test("selecting a wall lifts and lights only that wall", () => {
  const s = vaultScene({ ...base, active: 3 });
  assert.equal(byId(s, "g3").tone, "bright");
  assert.ok(byId(s, "g3").z > byId(s, "g2").z);
  assert.equal(byId(s, "g2").tone, "matte");
});
test("the leaf rises as the door opens, the light stays put", () => {
  const closed = vaultScene({ ...base, open: 0 }), open = vaultScene({ ...base, open: 1 });
  assert.ok(byId(open, "leaf").z > byId(closed, "leaf").z);
  assert.equal(byId(open, "light").z, byId(closed, "light").z);
});
test("parking and counting walls", () => {
  assert.equal(gatesPassed(-120), 0);
  assert.equal(gatesPassed(GATE_X[6] + 20), 7);
  for (let g = 0; g < 7; g++) assert.ok(parkX(g) < GATE_X[g]);
  assert.ok(gatesPassed(parkX(3)) <= 3);
});
