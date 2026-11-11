import test from "node:test";
import assert from "node:assert/strict";
import {
  SIM, initialSim, submitPayment, parseRuleQuery, toRuleQuery, formatEvent, milliToUnits, DEFAULT_INPUT,
} from "./rule-sim.ts";

const send = (state, input) => submitPayment(state, { ...DEFAULT_INPUT, ...input });

test("milliToUnits converts 0.001 USDC steps to 6-decimal raw units without float drift", () => {
  assert.equal(milliToUnits(300), "300000");
  assert.equal(milliToUnits(10), "10000");
  assert.equal(milliToUnits(1000), "1000000");
});

test("an allowed payment under the threshold reserves then settles", () => {
  const r = send(initialSim(), { to: "allowed", amountMilli: 100 });
  assert.equal(r.outcome, "settled");
  assert.equal(r.reservedState.reserved, "100000");
  assert.equal(r.state.reserved, "0");
  assert.equal(r.state.spent, "100000");
  assert.deepEqual(r.events.map((e) => e.event), ["reserved", "settled"]);
});

test("unknown recipient is rejected with RECIPIENT_NOT_ALLOWED and state is untouched", () => {
  const s0 = initialSim();
  const r = send(s0, { to: "unknown", amountMilli: 100 });
  assert.equal(r.outcome, "rejected");
  assert.equal(r.code, "RECIPIENT_NOT_ALLOWED");
  assert.deepEqual(r.state, s0);
  assert.deepEqual(r.events.map((e) => e.event), ["rejected"]);
  assert.equal(r.events[0].data.code, "RECIPIENT_NOT_ALLOWED");
});

test("amount above the per-payment cap is OVER_PER_PAYMENT_CAP, not a made-up code", () => {
  const r = send(initialSim(), { amountMilli: 500, approved: true });
  assert.equal(r.code, "OVER_PER_PAYMENT_CAP");
});

test("amount above the approval threshold needs the guardian toggle", () => {
  assert.equal(send(initialSim(), { amountMilli: 300 }).code, "NEEDS_APPROVAL");
  const ok = send(initialSim(), { amountMilli: 300, approved: true });
  assert.equal(ok.outcome, "settled");
  assert.equal(ok.state.spent, "300000");
});

test("the approval toggle is spent only when the payment goes through", () => {
  const r = send(initialSim(), { to: "unknown", amountMilli: 300, approved: true });
  assert.equal(r.code, "RECIPIENT_NOT_ALLOWED");
});

test("the budget is a line that cannot be crossed: repeated payments end in OVER_BUDGET", () => {
  let s = initialSim();
  const results = [];
  for (let i = 0; i < 12; i++) {
    const r = send(s, { amountMilli: 250 });
    results.push(r.outcome === "settled" ? "ok" : r.code);
    s = r.state;
  }
  assert.deepEqual(results.slice(0, 4), ["ok", "ok", "ok", "ok"]);
  assert.equal(results[4], "OVER_BUDGET");
  assert.equal(s.spent, "1000000");
  assert.ok(BigInt(s.spent) <= BigInt(SIM.budget));
});

test("every submission uses a fresh nonce and request id on reservation", () => {
  const a = send(initialSim(), { amountMilli: 100 });
  const b = send(a.state, { amountMilli: 100 });
  assert.equal(b.events[0].data.request_id, a.events[0].data.request_id + 1);
});

test("event lines use the contract's NEP-297 envelope", () => {
  const r = send(initialSim(), { amountMilli: 100 });
  const line = formatEvent(r.events[0]);
  assert.ok(line.startsWith("EVENT_JSON:"));
  const j = JSON.parse(line.slice("EVENT_JSON:".length));
  assert.equal(j.standard, "scrip");
  assert.equal(j.version, "1.0.0");
  assert.equal(j.event, "reserved");
  assert.equal(j.data.length, 1);
  assert.equal(j.data[0].amount, "100000");
});

test("deep link parsing accepts only known values and clamps the amount", () => {
  assert.deepEqual(parseRuleQuery("to=unknown&amount=300"), { to: "unknown", amountMilli: 300, approved: false });
  assert.deepEqual(parseRuleQuery("?to=allowed&amount=9999&approved=1"), { to: "allowed", amountMilli: 600, approved: true });
  assert.deepEqual(parseRuleQuery("to=<script>&amount=abc"), DEFAULT_INPUT);
  assert.deepEqual(parseRuleQuery(""), DEFAULT_INPUT);
  assert.equal(toRuleQuery({ to: "unknown", amountMilli: 300, approved: false }), "to=unknown&amount=300");
});
