import test from "node:test";
import assert from "node:assert/strict";
import {
  formatUsdc6,
  shortenHash,
  explorerTxUrl,
  mapProofData,
  PROOF_DATA,
} from "./proof-data.ts";
import gateJson from "../data/gate.json" with { type: "json" };

test("formatUsdc6 formats 6-decimal USDC strings accurately", () => {
  assert.equal(formatUsdc6("1250000"), "1.25");
  assert.equal(formatUsdc6("500000"), "0.50");
  assert.equal(formatUsdc6("250000"), "0.25");
  assert.equal(formatUsdc6("6000000"), "6.00");
  assert.equal(formatUsdc6("0"), "0.00");
  assert.equal(formatUsdc6("1000000"), "1.00");
});

test("shortenHash produces 4 chars + ellipsis + 3 chars (7VjV…PWs)", () => {
  const hash = "7VjVW5u2zyvBvELD4NWu5Yu7bE9VEQuVNm3QJpZPNPWs";
  assert.equal(shortenHash(hash), "7VjV…PWs");
  assert.equal(shortenHash("abc"), "abc");
});

test("explorerTxUrl builds nearblocks testnet transaction link", () => {
  const hash = "7VjVW5u2zyvBvELD4NWu5Yu7bE9VEQuVNm3QJpZPNPWs";
  assert.equal(
    explorerTxUrl(hash),
    "https://testnet.nearblocks.io/txns/7VjVW5u2zyvBvELD4NWu5Yu7bE9VEQuVNm3QJpZPNPWs",
  );
});

test("mapProofData maps gate.json with exactly 7 sequential proof steps", () => {
  const data = mapProofData(gateJson);

  assert.equal(data.network, "testnet");
  assert.equal(data.steps.length, 7);

  const stepKeys = data.steps.map((s) => s.key);
  assert.deepEqual(stepKeys, [
    "deploy",
    "init",
    "createMandate",
    "fund",
    "validPayment",
    "revoke",
    "withdraw",
  ]);

  for (const step of data.steps) {
    assert.ok(step.label.length > 0, `Step ${step.key} has non-empty label`);
    assert.ok(step.hash.length > 20, `Step ${step.key} has valid non-empty hash`);
    assert.ok(step.shortHash.includes("…"), `Step ${step.key} has shortened hash`);
    assert.ok(
      step.explorerUrl.startsWith("https://testnet.nearblocks.io/txns/"),
      `Step ${step.key} has explorer URL`,
    );
    assert.ok(
      step.explanation.length > 0,
      `Step ${step.key} has English explanation`,
    );
  }

  // Check specific step outcomes
  const validPayment = data.steps.find((s) => s.key === "validPayment");
  assert.ok(validPayment);
  assert.ok(validPayment.resultSummary?.includes("0.50 USDC"));

  const fundStep = data.steps.find((s) => s.key === "fund");
  assert.ok(fundStep);
  assert.ok(fundStep.resultSummary?.includes("1.25 USDC"));

  const withdrawStep = data.steps.find((s) => s.key === "withdraw");
  assert.ok(withdrawStep);
  assert.ok(withdrawStep.resultSummary?.includes("0.25 USDC"));
});

test("mapProofData maps attacks from steps.attacks correctly", () => {
  const data = mapProofData(gateJson);
  assert.equal(data.attacks.length, 5);

  const recipientAttack = data.attacks.find((a) => a.key === "recipientNotAllowed");
  assert.ok(recipientAttack);
  assert.equal(recipientAttack.rejectionCode, "RECIPIENT_NOT_ALLOWED");
  assert.equal(recipientAttack.httpStatus, 200);
  assert.equal(recipientAttack.txHash, "7xpa79ixi7C3vnmC6hesZLz6KbwNj8VPQjpR33tZQZv5");

  const overCapAttack = data.attacks.find((a) => a.key === "overCap");
  assert.ok(overCapAttack);
  assert.equal(overCapAttack.rejectionCode, "OVER_PER_PAYMENT_CAP");
  assert.equal(overCapAttack.httpStatus, 200);
  assert.equal(overCapAttack.txHash, "C1u2JX5kiWVkD3fQhrjmrX7sjgiRjV1hemycHUnzrvK9");

  const methodAttack = data.attacks.find((a) => a.key === "guardianMethodViaRelay");
  assert.ok(methodAttack);
  assert.equal(methodAttack.rejectionCode, "METHOD_NOT_ALLOWED");
  assert.equal(methodAttack.httpStatus, 400);
  assert.equal(methodAttack.txHash, null);

  const gasAttack = data.attacks.find((a) => a.key === "lowGas");
  assert.ok(gasAttack);
  assert.equal(gasAttack.rejectionCode, "GAS_TOO_LOW");
  assert.equal(gasAttack.httpStatus, 400);

  const forgedKeyAttack = data.attacks.find((a) => a.key === "forgedKey");
  assert.ok(forgedKeyAttack);
  assert.equal(forgedKeyAttack.rejectionCode, "KEY_NOT_ALLOWED");
  assert.equal(forgedKeyAttack.httpStatus, 400);
});

test("mapProofData verifies cleanup: leftover accounts empty and funder balance preserved", () => {
  const data = mapProofData(gateJson);
  assert.deepEqual(data.cleanup.leftoverAccounts, []);
  assert.equal(data.cleanup.leftoverCount, 0);
  assert.equal(data.cleanup.funderUsdcBefore, "6.00");
  assert.equal(data.cleanup.funderUsdcAfter, "6.00");
  assert.equal(data.cleanup.funderBalanced, true);
  assert.equal(data.cleanup.contractUsdcLeft, "0.00");
  assert.equal(data.cleanup.contractDrained, true);
});

test("PROOF_DATA constant is properly initialized and immutable", () => {
  assert.equal(PROOF_DATA.network, "testnet");
  assert.equal(PROOF_DATA.steps.length, 7);
  assert.equal(PROOF_DATA.attacks.length, 5);
  assert.equal(PROOF_DATA.cleanup.leftoverCount, 0);
});
