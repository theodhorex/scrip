// Gate (B5): one real end-to-end cycle on TESTNET through our own facilitator.
//   create accounts -> deploy final amanat.wasm -> create mandate -> fund (USDC) ->
//   agent FC key signs NEP-366 delegates -> POST /relay (facilitator pays gas) ->
//   valid payment settles, attacks are rejected -> revoke + withdraw -> sweep + delete accounts.
// Result: results/gate.json. Keys come only from files (env), never printed. Testnet only.
//
// usage: node scripts/gate.mjs        (needs: make contract-build, npm install in scripts/)
import { readFileSync, writeFileSync, existsSync, mkdirSync, unlinkSync, chmodSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import {
  Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate, nearToYocto, formatNearAmount,
} from 'near-api-js';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RPC = process.env.RPC_URL ?? 'https://rpc.testnet.fastnear.com';
const FUNDER_ID = process.env.FUNDER_ID ?? 'envtest-theo-1747.testnet';
const RELAYER_ID = process.env.RELAYER_ID ?? 'relayer-theo-1747.testnet';
const NEAR_DIR = process.env.KEY_DIR ?? '/home/theo/Documents/dev/hackathon/NEAR';
const FUNDER_KEY_FILE = process.env.FUNDER_KEY_FILE ?? join(NEAR_DIR, 'priv_key.txt');
const RELAYER_KEY_FILE = process.env.RELAYER_KEY_FILE ?? join(NEAR_DIR, 'priv_key_relayer.txt');
const USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const WASM = join(ROOT, 'contracts/amanat/target/wasm32-unknown-unknown/release/amanat.wasm');
const PORT = Number(process.env.PORT ?? 8791);

const T = (n) => BigInt(n) * 1_000_000_000_000n; // Tgas
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
for (const id of [FUNDER_ID, RELAYER_ID]) if (!id.endsWith('.testnet')) throw new Error('testnet only');

// Only 429 is retried (bounded); errors and aborts are never swallowed.
const realFetch = globalThis.fetch;
globalThis.fetch = async (...a) => {
  for (let i = 0; ; i++) {
    const res = await realFetch(...a);
    if (res.status !== 429 || i >= 6) return res;
    await sleep(Math.min(15000, 1000 * 2 ** i));
  }
};

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

// Plain JSON-RPC tx lookup with a hard timeout (no retries) to read events from receipts.
async function txEvents(txHash, sender) {
  for (let i = 0; i < 6; i++) {
    const ctl = new AbortController();
    const timer = setTimeout(() => ctl.abort(), 15000);
    try {
      const res = await realFetch(RPC, {
        method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tx', params: { tx_hash: txHash, sender_account_id: sender, wait_until: 'FINAL' } }),
      });
      const j = await res.json();
      if (j.result) {
        const logs = j.result.receipts_outcome.flatMap((o) => o.outcome.logs);
        const failure = j.result.receipts_outcome.map((o) => o.outcome.status).find((s) => s.Failure);
        return {
          logs, failed: Boolean(failure),
          events: logs.filter((l) => l.startsWith('EVENT_JSON:')).map((l) => JSON.parse(l.slice(11))),
          errors: logs.filter((l) => l.startsWith('AMANAT_ERR:')),
        };
      }
    } catch { /* retry */ } finally { clearTimeout(timer); }
    await sleep(2500);
  }
  return { logs: [], events: [], errors: [], failed: null, unreadable: true };
}

async function post(path, body) {
  const res = await realFetch(`http://127.0.0.1:${PORT}${path}`, {
    method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined,
  });
  return { status: res.status, body: await res.json().catch(() => null) };
}

const results = { network: 'testnet', startedAt: new Date().toISOString(), steps: {}, txs: {} };
const created = []; // accounts to clean
let facilitator = null;
let recoveryFile = null;
let policyFileForCleanup = null;

async function main() {
  const ts = Date.now() % 100000;
  const id = (p) => `${p}${ts}.${FUNDER_ID}`;
  const contractId = id('amc');
  const agentId = id('ama');
  const guardianId = id('amg');
  const merchantId = id('amm');
  const kp = Object.fromEntries(['contract', 'agent', 'fc', 'guardian', 'merchant'].map((k) => [k, KeyPair.fromRandom('ed25519')]));

  // Recovery file BEFORE any account exists (mode 0600, gitignored).
  recoveryFile = join(HERE, `.recovery-gate-${ts}.json`);
  writeFileSync(recoveryFile, JSON.stringify({ accounts: [
    { id: contractId, key: kp.contract.toString() }, { id: agentId, key: kp.agent.toString() },
    { id: guardianId, key: kp.guardian.toString() }, { id: merchantId, key: kp.merchant.toString() },
  ] }), { mode: 0o600 });
  chmodSync(recoveryFile, 0o600);

  results.before = { funderNear: formatNearAmount(await near(FUNDER_ID)), funderUsdc: (await ft(FUNDER_ID)).toString(), relayerNear: formatNearAmount(await near(RELAYER_ID)) };
  console.log('before', results.before);
  if (BigInt(await near(FUNDER_ID)) < nearToYocto('5')) throw new Error('BLOCKED: funder below 5 NEAR');

  const mk = async (acct, key, near_) => {
    await funder.createSubAccount({ accountOrPrefix: acct, publicKey: key.getPublicKey().toString(), nearToTransfer: nearToYocto(near_) });
    created.push({ id: acct, key });
    await sleep(500);
  };
  await mk(contractId, kp.contract, '3.4');
  await mk(agentId, kp.agent, '0.5');
  await mk(guardianId, kp.guardian, '0.2');
  await mk(merchantId, kp.merchant, '0.15');
  const acc = (i, k) => new Account(i, provider, new KeyPairSigner(k));
  const contractAcc = acc(contractId, kp.contract);
  const agentAdmin = acc(agentId, kp.agent);

  // 1. deploy + init
  const wasm = readFileSync(WASM);
  const dep = await contractAcc.deployContract(wasm);
  results.txs.deploy = dep.transaction.hash;
  results.wasmBytes = wasm.length;
  const init = await funder.callFunctionRaw({ contractId, methodName: 'new', args: {}, gas: T(30), deposit: 0n });
  results.txs.init = init.transaction.hash;

  // 2. USDC registrations (contract must receive; merchant must receive)
  for (const who of [contractId, merchantId]) {
    await funder.callFunctionRaw({ contractId: USDC, methodName: 'storage_deposit', args: { account_id: who, registration_only: true }, gas: T(30), deposit: nearToYocto('0.00125') });
    await sleep(400);
  }

  // 3. mandate: budget 1.25 USDC, cap/threshold 0.5 USDC, one allowed recipient
  const expiresAt = Date.now() + 2 * 3600 * 1000;
  const cm = await funder.callFunctionRaw({
    contractId, methodName: 'create_mandate', gas: T(60), deposit: nearToYocto('0.05'),
    args: { agent: agentId, guardian: guardianId, token: USDC, budget: '1250000', per_payment_cap: '500000', approval_threshold: '500000', recipients: [merchantId], expires_at_ms: expiresAt },
  });
  results.txs.createMandate = cm.transaction.hash;
  const mandateId = JSON.parse(Buffer.from(cm.status.SuccessValue, 'base64').toString());
  console.log('mandate id', mandateId);

  // 4. fund through the token (ft_transfer_call -> ft_on_transfer)
  const fund = await funder.callFunctionRaw({ contractId: USDC, methodName: 'ft_transfer_call', args: { receiver_id: contractId, amount: '1250000', msg: JSON.stringify({ mandate_id: mandateId }) }, gas: T(100), deposit: 1n });
  results.txs.fund = fund.transaction.hash;
  const m0 = await view(contractId, 'get_mandate', { id: mandateId });
  results.steps.funded = { deposited: m0.deposited, contractUsdc: (await ft(contractId)).toString() };
  if (m0.deposited !== '1250000') throw new Error(`funding failed: ${JSON.stringify(m0)}`);

  // 5. agent function-call key (request_payment on this contract only)
  await agentAdmin.addFunctionCallAccessKey({ publicKey: kp.fc.getPublicKey(), contractId, methodNames: ['request_payment'], allowance: nearToYocto('0.25') });
  const agentFc = acc(agentId, kp.fc);

  // 6. start OUR facilitator (separate process, reads relayer key from file)
  policyFileForCleanup = join(HERE, `.policy-gate-${ts}.json`);
  const policyFile = policyFileForCleanup;
  writeFileSync(policyFile, JSON.stringify({
    network: 'testnet', contractId, allowedMethods: ['request_payment'], allowedAgents: [agentId], maxGas: '150000000000000',
    maxBlockHeightWindow: 300, minBlockHeightMargin: 5, rateLimit: { capacity: 8, refillPerSecond: 1 }, rpcUrl: RPC,
  }));
  facilitator = spawn('node', [join(ROOT, 'facilitator/src/main.mjs')], {
    env: { ...process.env, POLICY_FILE: policyFile, RELAYER_ACCOUNT_ID: RELAYER_ID, RELAYER_KEY_FILE, PORT: String(PORT), RPC_URL: RPC },
    stdio: ['ignore', 'pipe', 'pipe'],
  });
  let fLog = '';
  facilitator.stdout.on('data', (d) => { fLog += d; });
  facilitator.stderr.on('data', (d) => { fLog += d; });
  for (let i = 0; i < 30; i++) { try { if ((await post('/health')).status === 200) break; } catch { /* not up yet */ } await sleep(300); }
  if ((await post('/health')).status !== 200) throw new Error(`facilitator did not start: ${fLog.slice(0, 300)}`);

  // helper: sign a delegate with the agent FC key and send it through the facilitator
  let nonceCounter = 1;
  const relay = async (method, args, gas = T(100)) => {
    const signed = await agentFc.createSignedMetaTransaction({ receiverId: contractId, actions: [actions.functionCall(method, args, gas, 0n)], blockHeightTtl: 100 });
    const b64 = Buffer.from(encodeSignedDelegate(signed.signedDelegate)).toString('base64');
    return post('/relay', { signed_delegate: b64 });
  };
  const pay = (recipient, amount) => relay('request_payment', { mandate_id: mandateId, recipient, amount, nonce: nonceCounter++ });
  const state = async () => view(contractId, 'get_mandate', { id: mandateId });

  // 7. GATE: one valid payment end to end
  const merchBefore = await ft(merchantId);
  const r1 = await pay(merchantId, '500000');
  console.log('relay valid ->', r1.status, r1.body);
  if (r1.status !== 200) throw new Error(`gate failed: ${JSON.stringify(r1)}`);
  results.txs.validPayment = r1.body.tx_hash;
  await sleep(8000);
  const ev1 = await txEvents(r1.body.tx_hash, RELAYER_ID);
  const s1 = await state();
  results.steps.validPayment = { http: r1.status, events: ev1.events.map((e) => e.event), spent: s1.spent, reserved: s1.reserved, merchantGained: (await ft(merchantId) - merchBefore).toString() };
  console.log('valid payment', results.steps.validPayment);

  // 8. attacks through the same facilitator
  const attacks = {};
  const stranger = await pay(FUNDER_ID, '100000'); // recipient not on the list
  await sleep(7000);
  const evS = stranger.status === 200 ? await txEvents(stranger.body.tx_hash, RELAYER_ID) : null;
  attacks.recipientNotAllowed = { http: stranger.status, tx: stranger.body?.tx_hash, rejected: evS?.events.filter((e) => e.event === 'rejected').map((e) => e.data[0].code) };
  const big = await pay(merchantId, '500001'); // above the per-payment cap
  await sleep(7000);
  const evB = big.status === 200 ? await txEvents(big.body.tx_hash, RELAYER_ID) : null;
  attacks.overCap = { http: big.status, tx: big.body?.tx_hash, rejected: evB?.events.filter((e) => e.event === 'rejected').map((e) => e.data[0].code) };
  const wrong = await relay('approve_intent', { mandate_id: mandateId, recipient: merchantId, amount: '1', nonce: 9, approval_expires_at_ms: Date.now() + 60000 }); // agent tries a guardian method
  attacks.guardianMethodViaRelay = { http: wrong.status, code: wrong.body?.code };
  const lowgas = await relay('request_payment', { mandate_id: mandateId, recipient: merchantId, amount: '100000', nonce: nonceCounter++ }, T(30));
  // the facilitator now refuses gas below 60 Tgas before spending any relayer gas
  attacks.lowGas = { http: lowgas.status, code: lowgas.body?.code };
  // a delegate signed by a key that is NOT an access key of the agent (random key, agent's id)
  const forgedKey = KeyPair.fromRandom('ed25519');
  // built by hand: this key has no access key on chain, so the SDK helper cannot fetch a nonce for it
  const forgedSigner = new KeyPairSigner(forgedKey);
  const head = await provider.viewBlock({ finality: 'optimistic' });
  const forgedDelegate = buildDelegateAction({
    senderId: agentId, receiverId: contractId, nonce: 1_000_000_000n, maxBlockHeight: BigInt(head.header.height) + 100n,
    publicKey: await forgedSigner.getPublicKey(),
    actions: [actions.functionCall('request_payment', { mandate_id: mandateId, recipient: merchantId, amount: '100000', nonce: 77 }, T(100), 0n)],
  });
  const forgedSigned = await forgedSigner.signDelegateAction(forgedDelegate);
  const forged = await post('/relay', { signed_delegate: Buffer.from(encodeSignedDelegate(forgedSigned.signedDelegate)).toString('base64') });
  attacks.forgedKey = { http: forged.status, code: forged.body?.code };
  results.steps.attacks = attacks;
  console.log('attacks', JSON.stringify(attacks));

  // second valid payment fills the budget partially; third exceeds the budget
  const r2 = await pay(merchantId, '500000');
  await sleep(7000);
  const r3 = await pay(merchantId, '500000'); // 1.5 > 1.25 budget
  await sleep(7000);
  const ev3 = r3.status === 200 ? await txEvents(r3.body.tx_hash, RELAYER_ID) : null;
  const s3 = await state();
  results.steps.budget = { second: r2.status, thirdRejected: ev3?.events.filter((e) => e.event === 'rejected').map((e) => e.data[0].code), spent: s3.spent, reserved: s3.reserved, budget: s3.budget };

  // 9. owner revokes, withdraws the free remainder
  const rv = await funder.callFunctionRaw({ contractId, methodName: 'revoke', args: { mandate_id: mandateId }, gas: T(30), deposit: 0n });
  results.txs.revoke = rv.transaction.hash;
  const sAfter = await state();
  const free = BigInt(sAfter.deposited) - BigInt(sAfter.spent) - BigInt(sAfter.reserved) - BigInt(sAfter.withdrawn);
  const usdcBeforeW = await ft(FUNDER_ID);
  const wd = await funder.callFunctionRaw({ contractId, methodName: 'withdraw', args: { mandate_id: mandateId, amount: free.toString() }, gas: T(100), deposit: 0n });
  results.txs.withdraw = wd.transaction.hash;
  await sleep(3000);
  const sFinal = await state();
  results.steps.exit = { revoked: sAfter.status, freeRemainder: free.toString(), funderUsdcGain: (await ft(FUNDER_ID) - usdcBeforeW).toString(), withdrawn: sFinal.withdrawn, spent: sFinal.spent, reserved: sFinal.reserved, contractUsdcLeft: (await ft(contractId)).toString() };
  results.facilitatorLog = fLog.split('\n').filter(Boolean).slice(-12).map((l) => l.slice(0, 200));
  results.ok = true;
  console.log('exit', results.steps.exit);
}

async function cleanup() {
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
  writeFileSync(join(ROOT, 'results/gate.json'), JSON.stringify(results, null, 2));
  console.log('after', results.after, 'leftover', leftover);
}

try { await main(); } catch (e) { results.ok = false; results.error = String(e.message ?? e).slice(0, 400); console.error('GATE ERROR:', results.error); } finally { await cleanup(); }
process.exit(results.ok ? 0 : 1);
