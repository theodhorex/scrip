// Live demo setup (TESTNET only): a permanent Scrip contract + one mandate that anyone can spend from the web page.
//
// The agent's FUNCTION-CALL key is published on purpose (web/src/data/live.json). That is the point of Scrip:
// whoever holds the agent key can only call `request_payment` on this contract, so the most a visitor (or a thief)
// can do is pay the allowlisted shops, up to the per-payment cap, inside the budget. Gas for those calls comes from
// the key's allowance on the agent account (also bounded). Everything else is refused on-chain.
//
// Owner = funder account. Guardian, agent admin and shop keys go to KEY_DIR/live-demo-keys.json (mode 0600),
// never into the repository. The contract's full-access key is deleted after init, so the code cannot change, and
// the agent's setup key is deleted once the function-call key exists, so the agent's only key is the published one.
//
// usage: KEY_DIR=<dir with priv_key.txt> node scripts/live-setup.mjs
import { readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto } from 'near-api-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RPC = process.env.RPC_URL ?? 'https://rpc.testnet.fastnear.com';
const FUNDER_ID = process.env.FUNDER_ID ?? 'envtest-theo-1747.testnet';
const KEY_DIR = process.env.KEY_DIR;
if (!KEY_DIR) throw new Error('KEY_DIR is required');
const USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const WASM = join(ROOT, 'contracts/scrip/target/wasm32-unknown-unknown/release/scrip.wasm');
const SECRETS = join(KEY_DIR, 'live-demo-keys.json');
const OUT = join(ROOT, 'web/src/data/live.json');

// Mandate shape: small amounts so the budget lasts for many visitors.
const BUDGET = 10_000_000n; // 10 USDC
const CAP = 100_000n; // 0.1 USDC per payment
const THRESHOLD = 50_000n; // above 0.05 USDC needs a guardian approval
const EXPIRES_DAYS = 45;
const AGENT_NEAR = '5'; // pays gas for request_payment through the published key
const KEY_ALLOWANCE = '4.5';

if (!FUNDER_ID.endsWith('.testnet')) throw new Error('testnet only');
if (existsSync(SECRETS)) throw new Error(`refusing to overwrite ${SECRETS}: the live demo already exists`);

const T = (n) => BigInt(n) * 1_000_000_000_000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const keyOf = (file) => { const raw = readFileSync(file, 'utf8').trim(); return raw.startsWith('{') ? JSON.parse(raw).private_key : raw; };
const provider = new JsonRpcProvider({ url: RPC });
const funder = new Account(FUNDER_ID, provider, new KeyPairSigner(KeyPair.fromString(keyOf(join(KEY_DIR, 'priv_key.txt')))));
const acc = (id, kp) => new Account(id, provider, new KeyPairSigner(kp));
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });

const ids = {
  contract: `live-scrip.${FUNDER_ID}`,
  agent: `live-agent.${FUNDER_ID}`,
  guardian: `live-guardian.${FUNDER_ID}`,
  shopA: `live-shop-a.${FUNDER_ID}`,
  shopB: `live-shop-b.${FUNDER_ID}`,
};
const kp = Object.fromEntries([...Object.keys(ids), 'fc'].map((k) => [k, KeyPair.fromRandom('ed25519')]));

// Keys first, so nothing is lost if a step fails half way.
writeFileSync(SECRETS, JSON.stringify({ createdAt: new Date().toISOString(), accounts: Object.keys(ids).map((k) => ({ role: k, id: ids[k], key: kp[k].toString() })), agentFunctionCallKey: kp.fc.toString() }, null, 2), { mode: 0o600 });
chmodSync(SECRETS, 0o600);

const txs = {};
const step = async (name, fn) => { const r = await fn(); if (r?.transaction?.hash) txs[name] = r.transaction.hash; console.log('ok', name); await sleep(600); return r; };

await step('createContract', () => funder.createSubAccount({ accountOrPrefix: ids.contract, publicKey: kp.contract.getPublicKey().toString(), nearToTransfer: nearToYocto('3.6') }));
await step('createAgent', () => funder.createSubAccount({ accountOrPrefix: ids.agent, publicKey: kp.agent.getPublicKey().toString(), nearToTransfer: nearToYocto(AGENT_NEAR) }));
await step('createGuardian', () => funder.createSubAccount({ accountOrPrefix: ids.guardian, publicKey: kp.guardian.getPublicKey().toString(), nearToTransfer: nearToYocto('0.3') }));
await step('createShopA', () => funder.createSubAccount({ accountOrPrefix: ids.shopA, publicKey: kp.shopA.getPublicKey().toString(), nearToTransfer: nearToYocto('0.1') }));
await step('createShopB', () => funder.createSubAccount({ accountOrPrefix: ids.shopB, publicKey: kp.shopB.getPublicKey().toString(), nearToTransfer: nearToYocto('0.1') }));

const contractAcc = acc(ids.contract, kp.contract);
await step('deploy', () => contractAcc.deployContract(readFileSync(WASM)));
await step('init', () => funder.callFunctionRaw({ contractId: ids.contract, methodName: 'new', args: {}, gas: T(30), deposit: 0n }));

for (const [name, who] of [['registerContract', ids.contract], ['registerShopA', ids.shopA], ['registerShopB', ids.shopB]]) {
  await step(name, () => funder.callFunctionRaw({ contractId: USDC, methodName: 'storage_deposit', args: { account_id: who, registration_only: true }, gas: T(30), deposit: nearToYocto('0.00125') }));
}

const expiresAtMs = Date.now() + EXPIRES_DAYS * 86_400_000;
const cm = await step('createMandate', () => funder.callFunctionRaw({
  contractId: ids.contract, methodName: 'create_mandate', gas: T(60), deposit: nearToYocto('0.05'),
  args: { agent: ids.agent, guardian: ids.guardian, token: USDC, budget: BUDGET.toString(), per_payment_cap: CAP.toString(), approval_threshold: THRESHOLD.toString(), recipients: [ids.shopA, ids.shopB], expires_at_ms: expiresAtMs },
}));
const mandateId = JSON.parse(Buffer.from(cm.status.SuccessValue, 'base64').toString());
await step('fundMandate', () => funder.callFunctionRaw({ contractId: USDC, methodName: 'ft_transfer_call', args: { receiver_id: ids.contract, amount: BUDGET.toString(), msg: JSON.stringify({ mandate_id: mandateId }) }, gas: T(100), deposit: 1n }));
const m0 = await view(ids.contract, 'get_mandate', { id: mandateId });
if (m0.deposited !== BUDGET.toString()) throw new Error(`funding failed: ${JSON.stringify(m0)}`);

await step('addAgentKey', () => acc(ids.agent, kp.agent).addFunctionCallAccessKey({ publicKey: kp.fc.getPublicKey(), contractId: ids.contract, methodNames: ['request_payment'], allowance: nearToYocto(KEY_ALLOWANCE) }));
// The agent keeps no full-access key: its only key is the published function-call key.
await step('deleteAgentSetupKey', () => acc(ids.agent, kp.agent).deleteKey(kp.agent.getPublicKey()));
// The contract can no longer be changed by anyone: its only full-access key is removed.
await step('deleteContractKey', () => contractAcc.deleteKey(kp.contract.getPublicKey()));
const keys = await provider.viewAccessKeyList({ accountId: ids.contract });
if ((keys.keys ?? []).length !== 0) throw new Error('contract still has keys');

writeFileSync(OUT, JSON.stringify({
  network: 'testnet',
  note: 'Live demo mandate. agentKey is a FUNCTION-CALL key published on purpose: it can only call request_payment on this contract.',
  createdAt: new Date().toISOString(),
  contractId: ids.contract,
  agentId: ids.agent,
  guardianId: ids.guardian,
  ownerId: FUNDER_ID,
  token: USDC,
  mandateId,
  recipients: [ids.shopA, ids.shopB],
  budget: BUDGET.toString(),
  perPaymentCap: CAP.toString(),
  approvalThreshold: THRESHOLD.toString(),
  expiresAtMs,
  agentPublicKey: kp.fc.getPublicKey().toString(),
  agentKey: kp.fc.toString(),
  keyAllowanceNear: KEY_ALLOWANCE,
  txs,
}, null, 2) + '\n');
console.log('wrote', OUT, 'mandate', mandateId);
