import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, MAX_OPEN, U128_MAX } from "../src/lib/rules.ts";

function baseMandate(overrides = {}) {
  return {
    id: 1,
    status: "Active",
    expiresAtMs: 2_000_000_000_000,
    recipients: ["merchant.testnet"],
    perPaymentCap: "500000", // 0.50 USDC
    budget: "1000000", // 1.00 USDC
    approvalThreshold: "350000", // 0.35 USDC
    ...overrides,
  };
}

function baseState(overrides = {}) {
  return {
    deposited: "1000000",
    spent: "0",
    reserved: "0",
    withdrawn: "0",
    openRequests: 0,
    nowMs: 1_800_000_000_000,
    approvals: [],
    ...overrides,
  };
}

function baseRequest(overrides = {}) {
  return {
    recipient: "merchant.testnet",
    amount: "200000", // 0.20 USDC
    nonce: 1,
    ...overrides,
  };
}

test("allows a valid payment within allowlist, cap, budget, and approval threshold", () => {
  const res = evaluate(baseMandate(), baseState(), baseRequest());
  assert.deepEqual(res, { ok: true });
});

test("rejects with NOT_ACTIVE when mandate status is Revoked", () => {
  const res = evaluate(
    baseMandate({ status: "Revoked" }),
    baseState(),
    baseRequest(),
  );
  assert.deepEqual(res, { ok: false, code: "NOT_ACTIVE" });
});

test("rejects with EXPIRED when nowMs >= expiresAtMs", () => {
  const res = evaluate(
    baseMandate({ expiresAtMs: 1_800_000_000_000 }),
    baseState({ nowMs: 1_800_000_000_000 }),
    baseRequest(),
  );
  assert.deepEqual(res, { ok: false, code: "EXPIRED" });
});

test("rejects with RECIPIENT_NOT_ALLOWED when recipient is not on allowlist", () => {
  const res = evaluate(
    baseMandate(),
    baseState(),
    baseRequest({ recipient: "dmx42992.envtest-theo-1747.testnet" }),
  );
  assert.deepEqual(res, { ok: false, code: "RECIPIENT_NOT_ALLOWED" });
});

test("rejects with OVER_PER_PAYMENT_CAP when amount exceeds cap", () => {
  const res = evaluate(
    baseMandate(),
    baseState(),
    baseRequest({ amount: "600000" }),
  );
  assert.deepEqual(res, { ok: false, code: "OVER_PER_PAYMENT_CAP" });
});

test("rejects with OVER_PER_PAYMENT_CAP when amount is zero", () => {
  const res = evaluate(
    baseMandate(),
    baseState(),
    baseRequest({ amount: "0" }),
  );
  assert.deepEqual(res, { ok: false, code: "OVER_PER_PAYMENT_CAP" });
});

test("rejects with TOO_MANY_OPEN when openRequests reaches MAX_OPEN (32)", () => {
  const res = evaluate(
    baseMandate(),
    baseState({ openRequests: MAX_OPEN }),
    baseRequest(),
  );
  assert.deepEqual(res, { ok: false, code: "TOO_MANY_OPEN" });
});

test("rejects with OVER_BUDGET when spent + reserved + amount exceeds budget", () => {
  const res = evaluate(
    baseMandate(),
    baseState({ spent: "700000", reserved: "150000" }),
    baseRequest({ amount: "200000" }),
  );
  assert.deepEqual(res, { ok: false, code: "OVER_BUDGET" });
});

test("rejects with OVER_BUDGET when amount exceeds deposited funds even if below budget", () => {
  const res = evaluate(
    baseMandate({ budget: "1000000" }),
    baseState({ deposited: "150000", spent: "0" }),
    baseRequest({ amount: "200000" }),
  );
  assert.deepEqual(res, { ok: false, code: "OVER_BUDGET" });
});

test("rejects with OVER_BUDGET on u128 addition overflow", () => {
  const res = evaluate(
    baseMandate({
      perPaymentCap: U128_MAX.toString(),
      budget: U128_MAX.toString(),
      approvalThreshold: U128_MAX.toString(),
    }),
    baseState({
      deposited: U128_MAX.toString(),
      spent: U128_MAX.toString(),
    }),
    baseRequest({ amount: "1" }),
  );
  assert.deepEqual(res, { ok: false, code: "OVER_BUDGET" });
});

test("rejects with NEEDS_APPROVAL when amount > approvalThreshold without matching approval", () => {
  const res = evaluate(
    baseMandate(),
    baseState(),
    baseRequest({ amount: "450000", nonce: 7 }),
  );
  assert.deepEqual(res, { ok: false, code: "NEEDS_APPROVAL" });
});

test("rejects with APPROVAL_USED when matching approval was already consumed", () => {
  const res = evaluate(
    baseMandate(),
    baseState({
      approvals: [
        {
          mandateId: 1,
          recipient: "merchant.testnet",
          amount: "450000",
          nonce: 7,
          mandateExpiresAtMs: 2_000_000_000_000,
          expiresAtMs: 1_900_000_000_000,
          used: true,
        },
      ],
    }),
    baseRequest({ amount: "450000", nonce: 7 }),
  );
  assert.deepEqual(res, { ok: false, code: "APPROVAL_USED" });
});

test("rejects with APPROVAL_EXPIRED when matching approval has expired", () => {
  const res = evaluate(
    baseMandate(),
    baseState({
      nowMs: 1_900_000_000_000,
      approvals: [
        {
          mandateId: 1,
          recipient: "merchant.testnet",
          amount: "450000",
          nonce: 7,
          mandateExpiresAtMs: 2_000_000_000_000,
          expiresAtMs: 1_900_000_000_000,
          used: false,
        },
      ],
    }),
    baseRequest({ amount: "450000", nonce: 7 }),
  );
  assert.deepEqual(res, { ok: false, code: "APPROVAL_EXPIRED" });
});

test("allows payment above approvalThreshold with unused unexpired matching approval", () => {
  const res = evaluate(
    baseMandate(),
    baseState({
      approvals: [
        {
          mandateId: 1,
          recipient: "merchant.testnet",
          amount: "450000",
          nonce: 7,
          mandateExpiresAtMs: 2_000_000_000_000,
          expiresAtMs: 1_900_000_000_000,
          used: false,
        },
      ],
    }),
    baseRequest({ amount: "450000", nonce: 7 }),
  );
  assert.deepEqual(res, { ok: true });
});

test("enforces exact contract check precedence when multiple rules fail at once", () => {
  // Revoked + expired + wrong recipient + over cap + over budget -> NOT_ACTIVE wins first
  assert.deepEqual(
    evaluate(
      baseMandate({ status: "Revoked", expiresAtMs: 100 }),
      baseState({ nowMs: 200, spent: "1000000", openRequests: MAX_OPEN }),
      baseRequest({ recipient: "evil.testnet", amount: "900000" }),
    ),
    { ok: false, code: "NOT_ACTIVE" },
  );

  // Active, but expired + wrong recipient + over cap -> EXPIRED wins second
  assert.deepEqual(
    evaluate(
      baseMandate({ expiresAtMs: 100 }),
      baseState({ nowMs: 200, spent: "1000000" }),
      baseRequest({ recipient: "evil.testnet", amount: "900000" }),
    ),
    { ok: false, code: "EXPIRED" },
  );

  // Active & not expired, wrong recipient + over cap + over budget -> RECIPIENT_NOT_ALLOWED wins third
  assert.deepEqual(
    evaluate(
      baseMandate(),
      baseState({ spent: "1000000" }),
      baseRequest({ recipient: "evil.testnet", amount: "900000" }),
    ),
    { ok: false, code: "RECIPIENT_NOT_ALLOWED" },
  );

  // Allowed recipient, over cap + over budget -> OVER_PER_PAYMENT_CAP wins fourth
  assert.deepEqual(
    evaluate(
      baseMandate(),
      baseState({ spent: "1000000" }),
      baseRequest({ amount: "900000" }),
    ),
    { ok: false, code: "OVER_PER_PAYMENT_CAP" },
  );
});
