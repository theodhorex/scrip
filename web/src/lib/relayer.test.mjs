import { test } from "node:test";
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { KeyPair, KeyPairSigner, buildDelegateAction, actions, encodeSignedDelegate } from "near-api-js";
import { createHostedRelayer, toResponse } from "./relayer/hosted.mjs";
import { createDedupeStore } from "./relayer/store.mjs";

const HERE = dirname(fileURLToPath(import.meta.url));
const CONTRACT = "live-scrip.envtest-theo-1747.testnet";
const AGENT = "scrip-agent-abc.owner.testnet";

test("vendored relayer modules are byte-identical to facilitator/src", () => {
  for (const f of ["validate", "policy", "keycheck", "relay", "inner_status", "ratelimit"]) {
    const ours = readFileSync(join(HERE, "relayer", `${f}.mjs`));
    const theirs = readFileSync(join(HERE, "../../../facilitator/src", `${f}.mjs`));
    assert.ok(ours.equals(theirs), `${f}.mjs drifted from facilitator/src/${f}.mjs`);
  }
});

async function signed({ senderId = AGENT, receiverId = CONTRACT, mandateId = 3, nonce = 7n, maxBlockHeight = 1100n, keyPair = KeyPair.fromRandom("ed25519") } = {}) {
  const da = buildDelegateAction({
    senderId,
    receiverId,
    actions: [actions.functionCall("request_payment", { mandate_id: mandateId, recipient: "shop.testnet", amount: "10", nonce: 1 }, 80_000_000_000_000n, 0n)],
    nonce,
    maxBlockHeight,
    publicKey: keyPair.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(keyPair).signDelegateAction(da);
  return Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64");
}

function fakes({ mandates = { 3: { id: 3, agent: AGENT, status: "Active" } }, balance = 5n * 10n ** 24n } = {}) {
  const calls = { relay: 0, getMandate: 0 };
  const provider = {
    viewBlock: async () => ({ header: { height: 1000 } }),
    viewAccessKey: async () => ({ nonce: 0n, permission: { FunctionCall: { allowance: "250000000000000000000000", receiver_id: CONTRACT, method_names: ["request_payment"] } } }),
    callFunction: async ({ method, args }) => {
      if (method === "get_mandate") { calls.getMandate++; return mandates[args.id] ?? null; }
      return null;
    },
  };
  const relayerAccount = {
    accountId: "relay.envtest-theo-1747.testnet",
    relayMetaTransaction: async () => {
      calls.relay++;
      return { transaction: { hash: `tx${calls.relay}` }, status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: [], status: { SuccessValue: "" } } }] };
    },
  };
  const hosted = createHostedRelayer({ provider, relayerAccount, contractId: CONTRACT, minBalance: 10n ** 23n, relayerBalance: async () => balance });
  return { hosted, calls };
}

test("relays a delegate signed by the mandate's own agent", async () => {
  const { hosted, calls } = fakes();
  const r = await hosted.relay(await signed());
  assert.equal(r.ok, true, JSON.stringify(r));
  assert.equal(r.txHash, "tx1");
  assert.equal(calls.relay, 1);
  const res = toResponse(r);
  assert.equal(res.status, 200);
  assert.equal(res.body.tx_hash, "tx1");
  assert.equal(res.body.outer_tx_succeeded, true);
});

test("refuses a sender that is not the mandate's agent, without spending gas", async () => {
  const { hosted, calls } = fakes();
  const r = await hosted.relay(await signed({ senderId: "attacker.testnet" }));
  assert.equal(r.code, "AGENT_NOT_ALLOWED");
  assert.equal(calls.relay, 0);
  assert.equal(toResponse(r).status, 400);
});

test("refuses an unknown mandate and a foreign contract", async () => {
  const { hosted, calls } = fakes();
  assert.equal((await hosted.relay(await signed({ mandateId: 99 }))).code, "MANDATE_NOT_FOUND");
  assert.equal((await hosted.relay(await signed({ receiverId: "other.testnet" }))).code, "WRONG_RECEIVER");
  assert.equal((await hosted.relay("not base64!")).code, "BAD_ENCODING");
  assert.equal(calls.relay, 0);
});

test("the facilitator checks still run behind the gate: duplicate, expiry, nonce, balance", async () => {
  const { hosted, calls } = fakes();
  const b64 = await signed();
  assert.equal((await hosted.relay(b64)).ok, true);
  const dup = await hosted.relay(b64);
  assert.equal(dup.code, "DUPLICATE_DELEGATE");
  assert.equal(toResponse(dup).status, 409);
  assert.equal((await hosted.relay(await signed({ maxBlockHeight: 5000n }))).code, "EXPIRES_TOO_FAR");
  assert.equal((await hosted.relay(await signed({ nonce: 0n }))).code, "NONCE_INVALID");
  assert.equal(calls.relay, 1);

  const poor = fakes({ balance: 10n ** 22n });
  const low = await poor.hosted.relay(await signed());
  assert.equal(low.code, "RELAYER_LOW_BALANCE");
  assert.equal(toResponse(low).status, 503);
  assert.equal(poor.calls.relay, 0);
});

test("mandate lookups are cached briefly", async () => {
  const { hosted, calls } = fakes();
  await hosted.relay(await signed());
  await hosted.relay(await signed({ nonce: 8n }));
  assert.equal(calls.getMandate, 1);
});

test("in-memory dedupe store keeps the facilitator store interface", () => {
  const s = createDedupeStore();
  s.set("a", 10n, null, "PENDING", () => 1);
  s.set("a", 99n, "x", "FINAL", () => 2); // first write wins, like ON CONFLICT DO NOTHING
  assert.equal(s.get("a").maxBlockHeight, 10n);
  s.update("a", "tx", "FINAL");
  assert.equal(s.getByTxHash("tx").hash, "a");
  s.set("b", 20n, null, "PENDING", () => 3, 1);
  assert.equal(s.size(), 1);
  assert.equal(s.get("a"), null);
  s.prune(21);
  assert.equal(s.size(), 0);
});
