// Order of checks in rules.ts must follow request_payment in contracts/scrip/src/lib.rs
// (steps 2-7: status, expiry, recipient, per-payment cap, open requests, budget, approval).
import test from "node:test";
import assert from "node:assert/strict";
import { evaluate, MAX_OPEN } from "./rules.ts";

const NOW = 1_800_000_000_000;
const base = () => ({
  mandate: {
    id: 1, status: "Active", expiresAtMs: NOW + 1000, recipients: ["shop.testnet"],
    perPaymentCap: "400000", budget: "1000000", approvalThreshold: "250000",
  },
  state: { deposited: "1500000", spent: "0", reserved: "0", withdrawn: "0", openRequests: 0, nowMs: NOW, approvals: [] },
  req: { recipient: "shop.testnet", amount: "100000", nonce: 7 },
});
const run = (m, s, r) => evaluate(m, s, r);

test("a clean request inside every limit passes", () => {
  const { mandate, state, req } = base();
  assert.deepEqual(run(mandate, state, req), { ok: true });
});

test("status is checked before expiry", () => {
  const { mandate, state, req } = base();
  assert.equal(run({ ...mandate, status: "Revoked", expiresAtMs: NOW - 1 }, state, req).code, "NOT_ACTIVE");
});

test("expiry is checked before recipient (now >= expires is expired)", () => {
  const { mandate, state, req } = base();
  const r = run({ ...mandate, expiresAtMs: NOW }, state, { ...req, recipient: "evil.testnet" });
  assert.equal(r.code, "EXPIRED");
});

test("recipient is checked before the per-payment cap", () => {
  const { mandate, state, req } = base();
  assert.equal(run(mandate, state, { ...req, recipient: "evil.testnet", amount: "999999999" }).code, "RECIPIENT_NOT_ALLOWED");
});

test("per-payment cap is checked before open requests and budget; zero is over the cap", () => {
  const { mandate, state, req } = base();
  const crowded = { ...state, openRequests: MAX_OPEN, spent: "1000000" };
  assert.equal(run(mandate, crowded, { ...req, amount: "400001" }).code, "OVER_PER_PAYMENT_CAP");
  assert.equal(run(mandate, state, { ...req, amount: "0" }).code, "OVER_PER_PAYMENT_CAP");
  assert.equal(run(mandate, state, { ...req, amount: "400000", nonce: 1 }).code, "NEEDS_APPROVAL");
});

test("open-request limit is checked before the budget", () => {
  const { mandate, state, req } = base();
  const s = { ...state, openRequests: MAX_OPEN, spent: "1000000" };
  assert.equal(run(mandate, s, req).code, "TOO_MANY_OPEN");
});

test("budget counts spent + reserved + amount against min(budget, deposited - withdrawn)", () => {
  const { mandate, state, req } = base();
  assert.equal(run(mandate, { ...state, spent: "900000", reserved: "0" }, req).ok, true);
  assert.equal(run(mandate, { ...state, spent: "800000", reserved: "101000" }, req).code, "OVER_BUDGET");
  assert.equal(run(mandate, { ...state, deposited: "1100000", withdrawn: "1000001" }, req).code, "OVER_BUDGET");
});

test("budget is checked before approval", () => {
  const { mandate, state, req } = base();
  const r = run(mandate, { ...state, spent: "900000" }, { ...req, amount: "300000" });
  assert.equal(r.code, "OVER_BUDGET");
});

test("amount above the threshold needs an approval bound to recipient, amount and nonce", () => {
  const { mandate, state, req } = base();
  const big = { ...req, amount: "300000" };
  assert.equal(run(mandate, state, big).code, "NEEDS_APPROVAL");
  const ok = { recipient: "shop.testnet", amount: "300000", nonce: 7, expiresAtMs: NOW + 500, used: false };
  assert.equal(run(mandate, { ...state, approvals: [ok] }, big).ok, true);
  assert.equal(run(mandate, { ...state, approvals: [{ ...ok, nonce: 8 }] }, big).code, "NEEDS_APPROVAL");
  assert.equal(run(mandate, { ...state, approvals: [{ ...ok, amount: "300001" }] }, big).code, "NEEDS_APPROVAL");
  assert.equal(run(mandate, { ...state, approvals: [{ ...ok, used: true }] }, big).code, "APPROVAL_USED");
  assert.equal(run(mandate, { ...state, approvals: [{ ...ok, expiresAtMs: NOW }] }, big).code, "APPROVAL_EXPIRED");
});

test("MAX_OPEN matches the contract constant (32)", () => {
  assert.equal(MAX_OPEN, 32);
});
