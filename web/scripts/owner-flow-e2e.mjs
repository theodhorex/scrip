// End-to-end check of the web owner flow on NEAR testnet, without a browser wallet.
// It signs the EXACT transactions that /mandates/new hands to the wallet (built by src/lib/owner-flow.ts)
// with a fresh test owner account, then acts as the agent with the function-call key the flow created.
//
// usage: KEY_DIR=<dir with priv_key.txt of the funder> node scripts/owner-flow-e2e.mjs
// Writes ../results/owner-flow-e2e.json (tx hashes only). The owner key goes to KEY_DIR/owner-flow-e2e-keys.json (0600).
import { readFileSync, writeFileSync, chmodSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, PublicKey, actions } from "near-api-js";
import {
  TOKENS, buildSetupTxs, checkMandate, buildCreateMandateTx, buildFundTx, buildRevokeTx, buildWithdrawTx,
  mandateIdFromOutcome, outcomeFailed, freeRemainder, partyIds, suffixFrom, toUnits,
} from "../src/lib/owner-flow.ts";
import { parsePaymentOutcome, LIVE } from "../src/lib/live.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const KEY_DIR = process.env.KEY_DIR;
if (!KEY_DIR) throw new Error("KEY_DIR is required");
const FUNDER = process.env.FUNDER_ID ?? "envtest-theo-1747.testnet";
const RPC = "https://rpc.testnet.fastnear.com";
const provider = new JsonRpcProvider({ url: RPC });
const keyOf = (f) => { const raw = readFileSync(f, "utf8").trim(); return raw.startsWith("{") ? JSON.parse(raw).private_key : raw; };
const acct = (id, kp) => new Account(id, provider, new KeyPairSigner(kp));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const view = (contractId, method, args) => provider.callFunction({ contractId, method, args });

/** near-wallet-selector style actions (what the wallet receives) -> near-api-js actions. */
function toApi(a) {
  switch (a.type) {
    case "CreateAccount": return actions.createAccount();
    case "Transfer": return actions.transfer(BigInt(a.params.deposit));
    case "AddKey": {
      const pk = PublicKey.from(a.params.publicKey);
      const p = a.params.accessKey.permission;
      return p === "FullAccess" ? actions.addFullAccessKey(pk) : actions.addFunctionCallAccessKey(pk, p.receiverId, p.methodNames ?? [], p.allowance ? BigInt(p.allowance) : undefined);
    }
    case "FunctionCall": return actions.functionCall(a.params.methodName, a.params.args, BigInt(a.params.gas), BigInt(a.params.deposit));
    default: throw new Error(`unsupported action ${a.type}`);
  }
}
const sendTx = (account, tx) => account.signAndSendTransaction({ receiverId: tx.receiverId, actions: tx.actions.map(toApi) });

const out = { network: "testnet", contractId: LIVE.contractId, startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => { out.steps.push({ name, ...data }); console.log("ok", name, data.txHash ?? "", data.result ?? ""); };
const must = (cond, msg) => { if (!cond) throw new Error(`CHECK FAILED: ${msg}`); };

const funder = acct(FUNDER, KeyPair.fromString(keyOf(join(KEY_DIR, "priv_key.txt"))));
const suffix = suffixFrom(crypto.getRandomValues(new Uint8Array(6)));
const ownerId = `e2e-owner-${suffix.slice(0, 4)}.${FUNDER}`;
const ownerKp = KeyPair.fromRandom("ed25519");
writeFileSync(join(KEY_DIR, "owner-flow-e2e-keys.json"), JSON.stringify({ ownerId, key: ownerKp.toString(), createdAt: out.startedAt }, null, 2), { mode: 0o600 });
chmodSync(join(KEY_DIR, "owner-flow-e2e-keys.json"), 0o600);

// 0. A fresh owner, standing in for a visitor's wallet account.
const c0 = await funder.createSubAccount({ accountOrPrefix: ownerId, publicKey: ownerKp.getPublicKey().toString(), nearToTransfer: BigInt(toUnits("1.5", 24)) });
step("create test owner", { txHash: c0.transaction.hash, ownerId });
await sleep(1500);
const owner = acct(ownerId, ownerKp);

// 1. Setup + create_mandate: the same three transactions the page sends in one wallet approval.
const agentKp = KeyPair.fromRandom("ed25519");
const guardKp = KeyPair.fromRandom("ed25519");
const { agentId, guardianId } = partyIds(ownerId, suffix);
const token = TOKENS.wnear;
const input = { contractId: LIVE.contractId, agentId, guardianId, token, budget: "0.2", perPaymentCap: "0.05", approvalThreshold: "0.05", recipients: LIVE.recipients, expiresAtMs: Date.now() + 2 * 86_400_000 };
const chk = checkMandate(ownerId, input, Date.now());
must(chk.ok, "checkMandate");
const txs = [
  ...buildSetupTxs({ contractId: LIVE.contractId, agentId, guardianId, agentPublicKey: agentKp.getPublicKey().toString(), guardianPublicKey: guardKp.getPublicKey().toString(), agentNear: "0.3", allowanceNear: "0.25", guardianNear: "0.05" }),
  buildCreateMandateTx(input, chk),
];
const outcomes = [];
for (const tx of txs) { outcomes.push(await sendTx(owner, tx)); await sleep(800); }
must(outcomes.every((o) => !outcomeFailed(o)), "setup and create succeeded");
const mandateId = mandateIdFromOutcome(outcomes[2]);
must(mandateId !== null, "mandate id read from the outcome");
step("create agent", { txHash: outcomes[0].transaction.hash, agentId });
step("create guardian", { txHash: outcomes[1].transaction.hash, guardianId });
step("create_mandate", { txHash: outcomes[2].transaction.hash, mandateId });

const keys = await provider.viewAccessKeyList({ accountId: agentId });
must(keys.keys.length === 1 && keys.keys[0].access_key.permission.FunctionCall?.method_names?.[0] === "request_payment", "agent has exactly one function-call key for request_payment");
step("agent key check", { result: "1 key, FunctionCall request_payment only" });

// 2. Fund: register, wrap NEAR, ft_transfer_call into the mandate.
const f = await sendTx(owner, buildFundTx({ token, contractId: LIVE.contractId, ownerId, mandateId, amountUnits: chk.budget, recipients: LIVE.recipients }));
must(!outcomeFailed(f), "fund succeeded");
await sleep(1500);
const m1 = await view(LIVE.contractId, "get_mandate", { id: mandateId });
must(m1.deposited === chk.budget, `deposited ${m1.deposited} == ${chk.budget}`);
step("fund (wrap + ft_transfer_call)", { txHash: f.transaction.hash, result: `deposited ${m1.deposited}` });

// 3. Be the agent: one payment inside the rules, two refusals.
const agent = acct(agentId, agentKp);
const pay = async (recipient, amount, nonce) => {
  const o = await agent.callFunctionRaw({ contractId: LIVE.contractId, methodName: "request_payment", args: { mandate_id: mandateId, recipient, amount, nonce }, gas: 80n * 10n ** 12n, deposit: 0n });
  await sleep(800);
  return { txHash: o.transaction.hash, result: parsePaymentOutcome(o) };
};
const p1 = await pay(LIVE.recipients[0], toUnits("0.01", 24), 1);
must(p1.result.kind === "settled", `payment settled: ${JSON.stringify(p1.result)}`);
step("agent pays shop A 0.01 wNEAR", { txHash: p1.txHash, result: "Settled" });
const p2 = await pay("attacker.testnet", toUnits("0.01", 24), 2);
must(p2.result.kind === "rejected" && p2.result.code === "RECIPIENT_NOT_ALLOWED", "attacker refused");
step("agent pays attacker", { txHash: p2.txHash, result: "Rejected RECIPIENT_NOT_ALLOWED" });
const p3 = await pay(LIVE.recipients[1], toUnits("0.1", 24), 3);
must(p3.result.kind === "rejected" && p3.result.code === "OVER_PER_PAYMENT_CAP", "over cap refused");
step("agent pays over the cap", { txHash: p3.txHash, result: "Rejected OVER_PER_PAYMENT_CAP" });

// 4. The agent key cannot move NEAR.
let blocked = false;
try { await agent.transfer({ receiverId: "attacker.testnet", amount: 1n }); } catch (e) { blocked = /permission|MethodNameMismatch|ReceiverMismatch|NotEnoughAllowance|DepositWithFunctionCall|InvalidAccessKey|access key/i.test(String(e?.message ?? e)); out.agentTransferError = String(e?.message ?? e).slice(0, 200); }
must(blocked, "agent key cannot transfer NEAR");
step("agent key tries to send NEAR", { result: "refused by the protocol (function-call key)" });

// 5. Owner revokes and withdraws the free remainder.
const r = await sendTx(owner, buildRevokeTx(LIVE.contractId, mandateId));
must(!outcomeFailed(r), "revoke");
step("revoke", { txHash: r.transaction.hash });
await sleep(1500);
const m2 = await view(LIVE.contractId, "get_mandate", { id: mandateId });
const free = freeRemainder(m2);
const wd = await sendTx(owner, buildWithdrawTx(LIVE.contractId, mandateId, free));
must(!outcomeFailed(wd), "withdraw");
await sleep(1500);
const m3 = await view(LIVE.contractId, "get_mandate", { id: mandateId });
must(m3.withdrawn === free && freeRemainder(m3) === "0", "remainder withdrawn");
step("withdraw remainder", { txHash: wd.transaction.hash, result: `withdrawn ${free} (spent ${m3.spent})` });

out.finishedAt = new Date().toISOString();
out.ownerId = ownerId; out.agentId = agentId; out.guardianId = guardianId; out.mandateId = mandateId; out.token = token.id;
delete out.agentTransferError;
writeFileSync(join(HERE, "../../results/owner-flow-e2e.json"), JSON.stringify(out, null, 2) + "\n");
console.log("ALL CHECKS PASSED, mandate", mandateId);
