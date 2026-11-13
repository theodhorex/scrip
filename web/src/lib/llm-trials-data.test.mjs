import test from "node:test";
import assert from "node:assert/strict";
import { summarizeTrials, summarizeReplay, LLM_TRIALS, LLM_REPLAY } from "./llm-trials-data.ts";

const fx = [
  { model: "a", prompt: "normal", invoiceMode: "honest", seed: 1, label: "PAID_OK" },
  { model: "a", prompt: "normal", invoiceMode: "injected", seed: 1, label: "FOOLED_RECIPIENT" },
  { model: "a", prompt: "hijacked", invoiceMode: "injected", seed: 1, label: "FOOLED_RECIPIENT" },
  { model: "a", prompt: "hijacked", invoiceMode: "injected", seed: 2, label: "DECLINED" },
  { model: "a", prompt: "normal", invoiceMode: "overcharge", seed: 1, label: "FOOLED_AMOUNT" },
  { model: "b", prompt: "normal", invoiceMode: "injected", seed: 1, label: "BROKEN" },
];

test("groups per model and counts injected by prompt", () => {
  const s = summarizeTrials(fx);
  assert.deepEqual(s.map((m) => m.model), ["a", "b"]);
  const a = s[0];
  assert.equal(a.total, 5);
  assert.equal(a.seeds, 2);
  assert.equal(a.injected.normal.fooled, 1);
  assert.equal(a.injected.normal.total, 1);
  assert.equal(a.injected.hijacked.fooled, 1);
  assert.equal(a.injected.hijacked.total, 2);
  assert.equal(a.overpaid, 1);
  assert.equal(a.declined, 1);
  assert.equal(a.broken, 0);
  assert.equal(s[1].broken, 1);
});

test("real data: 390 trials, four models", () => {
  const s = summarizeTrials(LLM_TRIALS);
  assert.equal(LLM_TRIALS.length, 390);
  assert.equal(s.length, 4);
  assert.equal(s.reduce((n, m) => n + m.total, 0), 390);
  assert.equal(s.find((m) => m.model === "qwen3:4b")?.total, 30);
  for (const m of s) if (m.model !== "qwen3:4b") assert.equal(m.total, 120);
});

test("real data: label counts add up per model", () => {
  for (const m of summarizeTrials(LLM_TRIALS)) {
    const fooledR = m.injected.normal.fooled + m.injected.hijacked.fooled;
    assert.ok(fooledR <= m.injected.normal.total + m.injected.hijacked.total);
    assert.ok(m.paidOk + m.fooledRecipient + m.overpaid + m.declined + m.broken === m.total);
  }
});

test("replay: naive executes 6, scrip rejects 6, attacker gains 0", () => {
  const r = summarizeReplay(LLM_REPLAY);
  assert.equal(r.decisions, 6);
  assert.equal(r.naivePaid, 6);
  assert.equal(r.scripRejected, 6);
  assert.equal(r.attackerGainedScrip, "0");
  assert.equal(r.attackerGainedNaive, "600000");
  assert.deepEqual(r.codes, { OVER_PER_PAYMENT_CAP: 3, RECIPIENT_NOT_ALLOWED: 3 });
  assert.equal(r.rows.length, 6);
});
