import test from "node:test";
import assert from "node:assert/strict";
import { MANDATE, GATE_ORDER, nestedMandate, payments, howScene } from "./scenes.ts";
import { evaluate } from "./rules.ts";

test("step 1 box sides are proportional to the ledger numbers (threshold, cap, budget, deposit)", () => {
  const { sides } = nestedMandate();
  const nums = [MANDATE.threshold, MANDATE.cap, MANDATE.budget, MANDATE.deposited];
  nums.forEach((n, i) => assert.ok(Math.abs(sides[i] / sides[3] - n / nums[3]) < 1e-9));
  assert.ok(sides[0] <= sides[1] && sides[1] <= sides[2] && sides[2] <= sides[3]);
});

test("the nested boxes really nest: every inner box fits inside the next one", () => {
  const { prisms } = nestedMandate();
  for (let i = 0; i < prisms.length - 1; i++) {
    const a = prisms[i], b = prisms[i + 1];
    assert.ok(a.h < b.h && a.pts[2][0] < b.pts[2][0]);
  }
});

// The visual gate order must equal the order in which rules.ts reports failures.
const NOW = 1_800_000_000_000;
const mandate = () => ({ id: 1, status: "Active", expiresAtMs: NOW + 1000, recipients: ["shop.testnet"], perPaymentCap: "400000", budget: "1000000", approvalThreshold: "250000" });
const state = () => ({ deposited: "1500000", spent: "0", reserved: "0", withdrawn: "0", openRequests: 0, nowMs: NOW, approvals: [] });
const req = () => ({ recipient: "shop.testnet", amount: "100000", nonce: 1 });
const breakAt = {
  NOT_ACTIVE: () => [{ ...mandate(), status: "Revoked" }, state(), req()],
  EXPIRED: () => [{ ...mandate(), expiresAtMs: NOW }, state(), req()],
  RECIPIENT_NOT_ALLOWED: () => [mandate(), state(), { ...req(), recipient: "x.testnet" }],
  OVER_PER_PAYMENT_CAP: () => [mandate(), state(), { ...req(), amount: "400001" }],
  TOO_MANY_OPEN: () => [mandate(), { ...state(), openRequests: 32 }, req()],
  OVER_BUDGET: () => [mandate(), { ...state(), spent: "950000" }, req()],
  NEEDS_APPROVAL: () => [mandate(), state(), { ...req(), amount: "300000" }],
};

test("every gate in GATE_ORDER is the check that fires for its code, and no earlier gate fires first", () => {
  GATE_ORDER.forEach((g, i) => {
    const [m, s, r] = breakAt[g.code]();
    assert.equal(evaluate(m, s, r).code, g.code);
    assert.equal(GATE_ORDER[i].code, g.code);
  });
  assert.deepEqual(GATE_ORDER.map((g) => g.code), ["NOT_ACTIVE", "EXPIRED", "RECIPIENT_NOT_ALLOWED", "OVER_PER_PAYMENT_CAP", "TOO_MANY_OPEN", "OVER_BUDGET", "NEEDS_APPROVAL"]);
});

test("a request that breaks several gates is reported at the earliest gate in GATE_ORDER", () => {
  const m = { ...mandate(), status: "Revoked" };
  const s = { ...state(), openRequests: 32, spent: "999999" };
  const r = { recipient: "x.testnet", amount: "999999", nonce: 1 };
  assert.equal(evaluate(m, s, r).code, GATE_ORDER[0].code);
  assert.equal(evaluate(mandate(), s, r).code, "RECIPIENT_NOT_ALLOWED");
});

test("payments: the accepted block crosses the gate, the rejected one never does and ends up behind where it started", () => {
  const GATE_X = 18;
  let maxBad = -Infinity;
  for (let p = 0; p <= 1; p += 0.01) maxBad = Math.max(maxBad, payments(p).bad.x + 30);
  assert.ok(maxBad <= GATE_X + 1e-6);
  assert.ok(payments(0.55).ok.x > 20);
  assert.ok(payments(1).bad.x < payments(0.69).bad.x);
});

test("every step has prisms and the gate exists in steps 3 and 4", () => {
  for (let s = 0; s < 4; s++) assert.ok(howScene(s, 0.6).prisms.length > 0);
  assert.ok(howScene(2, 0.6).prisms.some((p) => p.id === "gate"));
  assert.ok(howScene(3, 0).prisms.find((p) => p.id === "gate").h < howScene(2, 0).prisms.find((p) => p.id === "gate").h);
});
