// End-to-end check of the hosted relayer (POST /api/relay) on NEAR testnet with the public live-demo agent key.
// usage: RELAY_URL=https://scrip-dev.vercel.app/api/relay node scripts/relay-e2e.mjs
// Writes ../results/relay-e2e.json (tx hashes only).
import { writeFileSync } from "node:fs";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { JsonRpcProvider, KeyPair, KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate } from "near-api-js";
import { LIVE } from "../src/lib/live.ts";

const HERE = dirname(fileURLToPath(import.meta.url));
const URL_ = process.env.RELAY_URL ?? "http://127.0.0.1:3055/api/relay";
const provider = new JsonRpcProvider({ url: "https://rpc.testnet.fastnear.com" });
const kp = KeyPair.fromString(LIVE.agentKey);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const must = (c, m) => { if (!c) throw new Error(`CHECK FAILED: ${m}`); };

async function relay({ recipient, amount, senderId = LIVE.agentId }) {
  const [key, block] = await Promise.all([
    provider.viewAccessKey({ accountId: LIVE.agentId, publicKey: LIVE.agentPublicKey }),
    provider.viewBlock({ finality: "final" }),
  ]);
  const da = buildDelegateAction({
    senderId, receiverId: LIVE.contractId,
    actions: [actions.functionCall("request_payment", { mandate_id: LIVE.mandateId, recipient, amount, nonce: Date.now() }, 80n * 10n ** 12n, 0n)],
    nonce: BigInt(key.nonce) + 1n, maxBlockHeight: BigInt(block.header.height) + 100n, publicKey: kp.getPublicKey(),
  });
  const { signedDelegate } = await new KeyPairSigner(kp).signDelegateAction(da);
  const res = await fetch(URL_, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed_delegate: Buffer.from(encodeSignedDelegate(signedDelegate)).toString("base64") }) });
  return { status: res.status, body: await res.json() };
}

const out = { relay: URL_, contractId: LIVE.contractId, mandateId: LIVE.mandateId, startedAt: new Date().toISOString(), steps: [] };
const health = await (await fetch(URL_)).json();
must(health.ok === true, "relayer configured");
out.relayer = health.relayer;

const a = await relay({ recipient: LIVE.recipients[0], amount: "10000" });
must(a.status === 200 && a.body.inner_status === "Settled", `shop A settled: ${JSON.stringify(a.body)}`);
out.steps.push({ name: "gasless payment to shop A (0.01 USDC)", txHash: a.body.tx_hash, result: "Settled" });
await sleep(2000);
const b = await relay({ recipient: "attacker.testnet", amount: "10000" });
must(b.status === 200 && b.body.inner_code === "RECIPIENT_NOT_ALLOWED", `attacker refused: ${JSON.stringify(b.body)}`);
out.steps.push({ name: "gasless payment to attacker.testnet", txHash: b.body.tx_hash, result: "Rejected RECIPIENT_NOT_ALLOWED" });
const c = await relay({ recipient: LIVE.recipients[0], amount: "10000", senderId: "someone-else.testnet" });
must(c.status === 400 && c.body.code === "AGENT_NOT_ALLOWED", `forged sender refused: ${JSON.stringify(c.body)}`);
out.steps.push({ name: "delegate from an account that is not the mandate's agent", result: "Refused by the relayer (AGENT_NOT_ALLOWED), nothing sent" });

out.finishedAt = new Date().toISOString();
writeFileSync(join(HERE, "../../results/relay-e2e.json"), JSON.stringify(out, null, 2) + "\n");
for (const s of out.steps) console.log("ok", s.name, s.txHash ?? "", s.result);
console.log("ALL CHECKS PASSED");
