// Run: node --test src/lib/mandate-map.test.mjs   (Node strips the types of the .ts import)
import test from "node:test";
import assert from "node:assert/strict";
import { mapMandateView, MandateMapError } from "./mandate-map.ts";

function validView() {
  return {
    owner: "owner.testnet",
    agent: "agent.testnet",
    guardian: "guardian.testnet",
    token: "usdc.testnet",
    deposited: "50000000",
    budget: "50000000",
    spent: "1500000",
    reserved: "250000",
    withdrawn: "0",
    per_payment_cap: "2000000",
    approval_threshold: "1000000",
    expires_at_ms: 1893456000000,
    recipients: ["shop.testnet", "api.testnet"],
    status: "Active",
    open_requests: 1,
    next_request_id: 7,
  };
}

test("maps a valid snake_case view to the camelCase Mandate", () => {
  const m = mapMandateView(validView(), 3);
  assert.deepEqual(m, {
    id: 3,
    owner: "owner.testnet",
    guardian: "guardian.testnet",
    agent: "agent.testnet",
    token: "usdc.testnet",
    deposited: "50000000",
    budget: "50000000",
    spent: "1500000",
    reserved: "250000",
    withdrawn: "0",
    perPaymentCap: "2000000",
    approvalThreshold: "1000000",
    expiresAtMs: 1893456000000,
    status: "Active",
    openRequests: 1,
    recipients: ["shop.testnet", "api.testnet"],
  });
});

test("maps status Revoked", () => {
  const m = mapMandateView({ ...validView(), status: "Revoked" }, 0);
  assert.equal(m.status, "Revoked");
  assert.equal(m.id, 0);
});

test("rejects an unknown status", () => {
  assert.throws(
    () => mapMandateView({ ...validView(), status: "Paused" }, 0),
    (e) => e instanceof MandateMapError && e.field === "status",
  );
});

test("throws a typed error naming the missing field", () => {
  for (const field of Object.keys(validView()).filter((k) => k !== "next_request_id")) {
    const raw = validView();
    delete raw[field];
    assert.throws(
      () => mapMandateView(raw, 0),
      (e) => e instanceof MandateMapError && e.field === field,
      `missing ${field}`,
    );
  }
});

test("does not require next_request_id (not part of Mandate)", () => {
  const raw = validView();
  delete raw.next_request_id;
  assert.doesNotThrow(() => mapMandateView(raw, 0));
});

test("rejects non-canonical amounts instead of coercing", () => {
  const bad = ["01", "-1", "1.5", "1e6", " 5", "0x10", "", "12a", 5, null, "340282366920938463463374607431768211456"];
  for (const value of bad) {
    assert.throws(
      () => mapMandateView({ ...validView(), spent: value }, 0),
      (e) => e instanceof MandateMapError && e.field === "spent",
      `amount ${JSON.stringify(value)}`,
    );
  }
});

test("accepts the u128 maximum and zero", () => {
  const max = "340282366920938463463374607431768211455";
  const m = mapMandateView({ ...validView(), budget: max, spent: "0" }, 0);
  assert.equal(m.budget, max);
  assert.equal(m.spent, "0");
});

test("rejects a non-object view and bad ids", () => {
  for (const raw of [null, undefined, "x", 5, [], true]) {
    assert.throws(() => mapMandateView(raw, 0), MandateMapError);
  }
  assert.throws(() => mapMandateView(validView(), -1), MandateMapError);
  assert.throws(() => mapMandateView(validView(), 1.5), MandateMapError);
});

test("rejects malformed accounts, recipients and counters", () => {
  assert.throws(() => mapMandateView({ ...validView(), agent: "" }, 0), MandateMapError);
  assert.throws(() => mapMandateView({ ...validView(), agent: "<script>" }, 0), MandateMapError);
  assert.throws(() => mapMandateView({ ...validView(), recipients: "a.testnet" }, 0), MandateMapError);
  assert.throws(() => mapMandateView({ ...validView(), recipients: ["ok.testnet", 3] }, 0), MandateMapError);
  assert.throws(() => mapMandateView({ ...validView(), open_requests: -1 }, 0), MandateMapError);
  assert.throws(() => mapMandateView({ ...validView(), open_requests: "1" }, 0), MandateMapError);
  assert.throws(() => mapMandateView({ ...validView(), expires_at_ms: 1.5 }, 0), MandateMapError);
});
