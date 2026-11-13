import test from "node:test";
import assert from "node:assert/strict";
import {
  classifyRpcResponse,
  compareClaim,
  fetchAndVerifyTx,
  extractVerificationItems,
  runWithConcurrencyLimit,
  decodeRejection,
  indexerToRpcBody,
} from "./verify-tx.ts";

test("classifyRpcResponse: classifies SuccessValue as SUCCESS", () => {
  const rpcResponse = {
    result: {
      status: { SuccessValue: "" },
      transaction_outcome: { outcome: { status: { SuccessReceiptId: "rec1" } } },
      receipts_outcome: [
        { outcome: { status: { SuccessValue: "" }, logs: [] } },
      ],
    },
  };
  const res = classifyRpcResponse(rpcResponse);
  assert.equal(res.type, "SUCCESS");
});

test("classifyRpcResponse: classifies Failure in receipt as FAILURE with error code", () => {
  const rpcResponse = {
    result: {
      status: { SuccessReceiptId: "rec1" },
      receipts_outcome: [
        {
          outcome: {
            status: {
              Failure: {
                ActionError: {
                  kind: {
                    FunctionCallError: {
                      ExecutionError: "Smart contract panicked: panicked at 'RECIPIENT_NOT_ALLOWED', contracts/scrip/src/lib.rs:88:9",
                    },
                  },
                },
              },
            },
            logs: [],
          },
        },
      ],
    },
  };
  const res = classifyRpcResponse(rpcResponse);
  assert.equal(res.type, "FAILURE");
  assert.equal(res.errorCode, "RECIPIENT_NOT_ALLOWED");
});

test("classifyRpcResponse: classifies top-level Failure as FAILURE with error code", () => {
  const rpcResponse = {
    result: {
      status: {
        Failure: {
          ActionError: {
            kind: {
              FunctionCallError: {
                ExecutionError: "panicked at 'OVER_PER_PAYMENT_CAP'",
              },
            },
          },
        },
      },
    },
  };
  const res = classifyRpcResponse(rpcResponse);
  assert.equal(res.type, "FAILURE");
  assert.equal(res.errorCode, "OVER_PER_PAYMENT_CAP");
});

test("classifyRpcResponse: classifies RPC error (not found) as UNVERIFIABLE", () => {
  const rpcResponse = {
    error: {
      code: -32000,
      message: "Server error",
      data: "Transaction EcfK... doesn't exist",
    },
  };
  const res = classifyRpcResponse(rpcResponse);
  assert.equal(res.type, "UNVERIFIABLE");
  assert.match(res.reason, /Transaction.*doesn't exist|Server error/);
});

test("classifyRpcResponse: classifies malformed response as UNVERIFIABLE", () => {
  assert.equal(classifyRpcResponse(null).type, "UNVERIFIABLE");
  assert.equal(classifyRpcResponse({}).type, "UNVERIFIABLE");
  assert.equal(classifyRpcResponse({ result: null }).type, "UNVERIFIABLE");
});

test("compareClaim: SUCCESS matches expected success", () => {
  const verdict = compareClaim({ type: "SUCCESS" }, { expectedSuccess: true });
  assert.equal(verdict.verdict, "VERIFIED");
});

test("compareClaim: SUCCESS mismatches expected failure", () => {
  const verdict = compareClaim(
    { type: "SUCCESS" },
    { expectedSuccess: false, expectedErrorCode: "RECIPIENT_NOT_ALLOWED" },
  );
  assert.equal(verdict.verdict, "MISMATCHED");
});

test("compareClaim: FAILURE matches expected failure with same error code", () => {
  const verdict = compareClaim(
    { type: "FAILURE", errorCode: "RECIPIENT_NOT_ALLOWED" },
    { expectedSuccess: false, expectedErrorCode: "RECIPIENT_NOT_ALLOWED" },
  );
  assert.equal(verdict.verdict, "VERIFIED");
});

test("compareClaim: FAILURE mismatches different expected error code", () => {
  const verdict = compareClaim(
    { type: "FAILURE", errorCode: "OVER_PER_PAYMENT_CAP" },
    { expectedSuccess: false, expectedErrorCode: "RECIPIENT_NOT_ALLOWED" },
  );
  assert.equal(verdict.verdict, "MISMATCHED");
});

test("compareClaim: FAILURE mismatches expected success", () => {
  const verdict = compareClaim(
    { type: "FAILURE", errorCode: "OVER_PER_PAYMENT_CAP" },
    { expectedSuccess: true },
  );
  assert.equal(verdict.verdict, "MISMATCHED");
});

test("compareClaim: UNVERIFIABLE always yields UNVERIFIABLE verdict", () => {
  const verdict = compareClaim(
    { type: "UNVERIFIABLE", reason: "RPC error" },
    { expectedSuccess: true },
  );
  assert.equal(verdict.verdict, "UNVERIFIABLE");
});

test("fetchAndVerifyTx: missing sender returns UNVERIFIABLE without calling fetch", async () => {
  let called = false;
  const fakeFetch = async () => {
    called = true;
    return new Response("{}");
  };

  const res = await fetchAndVerifyTx({
    txHash: "Ap3xT6w2RimLu1UkcdsjeBTKpDXgX9Pxr6SmnbreTEWY",
    senderId: undefined,
    fetchFn: fakeFetch,
  });

  assert.equal(called, false);
  assert.equal(res.verdict, "UNVERIFIABLE");
  assert.match(res.reason, /sender/i);
});

test("fetchAndVerifyTx: network error returns UNVERIFIABLE", async () => {
  const fakeFetch = async () => {
    throw new Error("getaddrinfo ENOTFOUND rpc.testnet.fastnear.com");
  };

  const res = await fetchAndVerifyTx({
    txHash: "9UpU5SNwVwasrD2thdMtyoh9vdTkBcgjWLKMM7xV3k78",
    senderId: "dma42992.envtest-theo-1747.testnet",
    claim: { expectedSuccess: true },
    fetchFn: fakeFetch,
  });

  assert.equal(res.verdict, "UNVERIFIABLE");
  assert.match(res.reason, /network|ENOTFOUND/i);
});

test("fetchAndVerifyTx: HTTP 429 returns UNVERIFIABLE", async () => {
  const fakeFetch = async () =>
    new Response("rate limited", { status: 429 });

  const res = await fetchAndVerifyTx({
    txHash: "9UpU5SNwVwasrD2thdMtyoh9vdTkBcgjWLKMM7xV3k78",
    senderId: "dma42992.envtest-theo-1747.testnet",
    fetchFn: fakeFetch,
  });

  assert.equal(res.verdict, "UNVERIFIABLE");
  assert.match(res.reason, /429/);
});

test("fetchAndVerifyTx: timeout returns UNVERIFIABLE", async () => {
  const fakeFetch = async () => {
    const err = new Error("The operation was aborted");
    err.name = "AbortError";
    throw err;
  };

  const res = await fetchAndVerifyTx({
    txHash: "9UpU5SNwVwasrD2thdMtyoh9vdTkBcgjWLKMM7xV3k78",
    senderId: "dma42992.envtest-theo-1747.testnet",
    fetchFn: fakeFetch,
  });

  assert.equal(res.verdict, "UNVERIFIABLE");
  assert.match(res.reason, /timed out|aborted/i);
});

test("fetchAndVerifyTx: successful verification matches claim", async () => {
  const fakeFetch = async () =>
    new Response(
      JSON.stringify({
        result: {
          status: { SuccessValue: "" },
          receipts_outcome: [],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );

  const res = await fetchAndVerifyTx({
    txHash: "9UpU5SNwVwasrD2thdMtyoh9vdTkBcgjWLKMM7xV3k78",
    senderId: "dma42992.envtest-theo-1747.testnet",
    claim: { expectedSuccess: true },
    fetchFn: fakeFetch,
  });

  assert.equal(res.verdict, "VERIFIED");
  assert.equal(res.classification.type, "SUCCESS");
});

test("extractVerificationItems: extracts demo and gate items with senders where known", () => {
  const items = extractVerificationItems();
  assert(items.length > 5, "should extract multiple items");

  const scripInjected = items.find(
    (x) => x.txHash === "4dAYztmoCoGoCVuS38gaJPM2sskVfpeW5YH6r2mFPHL5",
  );
  assert(scripInjected, "should find scrip injected item");
  assert.equal(scripInjected.senderId, "dma42992.envtest-theo-1747.testnet");
  assert.equal(scripInjected.claim.expectedSuccess, false);
  assert.equal(scripInjected.claim.expectedErrorCode, "RECIPIENT_NOT_ALLOWED");

  const deployItem = items.find(
    (x) => x.txHash === "Ap3xT6w2RimLu1UkcdsjeBTKpDXgX9Pxr6SmnbreTEWY",
  );
  assert(deployItem, "should find deploy item");
  assert.equal(deployItem.senderId, undefined);
});

test("runWithConcurrencyLimit: respects limit of 3 concurrent requests", async () => {
  let active = 0;
  let maxActive = 0;
  const items = [1, 2, 3, 4, 5, 6, 7];

  const results = await runWithConcurrencyLimit(items, 3, async (num) => {
    active++;
    if (active > maxActive) maxActive = active;
    await new Promise((r) => setTimeout(r, 20));
    active--;
    return num * 10;
  });

  assert.equal(results.length, 7);
  assert.deepEqual(results, [10, 20, 30, 40, 50, 60, 70]);
  assert(maxActive <= 3, `Expected maxActive <= 3, got ${maxActive}`);
});

const rejectedValue = Buffer.from(JSON.stringify({ Rejected: { code: "RECIPIENT_NOT_ALLOWED" } })).toString("base64");
const HASH = "4dAYztmoCoGoCVuS38gaJPM2sskVfpeW5YH6r2mFPHL5";

test("decodeRejection: reads Rejected code from SuccessValue and from the rejected event", () => {
  assert.equal(decodeRejection({ status: { SuccessValue: rejectedValue } }), "RECIPIENT_NOT_ALLOWED");
  assert.equal(
    decodeRejection({ status: { SuccessValue: "" }, logs: ['EVENT_JSON:{"event":"rejected","data":[{"code":"OVER_BUDGET"}]}'] }),
    "OVER_BUDGET",
  );
  assert.equal(decodeRejection({ status: { SuccessValue: "" }, logs: [] }), undefined);
  assert.equal(decodeRejection({ status: { SuccessValue: Buffer.from("not json").toString("base64") } }), undefined);
});

test("classifyRpcResponse: a Scrip refusal (successful receipt carrying Rejected) is a FAILURE with its code", () => {
  const out = classifyRpcResponse({
    result: { status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { status: { SuccessValue: rejectedValue }, logs: [] } }] },
  });
  assert.deepEqual(out, { type: "FAILURE", errorCode: "RECIPIENT_NOT_ALLOWED", rawError: "Rejected(RECIPIENT_NOT_ALLOWED)" });
});

test("indexerToRpcBody: unknown hash and empty list are reported, known hash is converted", () => {
  assert.ok(indexerToRpcBody({ transactions: [] }, HASH).reason);
  assert.ok(indexerToRpcBody(null, HASH).reason);
  const ok = indexerToRpcBody(
    { transactions: [{ execution_outcome: { id: HASH, outcome: { status: { SuccessReceiptId: "r" } } }, receipts: [{ execution_outcome: { outcome: { status: { SuccessValue: rejectedValue } } } }] }] },
    HASH,
  );
  assert.equal(classifyRpcResponse(ok.body).errorCode, "RECIPIENT_NOT_ALLOWED");
});

function indexerResponse(status) {
  return {
    ok: true,
    status: 200,
    json: async () => ({ transactions: [{ execution_outcome: { id: HASH, outcome: { status: { SuccessReceiptId: "r" } } }, receipts: [{ execution_outcome: { outcome: { status } } }] }] }),
  };
}

test("fetchAndVerifyTx: indexer answers without a sender account and the RPC is never called", async () => {
  const calls = [];
  const fetchFn = async (url) => { calls.push(String(url)); return indexerResponse({ SuccessValue: rejectedValue }); };
  const res = await fetchAndVerifyTx({
    txHash: HASH,
    claim: { expectedSuccess: false, expectedErrorCode: "RECIPIENT_NOT_ALLOWED" },
    indexerUrl: "https://indexer.test/v0/transactions",
    rpcUrl: "https://rpc.test",
    fetchFn,
  });
  assert.equal(res.verdict, "VERIFIED");
  assert.equal(res.source, "indexer");
  assert.deepEqual(calls, ["https://indexer.test/v0/transactions"]);
});

test("fetchAndVerifyTx: indexer failure falls back to the RPC when a sender is known", async () => {
  const calls = [];
  const fetchFn = async (url) => {
    calls.push(String(url));
    if (String(url).includes("indexer")) return { ok: false, status: 429, json: async () => ({}) };
    return { ok: true, status: 200, json: async () => ({ result: { status: { SuccessValue: "" }, receipts_outcome: [] } }) };
  };
  const res = await fetchAndVerifyTx({
    txHash: HASH,
    senderId: "relayer.testnet",
    claim: { expectedSuccess: true },
    indexerUrl: "https://indexer.test/v0/transactions",
    rpcUrl: "https://rpc.test",
    fetchFn,
  });
  assert.equal(res.verdict, "VERIFIED");
  assert.equal(res.source, "rpc");
  assert.equal(calls.length, 2);
});

test("fetchAndVerifyTx: indexer failure without a sender stays UNVERIFIABLE, never a pass", async () => {
  const fetchFn = async () => { throw new Error("offline"); };
  const res = await fetchAndVerifyTx({ txHash: HASH, claim: { expectedSuccess: true }, indexerUrl: "https://indexer.test/x", fetchFn });
  assert.equal(res.verdict, "UNVERIFIABLE");
});

test("extractVerificationItems: the gate budget overflow is claimed as a refusal, not a payment", () => {
  const refused = extractVerificationItems().filter((i) => i.label.startsWith("Gate budget attack"));
  assert.equal(refused.length, 1);
  assert.equal(refused[0].claim.expectedSuccess, false);
  assert.equal(refused[0].claim.expectedErrorCode, "OVER_BUDGET");
});

test("extractVerificationItems: real-model replay txs are claimed as paid (naive) or refused with a code (Scrip)", () => {
  const llm = extractVerificationItems().filter((i) => i.source === "demo-llm.json");
  assert.equal(llm.length, 12);
  const naive = llm.filter((i) => i.label.startsWith("Model replay Naive"));
  const scrip = llm.filter((i) => i.label.startsWith("Model replay Scrip"));
  assert.equal(naive.length, 6);
  assert.equal(scrip.length, 6);
  assert.ok(naive.every((i) => i.claim.expectedSuccess === true));
  assert.ok(scrip.every((i) => i.claim.expectedSuccess === false));
  const codes = scrip.map((i) => i.claim.expectedErrorCode).sort();
  assert.deepEqual(codes, ["OVER_PER_PAYMENT_CAP", "OVER_PER_PAYMENT_CAP", "OVER_PER_PAYMENT_CAP", "RECIPIENT_NOT_ALLOWED", "RECIPIENT_NOT_ALLOWED", "RECIPIENT_NOT_ALLOWED"]);
  assert.equal(new Set(llm.map((i) => i.txHash)).size, 12);
});

import { blockTimeFromBody, formatUtc } from "./verify-tx.ts";
test("blockTimeFromBody reads nanosecond block timestamps", () => {
  const body = { result: { transaction_outcome: { block_timestamp: 1794482909771164529 } } };
  assert.equal(blockTimeFromBody(body), "2026-11-12T11:28:29.771Z");
  assert.equal(blockTimeFromBody({ result: {} }), undefined);
  assert.equal(blockTimeFromBody(null), undefined);
});
test("formatUtc is fixed to UTC", () => {
  assert.equal(formatUtc("2026-11-12T11:27:42.744Z"), "12 Nov 2026, 11:27:42 UTC");
  assert.equal(formatUtc("not a date"), "not a date");
});
