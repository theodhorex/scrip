import test from "node:test";
import assert from "node:assert/strict";
import { parseScripEvents } from "./live-events.ts";

const log = (event, data) => `EVENT_JSON:${JSON.stringify({ standard: "scrip", version: "1.0.0", event, data: [data] })}`;
const body = {
  transactions: [
    { transaction: { hash: "TX1" }, receipts: [
      { execution_outcome: { block_timestamp: "1794562158842069274", outcome: { logs: [log("reserved", { mandate_id: 1, recipient: "shop.testnet", amount: "10000", request_id: 1 })] } } },
      { execution_outcome: { block_timestamp: "1794562159461854605", outcome: { logs: ['EVENT_JSON:{"standard":"nep141","event":"ft_transfer","data":[]}'] } } },
      { execution_outcome: { block_timestamp: "1794562160141285623", outcome: { logs: [log("settled", { mandate_id: 1, recipient: "shop.testnet", amount: "10000", request_id: 1 })] } } },
    ] },
    { transaction: { hash: "TX2" }, receipts: [
      { execution_outcome: { block_timestamp: "1794562162575448557", outcome: { logs: [log("rejected", { mandate_id: 1, recipient: "attacker.testnet", amount: "10000", code: "RECIPIENT_NOT_ALLOWED" }), "plain log", "EVENT_JSON:{broken"] } } },
    ] },
    { transaction: { hash: "TX3" }, receipts: [
      { execution_outcome: { block_timestamp: "1794562170000000000", outcome: { logs: [log("rejected", { mandate_id: 2, recipient: "x.testnet", amount: "1", code: "OVER_BUDGET" })] } } },
    ] },
  ],
};

test("parses scrip events for one mandate, newest first, with tx hash and time", () => {
  const ev = parseScripEvents(body, 1);
  assert.deepEqual(ev.map((e) => e.name), ["rejected", "settled", "reserved"]);
  assert.equal(ev[0].code, "RECIPIENT_NOT_ALLOWED");
  assert.equal(ev[0].txHash, "TX2");
  assert.equal(ev[1].requestId, 1);
  assert.equal(ev[2].atMs, 1794562158842);
});

test("skips other mandates, other standards and malformed input", () => {
  assert.equal(parseScripEvents(body, 2).length, 1);
  assert.deepEqual(parseScripEvents(null, 1), []);
  assert.deepEqual(parseScripEvents({ transactions: "x" }, 1), []);
});
