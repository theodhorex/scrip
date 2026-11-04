// Parallel-spend attack on TESTNET: the same burst against the naive comparator and against Scrip.
// N pre-signed `request_payment` txs of AMOUNT each are broadcast back to back (broadcast_tx_async),
// against a budget that only allows BUDGET/AMOUNT of them. Measured from on-chain balances, not from tx outcomes.
// Result appended to results/attack.json. Keys only from files; testnet only; recovery file before any account.
//
// usage: node scripts/attack.mjs [naive|scrip|both]   env: N=30 PACE_MS=80
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, baseDecode, createTransaction, encodeTransaction, nearToYocto, formatNearAmount,
} from 'near-api-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RPC = process.env.RPC_URL ?? 'https://rpc.testnet.fastnear.com';
const FUNDER_ID = process.env.FUNDER_ID ?? 'envtest-theo-1747.testnet';
const KEY_DIR = process.env.KEY_DIR;
const FUNDER_KEY_FILE = process.env.FUNDER_KEY_FILE ?? (KEY_DIR ? join(KEY_DIR, 'priv_key.txt') : 'priv_key.txt');
const USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const WASM = {
  naive: join(ROOT, 'contracts/scrip_naive/target/wasm32-unknown-unknown/release/scrip_naive.wasm'),
  scrip: join(ROOT, 'contracts/scrip/target/wasm32-unknown-unknown/release/scrip.wasm'),
};
const N = Number(process.env.N ?? 30);
const PACE_MS = Number(process.env.PACE_MS ?? 80);
const AMOUNT = 100_000n; // 0.1 USDC
const BUDGET = 1_000_000n; // 1 USDC: only 10 payments are allowed
const FUND = 2_000_000n; // enough balance for 20 payments, so only the budget rule can stop the burst
const T = (n) => BigInt(n) * 1_000_000_000_000n;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
if (!FUNDER_ID.endsWith('.testnet')) throw new Error('testnet only');
const kind = process.argv[2] ?? 'both';
if (!['naive', 'scrip', 'both'].includes(kind)) throw new Error('usage: attack.mjs [naive|scrip|both]');

const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => { // only 429 is retried, bounded
  for (let i = 0; ; i++) {
    const res = await realFetch(...a);
    if (res.status !== 429 || i >= 5) return res;
    await sleep(Math.min(12000, 1000 * 2 ** i));
  }
};
const raw = readFileSync(FUNDER_KEY_FILE, 'utf8').trim();
const provider = new JsonRpcProvider({ url: RPC });
const funder = new Account(FUNDER_ID, provider, new KeyPairSigner(KeyPair.fromString(raw.startsWith('{') ? JSON.parse(raw).private_key : raw)));
const ft = async (id) => { try { return BigInt(await provider.callFunction({ contractId: USDC, method: 'ft_balance_of', args: { account_id: id } }) || '0'); } catch { return 0n; } };
const near = async (id) => BigInt((await provider.viewAccount({ accountId: id })).amount);
const acc = (id, key) => new Account(id, provider, new KeyPairSigner(key));

const out = { network: 'testnet', startedAt: new Date().toISOString(), params: { N, PACE_MS, amount: AMOUNT.toString(), budget: BUDGET.toString(), funded: FUND.toString() }, cases: [] };
const created = [];
let recoveryFile = null;

async function mk(id, key, nearAmount) {
  await funder.createSubAccount({ accountOrPrefix: id, publicKey: key.getPublicKey().toString(), nearToTransfer: nearToYocto(nearAmount) });
  created.push({ id, key });
  await sleep(400);
}

async function runCase(which, ts) {
  const tag = which === 'naive' ? 'n' : 's';
  const contractId = `atk${tag}c${ts}.${FUNDER_ID}`;
  const agentId = `atk${tag}a${ts}.${FUNDER_ID}`;
  const merchantId = `atk${tag}m${ts}.${FUNDER_ID}`;
  const kp = { c: KeyPair.fromRandom('ed25519'), a: KeyPair.fromRandom('ed25519'), m: KeyPair.fromRandom('ed25519') };
  const accounts = [{ id: contractId, key: kp.c }, { id: agentId, key: kp.a }, { id: merchantId, key: kp.m }];
  const prev = existsSync(recoveryFile) ? JSON.parse(readFileSync(recoveryFile, 'utf8')).accounts : [];
  writeFileSync(recoveryFile, JSON.stringify({ accounts: [...prev, ...accounts.map((x) => ({ id: x.id, key: x.key.toString() }))] }), { mode: 0o600 });

  const wasm = readFileSync(WASM[which]);
  await mk(contractId, kp.c, which === 'naive' ? '2.0' : '3.5');
  await mk(agentId, kp.a, '1.0'); // pays gas of the whole burst with its own full-access key (a leaked key)
  await mk(merchantId, kp.m, '0.15');
  await acc(contractId, kp.c).deployContract(wasm);
  for (const who of [contractId, merchantId]) {
    await funder.callFunctionRaw({ contractId: USDC, methodName: 'storage_deposit', args: { account_id: who, registration_only: true }, gas: T(30), deposit: nearToYocto('0.00125') });
    await sleep(300);
  }
  let target;
  if (which === 'naive') {
    await funder.callFunctionRaw({ contractId, methodName: 'init', gas: T(30), deposit: 0n, args: { owner: FUNDER_ID, agent: agentId, guardian: `guardian-${agentId}`, token: USDC, budget: BUDGET.toString(), per_payment_cap: AMOUNT.toString(), recipients: [merchantId] } });
    target = (i) => ({ method: 'request_payment', args: { recipient: merchantId, amount: AMOUNT.toString(), nonce: 1000 + i } });
    await funder.callFunctionRaw({ contractId: USDC, methodName: 'ft_transfer_call', args: { receiver_id: contractId, amount: FUND.toString(), msg: '{"mandate_id":0}' }, gas: T(100), deposit: 1n });
  } else {
    await funder.callFunctionRaw({ contractId, methodName: 'new', args: {}, gas: T(30), deposit: 0n });
    const cm = await funder.callFunctionRaw({ contractId, methodName: 'create_mandate', gas: T(60), deposit: nearToYocto('0.05'), args: { agent: agentId, guardian: `guardian-${agentId}`, token: USDC, budget: BUDGET.toString(), per_payment_cap: AMOUNT.toString(), approval_threshold: AMOUNT.toString(), recipients: [merchantId], expires_at_ms: Date.now() + 2 * 3600 * 1000 } });
    const mid = JSON.parse(Buffer.from(cm.status.SuccessValue, 'base64').toString());
    await funder.callFunctionRaw({ contractId: USDC, methodName: 'ft_transfer_call', args: { receiver_id: contractId, amount: FUND.toString(), msg: JSON.stringify({ mandate_id: mid }) }, gas: T(100), deposit: 1n });
    target = (i) => ({ method: 'request_payment', args: { mandate_id: mid, recipient: merchantId, amount: AMOUNT.toString(), nonce: 1000 + i } });
  }

  // Pre-sign N txs with sequential nonces, then broadcast them back to back.
  const agentAcc = acc(agentId, kp.a);
  const pk = await agentAcc.signer.getPublicKey();
  const ak = await provider.viewAccessKey({ accountId: agentId, publicKey: pk.toString() });
  const block = await provider.viewBlock({ finality: 'final' });
  const bh = baseDecode(block.header.hash);
  const signed = [];
  for (let i = 0; i < N; i++) {
    const { method, args } = target(i);
    const tx = createTransaction(agentId, pk, contractId, ak.nonce + BigInt(i + 1), [actions.functionCall(method, args, T(100), 0n)], bh);
    signed.push((await agentAcc.signer.signTransaction(tx)).signedTransaction);
  }
  const before = await ft(merchantId);
  let accepted = 0, refused = 0;
  const t0 = Date.now();
  for (const s of signed) {
    try { await provider.sendJsonRpc('broadcast_tx_async', [Buffer.from(encodeTransaction(s)).toString('base64')]); accepted++; } catch { refused++; }
    await sleep(PACE_MS);
  }
  const burstMs = Date.now() - t0;
  // wait until the merchant balance is stable for 2 polls (max ~70 s)
  let last = -1n, stable = 0;
  for (let i = 0; i < 24 && stable < 3; i++) {
    await sleep(3000);
    const now = await ft(merchantId);
    stable = now === last ? stable + 1 : 0;
    last = now;
  }
  const paid = (await ft(merchantId)) - before;
  let state;
  if (which === 'naive') state = await provider.callFunction({ contractId, method: 'get_mandate', args: {} }).catch(() => null);
  else state = await provider.callFunction({ contractId, method: 'get_mandate', args: { id: 1 } }).catch(() => null);
  const res = {
    contract: which, broadcast: { n: N, accepted, refusedByRpc: refused, burstMs }, budget: BUDGET.toString(),
    merchantReceived: paid.toString(), exceededBudget: paid > BUDGET, overBudgetBy: (paid > BUDGET ? paid - BUDGET : 0n).toString(),
    paymentsPaid: (paid / AMOUNT).toString(), spent: state?.spent, reserved: state?.reserved, openRequests: state?.open_requests,
  };
  console.log(which, JSON.stringify(res));
  out.cases.push(res);
  return accounts;
}

async function cleanupAccounts() {
  let clean = true;
  for (const a of created.slice().reverse()) {
    const acct = acc(a.id, a.key);
    try { const b = await ft(a.id); if (b > 0n) await acct.callFunctionRaw({ contractId: USDC, methodName: 'ft_transfer', args: { receiver_id: FUNDER_ID, amount: b.toString() }, gas: T(50), deposit: 1n }); } catch (e) { clean = false; console.error('sweep failed', a.id, e.message); }
    try { await acct.deleteAccount(FUNDER_ID); } catch (e) { if (!/does not exist|UNKNOWN_ACCOUNT/i.test(e.message)) { clean = false; console.error('delete failed', a.id, e.message); } }
    await sleep(300);
  }
  created.length = 0;
  return clean;
}

async function main() {
  const ts = Date.now() % 100000;
  recoveryFile = join(HERE, `.recovery-attack-${ts}.json`);
  writeFileSync(recoveryFile, JSON.stringify({ accounts: [] }), { mode: 0o600 });
  chmodSync(recoveryFile, 0o600);
  out.before = { funderNear: formatNearAmount(await near(FUNDER_ID)), funderUsdc: (await ft(FUNDER_ID)).toString() };
  if (await near(FUNDER_ID) < nearToYocto('5.5')) throw new Error('BLOCKED: funder below 5.5 NEAR');
  for (const which of kind === 'both' ? ['naive', 'scrip'] : [kind]) {
    await runCase(which, ts);
    await cleanupAccounts(); // return NEAR and USDC before the next case
  }
  out.ok = true;
}

let ok = false;
try { await main(); ok = out.ok === true; } catch (e) { out.ok = false; out.error = String(e.message ?? e).slice(0, 400); console.error('ATTACK ERROR:', out.error); }
finally {
  const clean = await cleanupAccounts();
  out.after = { funderNear: formatNearAmount(await near(FUNDER_ID)), funderUsdc: (await ft(FUNDER_ID)).toString() };
  out.cleanup = clean ? 'clean' : 'NOT CLEAN';
  if (clean && recoveryFile && existsSync(recoveryFile)) unlinkSync(recoveryFile); else console.error('keep recovery file', recoveryFile);
  out.finishedAt = new Date().toISOString();
  mkdirSync(join(ROOT, 'results'), { recursive: true });
  const file = join(ROOT, 'results/attack.json');
  const prevRuns = existsSync(file) ? JSON.parse(readFileSync(file, 'utf8')) : [];
  writeFileSync(file, JSON.stringify([...prevRuns, out], null, 2));
  console.log('after', out.after, out.cleanup);
}
process.exit(ok ? 0 : 1);
