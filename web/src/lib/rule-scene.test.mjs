import test from "node:test";
import assert from "node:assert/strict";
import { GATE_ORDER } from "./scenes.ts";
import { GATE_X, gateIndexOf, runPos, ruleScene, blockSide, END_X, START_X } from "./rule-scene.ts";
const REJECT_CODES = ["NOT_ACTIVE","EXPIRED","RECIPIENT_NOT_ALLOWED","OVER_PER_PAYMENT_CAP","TOO_MANY_OPEN","OVER_BUDGET","NEEDS_APPROVAL","APPROVAL_USED","APPROVAL_EXPIRED"];
import { stackPrisms, PLATE } from "./limit-stack.ts";

test("seven walls, in the contract order, increasing x", () => {
  assert.equal(GATE_X.length, 7);
  assert.equal(GATE_ORDER[2].code, "RECIPIENT_NOT_ALLOWED");
  for (let i = 1; i < GATE_X.length; i++) assert.ok(GATE_X[i] > GATE_X[i - 1]);
});
test("every reject code maps to a wall, approval codes to the last", () => {
  for (const c of REJECT_CODES) assert.ok(gateIndexOf(c) >= 0, c);
  assert.equal(gateIndexOf("OVER_BUDGET"), 5);
  assert.equal(gateIndexOf("APPROVAL_USED"), 6);
  assert.equal(gateIndexOf("NOPE"), -1);
});
test("accepted run crosses all walls and ends at the column", () => {
  assert.equal(runPos(null, 0).x, START_X);
  assert.equal(runPos(null, 1).x, END_X);
  assert.equal(runPos(null, 1).lit, 7);
});
test("rejected run stops before its wall and returns, never crossing it", () => {
  for (let f = 0; f < 7; f++) for (let k = 0; k <= 20; k++) {
    const p = runPos(f, k / 20);
    assert.ok(p.x < GATE_X[f], `wall ${f} t ${k}`);
  }
  assert.equal(runPos(3, 0.3).bounced, false);
  assert.equal(runPos(3, 0.9).bounced, true);
  assert.ok(runPos(3, 1).x < runPos(3, 0.6).x);
});
test("scene reacts to inputs", () => {
  const base = { milli: 100, stranger: false, approved: false, needsApproval: false, spentFrac: 0, reservedFrac: 0, run: null };
  const a = ruleScene(base).prisms, b = ruleScene({ ...base, needsApproval: true }).prisms;
  assert.ok(!a.some((p) => p.id === "lock") && b.some((p) => p.id === "lock"));
  assert.ok(blockSide(600) > blockSide(100));
  const lane = (s) => ruleScene({ ...base, stranger: s }).prisms.find((p) => p.id === "block").pts[0][1];
  assert.notEqual(lane(true), lane(false));
  const f = ruleScene({ ...base, run: { failIndex: 3, t: 0.9 } }).prisms;
  assert.equal(f.find((p) => p.id === "block").tone, "reject");
  assert.equal(f.find((p) => p.id === "g3").tone, "reject");
  const c = ruleScene({ ...base, spentFrac: 0.5 }).prisms;
  assert.equal(c.find((p) => p.id === "col-spent").h, 26);
});
test("stack: explode spreads plates, active plate is lifted and bright", () => {
  const closed = stackPrisms(9, 0, -1), open = stackPrisms(9, 1, 4);
  assert.ok(open[8].z > closed[8].z);
  assert.equal(open[4].tone, "bright");
  assert.ok(open[4].z - open[3].z > open[3].z - open[2].z);
  assert.equal(closed[0].tone, "matte");
  assert.equal(closed[3].tone, "matte");
  assert.equal(PLATE.h, closed[0].h);
});
