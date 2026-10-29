import test from "node:test";
import assert from "node:assert/strict";
import {
  ATTACKER_ACCOUNT,
  ATTACKER_SHORT,
  MERCHANT_ACCOUNT,
  MERCHANT_SHORT,
  applyLeverPull,
  computeAutoDemoSequence,
  createInitialMachineState,
  deriveAnimationFrames,
  dialAngleDeg,
  stepDialUsdc,
  usdcToRawUnits,
} from "./rule-machine.ts";

test("exposes real merchant and dmx... attacker addresses from pure landing-data", () => {
  assert.ok(MERCHANT_ACCOUNT.endsWith(".testnet"));
  assert.ok(ATTACKER_ACCOUNT.startsWith("dmx"));
  assert.ok(ATTACKER_SHORT.startsWith("dmx"));
  assert.ok(MERCHANT_SHORT.length > 0);
});

test("stepDialUsdc steps by 0.05 USDC without float drift and clamps to [0.05, 1.20]", () => {
  assert.equal(stepDialUsdc(0.2, 1), 0.25);
  assert.equal(stepDialUsdc(0.2, 2), 0.3);
  assert.equal(stepDialUsdc(0.2, -1), 0.15);
  assert.equal(stepDialUsdc(0.05, -1), 0.05);
  assert.equal(stepDialUsdc(1.2, 1), 1.2);
  assert.equal(usdcToRawUnits(0.3), "300000");
  assert.equal(dialAngleDeg(0.05), -135);
  assert.equal(dialAngleDeg(1.2), 135);
});

test("deriveAnimationFrames produces sequential pass frames ending at merchant crate", () => {
  const frames = deriveAnimationFrames({ ok: true });
  assert.equal(frames[0].stage, "spawn");
  assert.deepEqual(frames[0].gates, ["idle", "idle", "idle"]);
  assert.equal(frames[0].leverDown, true);

  assert.equal(frames[1].stage, "gate-0");
  assert.deepEqual(frames[1].gates, ["pass", "idle", "idle"]);

  assert.equal(frames[2].stage, "gate-1");
  assert.deepEqual(frames[2].gates, ["pass", "pass", "idle"]);

  assert.equal(frames[3].stage, "gate-2");
  assert.deepEqual(frames[3].gates, ["pass", "pass", "pass"]);

  const last = frames[frames.length - 1];
  assert.equal(last.stage, "merchant");
  assert.deepEqual(last.gates, ["pass", "pass", "pass"]);
  assert.equal(last.activeCode, null);
});

test("deriveAnimationFrames stops at rejecting gate and diverts packet to rejected bin", () => {
  const g1 = deriveAnimationFrames({ ok: false, code: "RECIPIENT_NOT_ALLOWED" });
  assert.equal(g1.length, 3);
  assert.equal(g1[1].stage, "gate-0");
  assert.equal(g1[1].sparkGate, 0);
  assert.deepEqual(g1[2].gates, ["reject", "idle", "idle"]);
  assert.equal(g1[2].stage, "rejected");
  assert.equal(g1[2].activeCode, "RECIPIENT_NOT_ALLOWED");

  const g2 = deriveAnimationFrames({ ok: false, code: "OVER_PER_PAYMENT_CAP" });
  assert.equal(g2.length, 4);
  assert.equal(g2[2].stage, "gate-1");
  assert.equal(g2[2].sparkGate, 1);
  assert.deepEqual(g2[3].gates, ["pass", "reject", "idle"]);
  assert.equal(g2[3].stage, "rejected");
  assert.equal(g2[3].activeCode, "OVER_PER_PAYMENT_CAP");

  const g3 = deriveAnimationFrames({ ok: false, code: "OVER_BUDGET" });
  assert.equal(g3.length, 5);
  assert.equal(g3[3].stage, "gate-2");
  assert.equal(g3[3].sparkGate, 2);
  assert.deepEqual(g3[4].gates, ["pass", "pass", "reject"]);
  assert.equal(g3[4].stage, "rejected");
  assert.equal(g3[4].activeCode, "OVER_BUDGET");
});

test("applyLeverPull evaluates mandate rules, deducts budget on pass, increments nonce, and caps log at 5", () => {
  let state = createInitialMachineState();
  assert.equal(state.remainingUsdc, "1.00");
  assert.equal(state.nonce, 1);

  // 1. Valid 0.45 USDC payment to Merchant -> passes
  state = applyLeverPull(state, { recipient: MERCHANT_ACCOUNT, amountUsdc: 0.45 }).nextState;
  assert.equal(state.spentUsdc, "0.45");
  assert.equal(state.remainingUsdc, "0.55");
  assert.equal(state.nonce, 2);
  assert.deepEqual(state.gateStates, ["pass", "pass", "pass"]);

  // 2. Over cap 0.55 USDC -> OVER_PER_PAYMENT_CAP, budget unchanged
  state = applyLeverPull(state, { recipient: MERCHANT_ACCOUNT, amountUsdc: 0.55 }).nextState;
  assert.equal(state.activeCode, "OVER_PER_PAYMENT_CAP");
  assert.equal(state.remainingUsdc, "0.55");
  assert.deepEqual(state.gateStates, ["pass", "reject", "idle"]);

  // 3. Valid 0.40 USDC -> passes, remaining 0.15 USDC
  state = applyLeverPull(state, { recipient: MERCHANT_ACCOUNT, amountUsdc: 0.4 }).nextState;
  assert.equal(state.remainingUsdc, "0.15");

  // 4. Within cap 0.25 USDC, but exceeds remaining 0.15 -> OVER_BUDGET
  state = applyLeverPull(state, { recipient: MERCHANT_ACCOUNT, amountUsdc: 0.25 }).nextState;
  assert.equal(state.activeCode, "OVER_BUDGET");
  assert.deepEqual(state.gateStates, ["pass", "pass", "reject"]);
  assert.equal(state.remainingUsdc, "0.15");

  // 5 & 6. Two attacker attempts -> RECIPIENT_NOT_ALLOWED, history capped at 5
  state = applyLeverPull(state, { recipient: ATTACKER_ACCOUNT, amountUsdc: 0.1 }).nextState;
  state = applyLeverPull(state, { recipient: ATTACKER_ACCOUNT, amountUsdc: 0.1 }).nextState;
  assert.equal(state.activeCode, "RECIPIENT_NOT_ALLOWED");
  assert.equal(state.history.length, 5);
  assert.equal(state.nonce, 7);
});

test("computeAutoDemoSequence runs one valid merchant payment then one rejected attacker payment", () => {
  const demo = computeAutoDemoSequence();
  assert.deepEqual(demo.step1.evaluation, { ok: true });
  assert.equal(demo.step1.nextState.spentUsdc, "0.20");
  assert.equal(demo.step1.nextState.remainingUsdc, "0.80");

  assert.deepEqual(demo.step2.evaluation, {
    ok: false,
    code: "RECIPIENT_NOT_ALLOWED",
  });
  assert.equal(demo.step2.nextState.remainingUsdc, "0.80");
  assert.equal(demo.step2.nextState.activeCode, "RECIPIENT_NOT_ALLOWED");
  assert.equal(demo.step2.nextState.history.length, 2);
});
