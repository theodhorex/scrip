import { test } from "node:test";
import assert from "node:assert/strict";
import {
  TOKENS, toUnits, fromUnits, nearToYocto, canCreateSubaccounts, suffixFrom, partyIds,
  buildSetupTxs, checkMandate, buildCreateMandateTx, buildFundTx, buildRevokeTx, buildWithdrawTx,
  freeRemainder, mandateIdFromOutcome, outcomeFailed, parseOwned, STORAGE_DEPOSIT_YOCTO, MANDATE_DEPOSIT_YOCTO,
} from "./owner-flow.ts";

const C = "live-scrip.envtest-theo-1747.testnet";
const b64 = (s) => Buffer.from(s).toString("base64");

test("toUnits and fromUnits round-trip for 6 and 24 decimals", () => {
  assert.equal(toUnits("0.05", 6), "50000");
  assert.equal(toUnits("1", 24), "1000000000000000000000000");
  assert.equal(toUnits("0.000001", 6), "1");
  assert.equal(fromUnits("1500000000000000000000000", 24), "1.5");
  assert.equal(fromUnits("50000", 6), "0.05");
  assert.equal(fromUnits("0", 6), "0");
});

test("toUnits rejects zero, negatives, too many decimals and junk", () => {
  for (const bad of ["0", "0.0", "-1", "1.0000001", "abc", "", "1e3", " "]) assert.equal(toUnits(bad, 6), null, bad);
});

test("nearToYocto throws on bad input", () => {
  assert.equal(nearToYocto("0.25"), "250000000000000000000000");
  assert.throws(() => nearToYocto("x"));
});

test("canCreateSubaccounts: named testnet accounts only", () => {
  assert.equal(canCreateSubaccounts("alice.testnet"), true);
  assert.equal(canCreateSubaccounts("a".repeat(64)), false);
  assert.equal(canCreateSubaccounts("0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef"), false);
  assert.equal(canCreateSubaccounts("0x" + "a".repeat(40)), false);
  assert.equal(canCreateSubaccounts("alice.near"), false);
  assert.equal(canCreateSubaccounts("x".repeat(37) + ".testnet"), true); // 45 chars: agent id is exactly 64
  assert.equal(canCreateSubaccounts("x".repeat(38) + ".testnet"), false);
  assert.equal(canCreateSubaccounts("x".repeat(50) + ".testnet"), false);
});

test("suffixFrom and partyIds give valid, distinct sub-account ids", () => {
  const s = suffixFrom(new Uint8Array([0, 35, 36, 200, 255, 7, 9]));
  assert.match(s, /^[0-9a-z]{6}$/);
  const { agentId, guardianId } = partyIds("alice.testnet", s);
  assert.equal(agentId, `scrip-agent-${s}.alice.testnet`);
  assert.equal(guardianId, `scrip-guard-${s}.alice.testnet`);
  assert.notEqual(agentId, guardianId);
});

test("buildSetupTxs: agent key is function-call only, bound to request_payment on the contract", () => {
  const txs = buildSetupTxs({ contractId: C, agentId: "scrip-agent-a.alice.testnet", guardianId: "scrip-guard-a.alice.testnet", agentPublicKey: "ed25519:AG", guardianPublicKey: "ed25519:GU", agentNear: "0.3", allowanceNear: "0.25", guardianNear: "0.05" });
  assert.equal(txs.length, 2);
  const [agent, guardian] = txs;
  assert.equal(agent.receiverId, "scrip-agent-a.alice.testnet");
  assert.deepEqual(agent.actions.map((a) => a.type), ["CreateAccount", "Transfer", "AddKey"]);
  const perm = agent.actions[2].params.accessKey.permission;
  assert.deepEqual(perm, { receiverId: C, allowance: "250000000000000000000000", methodNames: ["request_payment"] });
  assert.equal(agent.actions[1].params.deposit, "300000000000000000000000");
  assert.equal(guardian.actions[2].params.accessKey.permission, "FullAccess");
});

const base = { contractId: C, agentId: "scrip-agent-a.alice.testnet", guardianId: "scrip-guard-a.alice.testnet", token: TOKENS.wnear, budget: "0.5", perPaymentCap: "0.1", approvalThreshold: "0.1", recipients: ["shop.testnet"], expiresAtMs: 2_000 };

test("checkMandate mirrors the contract's create_mandate rules", () => {
  assert.equal(checkMandate("alice.testnet", base, 1_000).ok, true);
  const bad = (patch, msg) => { const r = checkMandate("alice.testnet", { ...base, ...patch }, 1_000); assert.equal(r.ok, false); assert.match(r.error, msg); };
  bad({ budget: "0.05" }, /budget must be at least/);
  bad({ approvalThreshold: "0.2" }, /threshold cannot be above/);
  bad({ recipients: [] }, /at least one/);
  bad({ recipients: Array.from({ length: 17 }, (_, i) => `s${i}.testnet`) }, /At most 16/);
  bad({ recipients: ["a.testnet", "a.testnet"] }, /only once/);
  bad({ agentId: "alice.testnet" }, /agent cannot be the owner/);
  bad({ guardianId: "alice.testnet" }, /guardian must differ/);
  bad({ guardianId: base.agentId }, /guardian must differ/);
  bad({ expiresAtMs: 1_000 }, /future/);
  bad({ budget: "0" }, /positive/);
});

test("buildCreateMandateTx sends the exact contract args with the 0.05 NEAR deposit", () => {
  const r = checkMandate("alice.testnet", base, 1_000);
  const tx = buildCreateMandateTx(base, r);
  assert.equal(tx.receiverId, C);
  const p = tx.actions[0].params;
  assert.equal(p.methodName, "create_mandate");
  assert.equal(p.deposit, MANDATE_DEPOSIT_YOCTO);
  assert.equal(p.gas, "60000000000000");
  assert.deepEqual(p.args, { agent: base.agentId, guardian: base.guardianId, token: "wrap.testnet", budget: "500000000000000000000000", per_payment_cap: "100000000000000000000000", approval_threshold: "100000000000000000000000", recipients: ["shop.testnet"], expires_at_ms: 2_000 });
});

test("buildFundTx for wNEAR: register everyone, wrap, then ft_transfer_call with the mandate id", () => {
  const tx = buildFundTx({ token: TOKENS.wnear, contractId: C, ownerId: "alice.testnet", mandateId: 7, amountUnits: "500", recipients: ["shop.testnet"] });
  assert.equal(tx.receiverId, "wrap.testnet");
  assert.deepEqual(tx.actions.map((a) => a.params.methodName), ["storage_deposit", "storage_deposit", "storage_deposit", "near_deposit", "ft_transfer_call"]);
  assert.deepEqual(tx.actions.slice(0, 3).map((a) => a.params.args.account_id), ["alice.testnet", C, "shop.testnet"]);
  assert.ok(tx.actions.slice(0, 3).every((a) => a.params.deposit === STORAGE_DEPOSIT_YOCTO && a.params.args.registration_only === true));
  assert.equal(tx.actions[3].params.deposit, "500");
  const t = tx.actions[4].params;
  assert.equal(t.deposit, "1");
  assert.deepEqual(t.args, { receiver_id: C, amount: "500", msg: '{"mandate_id":7}' });
  const total = tx.actions.reduce((g, a) => g + BigInt(a.params.gas), 0n);
  assert.ok(total <= 300n * 10n ** 12n, "fits in one transaction's gas limit");
});

test("buildFundTx for USDC does not wrap", () => {
  const tx = buildFundTx({ token: TOKENS.usdc, contractId: C, ownerId: "alice.testnet", mandateId: 2, amountUnits: "100000", recipients: ["a.testnet", "b.testnet"] });
  assert.equal(tx.receiverId, TOKENS.usdc.id);
  assert.ok(!tx.actions.some((a) => a.params.methodName === "near_deposit"));
  assert.equal(tx.actions.length, 5);
});

test("revoke and withdraw transactions", () => {
  assert.deepEqual(buildRevokeTx(C, 3).actions[0].params.args, { mandate_id: 3 });
  const w = buildWithdrawTx(C, 3, "42").actions[0].params;
  assert.equal(w.methodName, "withdraw");
  assert.deepEqual(w.args, { mandate_id: 3, amount: "42" });
  assert.ok(BigInt(w.gas) >= 60n * 10n ** 12n, "contract requires at least 60 Tgas");
});

test("freeRemainder never goes negative", () => {
  assert.equal(freeRemainder({ deposited: "100", spent: "30", reserved: "10", withdrawn: "0" }), "60");
  assert.equal(freeRemainder({ deposited: "100", spent: "100", reserved: "0", withdrawn: "0" }), "0");
  assert.equal(freeRemainder({ deposited: "10", spent: "5", reserved: "5", withdrawn: "5" }), "0");
});

test("mandateIdFromOutcome reads the return value, then falls back to the mandate_created event", () => {
  assert.equal(mandateIdFromOutcome({ status: { SuccessValue: b64("12") } }), 12);
  const ev = `EVENT_JSON:${JSON.stringify({ standard: "scrip", version: "1.0.0", event: "mandate_created", data: [{ mandate_id: 9, recipient: "a", amount: "1" }] })}`;
  assert.equal(mandateIdFromOutcome({ status: { SuccessValue: "" }, receipts_outcome: [{ outcome: { logs: ["noise", ev] } }] }), 9);
  assert.equal(mandateIdFromOutcome({ status: { Failure: {} } }), null);
  assert.equal(mandateIdFromOutcome(null), null);
});

test("outcomeFailed spots a failed status", () => {
  assert.match(outcomeFailed({ status: { Failure: { ActionError: { kind: "x" } } } }), /ActionError/);
  assert.equal(outcomeFailed({ status: { SuccessValue: "" } }), null);
});

test("parseOwned tolerates junk and keeps only v1 records", () => {
  assert.deepEqual(parseOwned(null), []);
  assert.deepEqual(parseOwned("{oops"), []);
  assert.deepEqual(parseOwned('{"v":1}'), []);
  const ok = { v: 1, agentId: "a", agentKey: "ed25519:x" };
  assert.deepEqual(parseOwned(JSON.stringify([ok, { v: 2 }, null])), [ok]);
});
