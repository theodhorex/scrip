import test from "node:test";
import assert from "node:assert/strict";
import { parsePaymentOutcome, usdcToUnits, unitsToUsdc, isValidAccountId, remaining, LIVE } from "./live.ts";

const b64 = (o) => Buffer.from(JSON.stringify(o)).toString("base64");

test("parsePaymentOutcome reads Settled, Rejected and Refunded", () => {
  assert.deepEqual(parsePaymentOutcome({ status: { SuccessValue: b64({ Settled: { request_id: 4 } }) } }), { kind: "settled", requestId: 4 });
  assert.deepEqual(parsePaymentOutcome({ status: { SuccessValue: b64({ Rejected: { code: "RECIPIENT_NOT_ALLOWED" } }) } }), { kind: "rejected", code: "RECIPIENT_NOT_ALLOWED" });
  assert.deepEqual(parsePaymentOutcome({ status: { SuccessValue: b64({ Refunded: { request_id: 2 } }) } }), { kind: "refunded", requestId: 2 });
});

test("parsePaymentOutcome reports failures and unknown shapes", () => {
  const f = parsePaymentOutcome({ status: { Failure: { ActionError: { kind: { FunctionCallError: { ExecutionError: "Smart contract panicked: INSUFFICIENT_GAS" } } } } } });
  assert.equal(f.kind, "failed");
  assert.match(f.detail, /INSUFFICIENT_GAS/);
  assert.equal(parsePaymentOutcome({ status: { SuccessValue: "" } }).kind, "unknown");
  assert.equal(parsePaymentOutcome(null).kind, "unknown");
});

test("usdc conversions are exact", () => {
  assert.equal(usdcToUnits("0.01"), "10000");
  assert.equal(usdcToUnits("1"), "1000000");
  assert.equal(usdcToUnits("0.1234567"), null);
  assert.equal(usdcToUnits("-1"), null);
  assert.equal(usdcToUnits(""), null);
  assert.equal(unitsToUsdc("10000"), "0.01");
  assert.equal(unitsToUsdc("10000000"), "10");
  assert.equal(unitsToUsdc("0"), "0");
});

test("account id validation follows NEAR rules", () => {
  assert.ok(isValidAccountId("attacker.testnet"));
  assert.ok(isValidAccountId("live-shop-a.envtest-theo-1747.testnet"));
  assert.ok(!isValidAccountId("Attacker.testnet"));
  assert.ok(!isValidAccountId("a"));
  assert.ok(!isValidAccountId("bad..testnet"));
  assert.ok(!isValidAccountId("x".repeat(65)));
});

test("remaining budget never goes below zero", () => {
  assert.equal(remaining({ budget: "100", deposited: "100", withdrawn: "0", spent: "30", reserved: "10" }), "60");
  assert.equal(remaining({ budget: "100", deposited: "50", withdrawn: "0", spent: "30", reserved: "0" }), "20");
  assert.equal(remaining({ budget: "100", deposited: "100", withdrawn: "0", spent: "100", reserved: "5" }), "0");
});

test("live config is a testnet function-call setup", () => {
  assert.equal(LIVE.network, "testnet");
  assert.ok(LIVE.contractId.endsWith(".testnet"));
  assert.ok(LIVE.agentKey.startsWith("ed25519:"));
  assert.equal(LIVE.recipients.length, 2);
});
