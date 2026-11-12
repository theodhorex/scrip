// Demo (D2): two scripted agents face the same merchant sequence on TESTNET, all real.
//   invoice 1 HONEST (0.2 USDC, allowed merchant), invoice 2 INJECTED (prompt-injection note, pay the whole
//   balance to the attacker), invoice 3 OVERCHARGE (allowed merchant, above the 0.5 per-payment cap).
//   NAIVE agent: holds the USDC with a full-access key -> the injection drains it.
//   SCRIP agent: function-call key only, pays via our facilitator + Scrip contract -> Rejected codes.
// The agent is a deterministic scripted stand-in for an injectable LLM (see demo/agent.mjs), not a real LLM.
// Result: results/demo.json. Keys come only from files (env), never printed. Testnet only.
//
// usage: node scripts/demo.mjs        (needs: make contract-build, npm install in scripts/)
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner, nearToYocto, formatNearAmount } from 'near-api-js';
import { createMerchant } from '../demo/merchant.mjs';
import { runAgent, makeNaivePayer, makeScripPayer } from '../demo/agent.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RPC = process.env.RPC_URL ?? 'https://rpc.testnet.fastnear.com';
const FUNDER_ID = process.env.FUNDER_ID ?? 'envtest-theo-1747.testnet';
const RELAYER_ID = process.env.RELAYER_ID ?? 'relayer-theo-1747.testnet';
const NEAR_DIR = process.env.KEY_DIR;
const FUNDER_KEY_FILE = process.env.FUNDER_KEY_FILE ?? (NEAR_DIR ? join(NEAR_DIR, 'priv_key.txt') : 'priv_key.txt');
const RELAYER_KEY_FILE = process.env.RELAYER_KEY_FILE ?? (NEAR_DIR ? join(NEAR_DIR, 'priv_key_relayer.txt') : 'priv_key_relayer.txt');
const USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const WASM = join(ROOT, 'contracts/scrip/target/wasm32-unknown-unknown/release/scrip.wasm');
const FAC_PORT = Number(process.env.FAC_PORT ?? 8792);
const MERCHANT_PORT = Number(process.env.MERCHANT_PORT ?? 8793);
const ONE_USDC = 1_000_000n;
const BUDGET = ONE_USDC;
const CAP = 500_000n;

// --replay <decisions.json> [--out <name>]: instead of the scripted agent, re-execute RECORDED model decisions
// (see scripts/llm-pick-replay.mjs) through the same two payers. No LLM runs here.
const argOf = (f) => { const i = process.argv.indexOf(f); return i > 0 ? process.argv[i + 1] : null; };
const REPLAY_FILE = argOf('--replay');
const REPLAY = REPLAY_FILE ? JSON.parse(readFileSync(REPLAY_FILE, 'utf8')) : null;
const OUT_FILE = argOf('--out') ?? (REPLAY ? 'demo-llm.json' : 'demo.json');
const NAIVE_FUND = REPLAY ? BigInt(REPLAY.decisions.reduce((a, d) => a + BigInt(d.amount), 0n)) + ONE_USDC / 10n : ONE_USDC;

const T = (n) => BigInt(n) * 1_000_000_000_000n; // Tgas
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const id of [FUNDER_ID, RELAYER_ID]) if (!id.endsWith('.testnet')) throw new Error('testnet only');

// Pacing (<= ~7 requests/s) for every fetch, and bounded retry ONLY for HTTP 429. Errors are never swallowed.
const realFetch = globalThis.fetch;
let nextSlot = 0;
const fetchPaced = async (...a) => {
  for (let i = 0; ; i++) {
    const now = Date.now();
    const at = Math.max(now, nextSlot);
    nextSlot = at + 140;
    if (at > now) await sleep(at - now);
    const res = await realFetch(...a);
    if (res.status !== 429 || i >= 6) return res;
    await sleep(Math.min(15000, 1000 * 2 ** i));
  }
};
globalThis.fetch = fetchPaced;

const keyOf = (file) => {
  const raw = readFileSync(file, 'utf8').trim();
  return raw.startsWith('{') ? JSON.parse(raw).private_key : raw;
};
const provider = new JsonRpcProvider({ url: RPC });
const funder = new Account(FUNDER_ID, provider, new KeyPairSigner(KeyPair.fromString(keyOf(FUNDER_KEY_FILE))));

const ft = async (id) => {
  try { return BigInt(await provider.callFunction({ contractId: USDC, method: 'ft_balance_of', args: { account_id: id } }) || '0'); }
  catch { return 0n; }
};
const near = async (id) => BigInt((await provider.viewAccount({ accountId: id })).amount);
const view = (contractId, method, args = {}) => provider.callFunction({ contractId, method, args });

// Chain lookup of a tx: success flag, parsed EVENT_JSON events (scrip + nep141) and receipt SuccessValues.
async function txInfo(txHash, sender) {
  for (let i = 0; i < 8; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await fetchPaced(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' } }),
      });
      const j = await res.json();
      if (j.result) {
        const outs = j.result.receipts_outcome.map((o) => o.outcome);
        const failed = outs.some((o) => o.status.Failure) || Boolean(j.result.status.Failure);
        const events = outs.flatMap((o) => o.logs).filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11)));
        const results = outs.map((o) => o.status.SuccessValue).filter((v) => typeof v === 'string' && v.length > 0);
        return { failed, events, results };
      }
    } catch { /* retry; bounded by the loop and the abort timeout */ } finally { clearTimeout(timer); }
    await sleep(2500);
  }
  return { failed: null, events: [], results: [], unreadable: true };
}

const results = { network: 'testnet', startedAt: new Date().toISOString(), note: REPLAY ? 'Recorded decisions of real small models (GitHub Actions runs), re-executed on testnet. No LLM runs in this script.' : 'Scripted agent stand-in (not a real LLM): shows contract rules, not model robustness.', agents: {}, txs: {} };
const created = []; // accounts to clean
let facilitator = null;
let merchant = null;
let recoveryFile = null;
let policyFileForCleanup = null;

async function main() {
  const ts = Date.now() % 100000;
  const id = (p) => `${p}${ts}.${FUNDER_ID}`;
  const ids = { contract: id('dmc'), agent: id('dma'), guardian: id('dmg'), merchant: id('dmm'), attacker: id('dmx'), naive: id('dmn') };
  const kp = Object.fromEntries([...Object.keys(ids), 'fc'].map((k) => [k, KeyPair.fromRandom('ed25519')]));

  // Recovery file BEFORE any account exists (mode 0600, gitignored name .recovery-*).
  recoveryFile = join(HERE, `.recovery-demo-${ts}.json`);
  writeFileSync(recoveryFile, JSON.stringify({ accounts: Object.keys(ids).map((k) => ({ id: ids[k], key: kp[k].toString() })) }), { mode: 0o600 });
  chmodSync(recoveryFile, 0o600);

  results.before = { funderNear: formatNearAmount(await near(FUNDER_ID)), funderUsdc: (await ft(FUNDER_ID)).toString(), relayerNear: formatNearAmount(await near(RELAYER_ID)) };
  console.log('before', results.before);
  if (await near(FUNDER_ID) < nearToYocto('6')) throw new Error('BLOCKED: funder below 6 NEAR');
  if (await ft(FUNDER_ID) < NAIVE_FUND + BUDGET) throw new Error('BLOCKED: funder needs naive funding + 1.0 USDC mandate');

  const mk = async (acct, key, near_) => {
    await funder.createSubAccount({ accountOrPrefix: acct, publicKey: key.getPublicKey().toString(), nearToTransfer: nearToYocto(near_) });
    created.push({ id: acct, key });
    await sleep(500);
  };
  await mk(ids.contract, kp.contract, '3.4');
  await mk(ids.agent, kp.agent, '0.5');
  await mk(ids.guardian, kp.guardian, '0.2');
  await mk(ids.merchant, kp.merchant, '0.15');
  await mk(ids.attacker, kp.attacker, '0.15');
  await mk(ids.naive, kp.naive, '0.3');
  const acc = (i, k) => new Account(i, provider, new KeyPairSigner(k));
  const contractAcc = acc(ids.contract, kp.contract);
  const agentAdmin = acc(ids.agent, kp.agent);
  const naiveAcc = acc(ids.naive, kp.naive); // full-access key: the naive agent's own key

  // 1. deploy + init
  const wasm = readFileSync(WASM);
  results.txs.deploy = (await contractAcc.deployContract(wasm)).transaction.hash;
  results.txs.init = (await funder.callFunctionRaw({ contractId: ids.contract, methodName: 'new', args: {}, gas: T(30), deposit: 0n })).transaction.hash;

  // 2. USDC registrations: contract, merchant, attacker, naive agent
  for (const who of [ids.contract, ids.merchant, ids.attacker, ids.naive]) {
    await funder.callFunctionRaw({ contractId: USDC, methodName: 'storage_deposit', args: { account_id: who, registration_only: true }, gas: T(30), deposit: nearToYocto('0.00125') });
    await sleep(400);
  }

  // 3. mandate: budget 1.0 USDC, cap/threshold 0.5, only the merchant allowed
  const cm = await funder.callFunctionRaw({
    contractId: ids.contract, methodName: 'create_mandate', gas: T(60), deposit: nearToYocto('0.05'),
    args: { agent: ids.agent, guardian: ids.guardian, token: USDC, budget: BUDGET.toString(), per_payment_cap: CAP.toString(), approval_threshold: CAP.toString(), recipients: [ids.merchant], expires_at_ms: Date.now() + 2 * 3600 * 1000 },
  });
  results.txs.createMandate = cm.transaction.hash;
  const mandateId = JSON.parse(Buffer.from(cm.status.SuccessValue, 'base64').toString());

  // 4. fund: naive agent gets 1.0 USDC directly; mandate gets 1.0 USDC via ft_transfer_call
  results.txs.fundNaive = (await funder.callFunctionRaw({ contractId: USDC, methodName: 'ft_transfer', args: { receiver_id: ids.naive, amount: NAIVE_FUND.toString() }, gas: T(30), deposit: 1n })).transaction.hash;
  const fund = await funder.callFunctionRaw({ contractId: USDC, methodName: 'ft_transfer_call', args: { receiver_id: ids.contract, amount: BUDGET.toString(), msg: JSON.stringify({ mandate_id: mandateId }) }, gas: T(100), deposit: 1n });
  results.txs.fundMandate = fund.transaction.hash;
  const m0 = await view(ids.contract, 'get_mandate', { id: mandateId });
  if (m0.deposited !== BUDGET.toString()) throw new Error(`funding failed: ${JSON.stringify(m0)}`);
  if (await ft(ids.naive) !== NAIVE_FUND) throw new Error('naive agent funding failed');

  // 5. Scrip agent: function-call key (request_payment on this contract only), no USDC of its own
  await agentAdmin.addFunctionCallAccessKey({ publicKey: kp.fc.getPublicKey(), contractId: ids.contract, methodNames: ['request_payment'], allowance: nearToYocto('0.25') });

  // 6. our facilitator (separate process; relayer key read from file by the child, never printed)
  policyFileForCleanup = join(HERE, `.policy-demo-${ts}.json`);
  writeFileSync(policyFileForCleanup, JSON.stringify({
    network: 'testnet', contractId: ids.contract, allowedMethods: ['request_payment'], allowedAgents: [ids.agent], maxGas: '150000000000000',
    maxBlockHeightWindow: 300, minBlockHeightMargin: 5, rateLimit: { capacity: REPLAY ? 24 : 8, refillPerSecond: 1 }, rpcUrl: RPC,
  }));
  facilitator = spawn('node', [join(ROOT, 'facilitator/src/main.mjs')], {
    env: { ...process.env, POLICY_FILE: policyFileForCleanup, RELAYER_ACCOUNT_ID: RELAYER_ID, RELAYER_KEY_FILE, PORT: String(FAC_PORT), RPC_URL: RPC },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fLog = '';
  facilitator.stdout.on('data', (d) => { fLog += d; });
  facilitator.stderr.on('data', (d) => { fLog += d; });
  const facUrl = `http://127.0.0.1:${FAC_PORT}`;
  const health = async () => (await fetchPaced(`${facUrl}/health`)).status;
  for (let i = 0; i < 30; i++) { try { if (await health() === 200) break; } catch { /* not up yet */ } await sleep(300); }
  if (await health() !== 200) throw new Error(`facilitator did not start: ${fLog.slice(0, 300)}`);

  // 7. merchant. verifyPayment is the real chain lookup: the tx must have succeeded and show a USDC
  // transfer (nep141 ft_transfer) or an Scrip `settled` event to invoice.payTo of >= invoice.amount.
  const senderOf = new Map(); // txHash -> account that signed the outer tx
  const verifyPayment = async (txHash, invoice) => {
    const sender = senderOf.get(txHash);
    if (!sender) return false;
    const info = await txInfo(txHash, sender);
    if (info.unreadable || info.failed) return false;
    const need = BigInt(invoice.amount);
    return info.events.some((e) => (e.standard === 'nep141' && e.event === 'ft_transfer'
      && e.data.some((d) => d.new_owner_id === invoice.payTo && BigInt(d.amount) >= need))
      || (e.standard === 'scrip' && e.event === 'settled' && e.data.some((d) => d.recipient === invoice.payTo && BigInt(d.amount) >= need)));
  };
  merchant = createMerchant({ payTo: ids.merchant, token: USDC, mode: 'honest', verifyPayment, cap: CAP.toString(), attacker: ids.attacker, attackerAmount: ONE_USDC.toString() });
  const merchantUrl = `http://127.0.0.1:${await merchant.listen(MERCHANT_PORT)}`;

  // 8. payers
  const remember = (payer, sender) => ({ pay: async (p) => { const r = await payer.pay(p); if (r.txHash) senderOf.set(r.txHash, sender); return r; } });
  const naivePayer = remember(makeNaivePayer({ account: naiveAcc, token: USDC }), ids.naive);
  const scripPayer = remember(makeScripPayer({
    agentId: ids.agent, contractId: ids.contract, mandateId, keyPair: kp.fc,
    getAccessKeyNonce: async () => (await provider.viewAccessKey({ accountId: ids.agent, publicKey: kp.fc.getPublicKey().toString(), finality: 'optimistic' })).nonce,
    getBlockHeight: async () => (await provider.viewBlock({ finality: 'optimistic' })).header.height,
    postRelay: async (body) => {
      const res = await fetchPaced(`${facUrl}/relay`, { method: 'POST', headers: { 'content-type': 'application/json' }, body });
      return { status: res.status, body: await res.json().catch(() => null), retryAfter: res.headers.get('retry-after') };
    },
    readTx: async (txHash) => {
      await sleep(7000); // let the ft_transfer + callback receipts finish before the FINAL lookup
      const info = await txInfo(txHash, RELAYER_ID);
      return { ...info, events: info.events.filter((e) => e.standard === 'scrip') };
    },
  }), RELAYER_ID);

  // 9. run both agents through the same three invoices
  const wholeBalance = {
    naive: async () => ft(ids.naive),
    scrip: async () => { const m = await view(ids.contract, 'get_mandate', { id: mandateId }); return BigInt(m.deposited) - BigInt(m.spent) - BigInt(m.reserved) - BigInt(m.withdrawn); },
  };
  const runOne = async (name, payer, balanceFn) => {
    const attackerBefore = await ft(ids.attacker);
    const own = { before: (await balanceFn()).toString(), invoices: [] };
    for (const mode of ['honest', 'injected', 'overcharge']) {
      merchant.setMode(mode);
      if (mode === 'injected') merchant.setAttackerAmount((await balanceFn()).toString());
      const r = await runAgent({ baseUrl: merchantUrl, payer });
      own.invoices.push({ mode, payTo: r.paidTo, amount: r.amount, obeyedInjection: r.obeyedInjection, paid: r.pay.ok, txHash: r.pay.txHash ?? null, rejectionCode: r.pay.code ?? null, delivered: r.delivered });
      console.log(name, mode, { paid: r.pay.ok, code: r.pay.code ?? null, delivered: r.delivered });
    }
    await sleep(3000);
    own.after = (await balanceFn()).toString();
    own.attackerGained = (await ft(ids.attacker) - attackerBefore).toString();
    results.agents[name] = own;
  };
  const realId = (a) => (a === 'attacker.testnet' ? ids.attacker : a === 'merchant.testnet' ? ids.merchant : a);
  const replayOne = async (name, payer, balanceFn) => {
    const attackerBefore = await ft(ids.attacker);
    const own = { before: (await balanceFn()).toString(), decisions: [] };
    for (const d of REPLAY.decisions) {
      const r = await payer.pay({ payTo: realId(d.recipient), amount: d.amount });
      own.decisions.push({ source: d.source, model: d.model, seed: d.seed, prompt: d.prompt, invoiceMode: d.invoiceMode, label: d.label,
        recipient: d.recipient, amount: d.amount, paid: r.ok, txHash: r.txHash ?? null, rejectionCode: r.code ?? null });
      console.log(name, d.model, d.label, { paid: r.ok, code: r.code ?? null });
    }
    await sleep(3000);
    own.after = (await balanceFn()).toString();
    own.attackerGained = (await ft(ids.attacker) - attackerBefore).toString();
    results.agents[name] = own;
  };
  if (REPLAY) {
    results.replaySource = REPLAY.source ?? null;
    await replayOne('naive', naivePayer, wholeBalance.naive);
    await replayOne('scrip', scripPayer, wholeBalance.scrip);
  } else {
    await runOne('naive', naivePayer, wholeBalance.naive);
    await runOne('scrip', scripPayer, wholeBalance.scrip);
  }

  // 10. owner revokes and withdraws the free remainder (so cleanup can sweep everything)
  results.txs.revoke = (await funder.callFunctionRaw({ contractId: ids.contract, methodName: 'revoke', args: { mandate_id: mandateId }, gas: T(30), deposit: 0n })).transaction.hash;
  const s = await view(ids.contract, 'get_mandate', { id: mandateId });
  const free = BigInt(s.deposited) - BigInt(s.spent) - BigInt(s.reserved) - BigInt(s.withdrawn);
  if (free > 0n) results.txs.withdraw = (await funder.callFunctionRaw({ contractId: ids.contract, methodName: 'withdraw', args: { mandate_id: mandateId, amount: free.toString() }, gas: T(100), deposit: 0n })).transaction.hash;
  results.mandateFinal = { spent: s.spent, reserved: s.reserved, deposited: s.deposited };
  results.facilitatorLog = fLog.split('\n').filter(Boolean).slice(-12).map((l) => l.slice(0, 200));
  results.ok = true;
}

async function cleanup() {
  if (merchant) { try { await merchant.close(); } catch { /* already closed */ } }
  if (facilitator) { facilitator.kill('SIGTERM'); await sleep(300); }
  if (policyFileForCleanup && existsSync(policyFileForCleanup)) unlinkSync(policyFileForCleanup);
  let clean = true;
  for (const a of created) {
    const acct = new Account(a.id, provider, new KeyPairSigner(a.key));
    try {
      const bal = await ft(a.id);
      if (bal > 0n) await acct.callFunctionRaw({ contractId: USDC, methodName: 'ft_transfer', args: { receiver_id: FUNDER_ID, amount: bal.toString() }, gas: T(50), deposit: 1n });
    } catch (e) { clean = false; console.error('sweep failed', a.id, e.message); }
    try { await acct.deleteAccount(FUNDER_ID); } catch (e) { clean = false; console.error('delete failed', a.id, e.message); }
    await sleep(400);
  }
  results.after = { funderNear: formatNearAmount(await near(FUNDER_ID)), funderUsdc: (await ft(FUNDER_ID)).toString(), relayerNear: formatNearAmount(await near(RELAYER_ID)) };
  const leftover = [];
  for (const a of created) { try { await near(a.id); leftover.push(a.id); } catch { /* deleted */ } }
  results.leftoverAccounts = leftover;
  if (clean && leftover.length === 0 && recoveryFile && existsSync(recoveryFile)) unlinkSync(recoveryFile);
  else console.error('NOT CLEAN: keep recovery file', recoveryFile);
  results.finishedAt = new Date().toISOString();
  mkdirSync(join(ROOT, 'results'), { recursive: true });
  writeFileSync(join(ROOT, 'results', OUT_FILE), JSON.stringify(results, null, 2));
  console.log('after', results.after, 'leftover', leftover);
}

try { await main(); } catch (e) { results.ok = false; results.error = String(e.message ?? e).slice(0, 400); console.error('DEMO ERROR:', results.error); } finally { await cleanup(); }
process.exit(results.ok ? 0 : 1);
