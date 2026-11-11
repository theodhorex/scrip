// K-A rules in `tighten` (contracts/scrip/src/lib.rs): budget may not drop below the per-payment cap,
// and the cap may not drop below the approval threshold. Check order: NOT_STRICTER, then committed, then cap.
import test from "node:test";
import assert from "node:assert/strict";
import { applyChange } from "./guardian.ts";

const m = () => ({ status: "Active", budget: "1000000", perPaymentCap: "400000", approvalThreshold: "250000", expiresAtMs: 2_000_000_000_000, recipients: ["shop.testnet"] });
const s = { deposited: "1500000", spent: "200000", reserved: "0", nowMs: 1_800_000_000_000 };

test("tighten Budget below the per-payment cap is BUDGET_BELOW_CAP", () => {
  assert.deepEqual(applyChange("tighten", m(), s, { Budget: "300000" }), { ok: false, code: "BUDGET_BELOW_CAP" });
});
test("tighten Budget below committed stays BUDGET_BELOW_COMMITTED (checked first)", () => {
  assert.equal(applyChange("tighten", m(), s, { Budget: "100000" }).code, "BUDGET_BELOW_COMMITTED");
});
test("tighten Budget to exactly the cap is allowed", () => {
  assert.equal(applyChange("tighten", m(), s, { Budget: "400000" }).ok, true);
});
test("tighten PerPaymentCap below the approval threshold is CAP_BELOW_THRESHOLD", () => {
  assert.deepEqual(applyChange("tighten", m(), s, { PerPaymentCap: "200000" }), { ok: false, code: "CAP_BELOW_THRESHOLD" });
});
test("tighten PerPaymentCap to exactly the threshold is allowed", () => {
  assert.equal(applyChange("tighten", m(), s, { PerPaymentCap: "250000" }).ok, true);
});
test("NOT_STRICTER is still checked before the K-A rules", () => {
  assert.equal(applyChange("tighten", m(), s, { PerPaymentCap: "400000" }).code, "NOT_STRICTER");
});
