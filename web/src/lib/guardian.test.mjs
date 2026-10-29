// Run: cd web && node --test src/lib/guardian.test.mjs
import test from "node:test";
import assert from "node:assert/strict";
import { applyChange, MAX_RECIPIENTS } from "./guardian.ts";

function baseMandate() {
  return {
    id: 1,
    status: "Active",
    budget: "1000000",          // 1.00 USDC
    perPaymentCap: "500000",    // 0.50 USDC
    approvalThreshold: "300000",// 0.30 USDC
    expiresAtMs: 1_800_000_000_000,
    recipients: ["merchant.near", "vendor.near"],
  };
}

function baseState() {
  return {
    deposited: "1250000", // 1.25 USDC
    spent: "200000",     // 0.20 USDC
    reserved: "100000",  // 0.10 USDC (committed = 0.30 USDC)
    withdrawn: "0",
    nowMs: 1_700_000_000_000,
  };
}

// -------------------------------------------------------------
// 1. Budget: tighten & loosen
// -------------------------------------------------------------
test("Budget tighten - passes when spent+reserved <= x < budget", () => {
  const m = baseMandate();
  const s = baseState();
  // committed = 300_000, budget = 1_000_000. Tighten to 500_000.
  const res = applyChange("tighten", m, s, { Budget: "500000" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.mandate.budget, "500000");
  }
});

test("Budget tighten - fails NOT_STRICTER when x >= budget", () => {
  const m = baseMandate();
  const s = baseState();
  const resEqual = applyChange("tighten", m, s, { Budget: "1000000" });
  assert.deepEqual(resEqual, { ok: false, code: "NOT_STRICTER" });

  const resGreater = applyChange("tighten", m, s, { Budget: "1100000" });
  assert.deepEqual(resGreater, { ok: false, code: "NOT_STRICTER" });
});

test("Budget tighten - fails BUDGET_BELOW_COMMITTED when x < spent + reserved", () => {
  const m = baseMandate();
  const s = baseState(); // committed = 300_000
  const res = applyChange("tighten", m, s, { Budget: "299999" });
  assert.deepEqual(res, { ok: false, code: "BUDGET_BELOW_COMMITTED" });
});

test("Budget loosen - passes when budget < x <= deposited - withdrawn", () => {
  const m = baseMandate();
  const s = baseState(); // deposited = 1_250_000
  const res = applyChange("loosen", m, s, { Budget: "1200000" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.mandate.budget, "1200000");
  }
});

test("Budget loosen - fails NOT_LOOSER when x <= budget", () => {
  const m = baseMandate();
  const s = baseState();
  const resEqual = applyChange("loosen", m, s, { Budget: "1000000" });
  assert.deepEqual(resEqual, { ok: false, code: "NOT_LOOSER" });

  const resLesser = applyChange("loosen", m, s, { Budget: "900000" });
  assert.deepEqual(resLesser, { ok: false, code: "NOT_LOOSER" });
});

test("Budget loosen - fails BUDGET_ABOVE_DEPOSITED when x > deposited - withdrawn", () => {
  const m = baseMandate();
  const s = baseState(); // deposited = 1_250_000, withdrawn = 0
  const res = applyChange("loosen", m, s, { Budget: "1250001" });
  assert.deepEqual(res, { ok: false, code: "BUDGET_ABOVE_DEPOSITED" });
});

// -------------------------------------------------------------
// 2. PerPaymentCap: tighten & loosen
// -------------------------------------------------------------
test("PerPaymentCap tighten - passes when x < cap", () => {
  const m = baseMandate();
  const s = baseState(); // cap = 500_000
  const res = applyChange("tighten", m, s, { PerPaymentCap: "400000" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.mandate.perPaymentCap, "400000");
  }
});

test("PerPaymentCap tighten - fails NOT_STRICTER when x >= cap", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("tighten", m, s, { PerPaymentCap: "500000" });
  assert.deepEqual(res, { ok: false, code: "NOT_STRICTER" });
});

test("PerPaymentCap loosen - passes when cap < x <= budget", () => {
  const m = baseMandate();
  const s = baseState(); // cap = 500_000, budget = 1_000_000
  const res = applyChange("loosen", m, s, { PerPaymentCap: "800000" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.mandate.perPaymentCap, "800000");
  }
});

test("PerPaymentCap loosen - fails NOT_LOOSER when x <= cap", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("loosen", m, s, { PerPaymentCap: "500000" });
  assert.deepEqual(res, { ok: false, code: "NOT_LOOSER" });
});

test("PerPaymentCap loosen - fails CAP_ABOVE_BUDGET when x > budget", () => {
  const m = baseMandate();
  const s = baseState(); // budget = 1_000_000
  const res = applyChange("loosen", m, s, { PerPaymentCap: "1000001" });
  assert.deepEqual(res, { ok: false, code: "CAP_ABOVE_BUDGET" });
});

// -------------------------------------------------------------
// 3. ApprovalThreshold: tighten & loosen
// -------------------------------------------------------------
test("ApprovalThreshold tighten - passes when x < threshold", () => {
  const m = baseMandate();
  const s = baseState(); // threshold = 300_000
  const res = applyChange("tighten", m, s, { ApprovalThreshold: "200000" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.mandate.approvalThreshold, "200000");
  }
});

test("ApprovalThreshold tighten - fails NOT_STRICTER when x >= threshold", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("tighten", m, s, { ApprovalThreshold: "300000" });
  assert.deepEqual(res, { ok: false, code: "NOT_STRICTER" });
});

test("ApprovalThreshold loosen - passes when threshold < x <= cap", () => {
  const m = baseMandate();
  const s = baseState(); // threshold = 300_000, cap = 500_000
  const res = applyChange("loosen", m, s, { ApprovalThreshold: "450000" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.mandate.approvalThreshold, "450000");
  }
});

test("ApprovalThreshold loosen - fails NOT_LOOSER when x <= threshold", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("loosen", m, s, { ApprovalThreshold: "300000" });
  assert.deepEqual(res, { ok: false, code: "NOT_LOOSER" });
});

test("ApprovalThreshold loosen - fails THRESHOLD_ABOVE_CAP when x > cap", () => {
  const m = baseMandate();
  const s = baseState(); // cap = 500_000
  const res = applyChange("loosen", m, s, { ApprovalThreshold: "500001" });
  assert.deepEqual(res, { ok: false, code: "THRESHOLD_ABOVE_CAP" });
});

// -------------------------------------------------------------
// 4. AddRecipient: tighten & loosen
// -------------------------------------------------------------
test("AddRecipient tighten - always fails NOT_STRICTER", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("tighten", m, s, { AddRecipient: "new.near" });
  assert.deepEqual(res, { ok: false, code: "NOT_STRICTER" });
});

test("AddRecipient loosen - passes for new valid recipient under limit", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("loosen", m, s, { AddRecipient: "new.near" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.mandate.recipients, ["merchant.near", "vendor.near", "new.near"]);
  }
});

test("AddRecipient loosen - fails DUPLICATE_RECIPIENT when already present", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("loosen", m, s, { AddRecipient: "merchant.near" });
  assert.deepEqual(res, { ok: false, code: "DUPLICATE_RECIPIENT" });
});

test("AddRecipient loosen - fails TOO_MANY_RECIPIENTS when at MAX_RECIPIENTS (16)", () => {
  const m = {
    ...baseMandate(),
    recipients: Array.from({ length: MAX_RECIPIENTS }, (_, i) => `user${i}.near`),
  };
  const s = baseState();
  const res = applyChange("loosen", m, s, { AddRecipient: "extra.near" });
  assert.deepEqual(res, { ok: false, code: "TOO_MANY_RECIPIENTS" });
});

test("AddRecipient loosen - fails INVALID_RECIPIENT on invalid name", () => {
  const m = baseMandate();
  const s = baseState();
  const resEmpty = applyChange("loosen", m, s, { AddRecipient: "" });
  assert.deepEqual(resEmpty, { ok: false, code: "INVALID_RECIPIENT" });

  const resUppercase = applyChange("loosen", m, s, { AddRecipient: "INVALID.NEAR" });
  assert.deepEqual(resUppercase, { ok: false, code: "INVALID_RECIPIENT" });
});

// -------------------------------------------------------------
// 5. RemoveRecipient: tighten & loosen
// -------------------------------------------------------------
test("RemoveRecipient tighten - passes when recipient exists in list", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("tighten", m, s, { RemoveRecipient: "merchant.near" });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.deepEqual(res.mandate.recipients, ["vendor.near"]);
  }
});

test("RemoveRecipient tighten - fails NO_SUCH_RECIPIENT when absent", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("tighten", m, s, { RemoveRecipient: "stranger.near" });
  assert.deepEqual(res, { ok: false, code: "NO_SUCH_RECIPIENT" });
});

test("RemoveRecipient loosen - always fails NOT_LOOSER", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("loosen", m, s, { RemoveRecipient: "merchant.near" });
  assert.deepEqual(res, { ok: false, code: "NOT_LOOSER" });
});

// -------------------------------------------------------------
// 6. Expiry: tighten & loosen
// -------------------------------------------------------------
test("Expiry tighten - passes when now < t < expiry", () => {
  const m = baseMandate(); // expiresAtMs = 1_800_000_000_000
  const s = baseState();   // nowMs = 1_700_000_000_000
  const res = applyChange("tighten", m, s, { Expiry: 1_750_000_000_000 });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.mandate.expiresAtMs, 1_750_000_000_000);
  }
});

test("Expiry tighten - fails NOT_STRICTER when t >= expiry", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("tighten", m, s, { Expiry: 1_800_000_000_000 });
  assert.deepEqual(res, { ok: false, code: "NOT_STRICTER" });
});

test("Expiry tighten - fails EXPIRY_NOT_IN_FUTURE when t <= now", () => {
  const m = baseMandate();
  const s = baseState(); // nowMs = 1_700_000_000_000
  const res = applyChange("tighten", m, s, { Expiry: 1_700_000_000_000 });
  assert.deepEqual(res, { ok: false, code: "EXPIRY_NOT_IN_FUTURE" });

  const resPast = applyChange("tighten", m, s, { Expiry: 1_600_000_000_000 });
  assert.deepEqual(resPast, { ok: false, code: "EXPIRY_NOT_IN_FUTURE" });
});

test("Expiry loosen - passes when t > expiry", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("loosen", m, s, { Expiry: 1_900_000_000_000 });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.mandate.expiresAtMs, 1_900_000_000_000);
  }
});

test("Expiry loosen - fails NOT_LOOSER when t <= expiry", () => {
  const m = baseMandate();
  const s = baseState();
  const resEqual = applyChange("loosen", m, s, { Expiry: 1_800_000_000_000 });
  assert.deepEqual(resEqual, { ok: false, code: "NOT_LOOSER" });

  const resLess = applyChange("loosen", m, s, { Expiry: 1_750_000_000_000 });
  assert.deepEqual(resLess, { ok: false, code: "NOT_LOOSER" });
});

// -------------------------------------------------------------
// Alternative discriminated union format support & bigint amounts
// -------------------------------------------------------------
test("Supports discriminated union format and BigInt inputs", () => {
  const m = baseMandate();
  const s = baseState();
  const res = applyChange("tighten", m, s, { type: "Budget", value: BigInt(600000) });
  assert.equal(res.ok, true);
  if (res.ok) {
    assert.equal(res.mandate.budget, "600000");
  }
});
