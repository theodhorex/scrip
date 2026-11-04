// Recover orphaned TESTNET sub-accounts left by an interrupted gate/attack/demo run.
// Reads scripts/.recovery-*.json ({ accounts: [{ id, key }] }), and for each account that still exists:
// sweeps its USDC to the funder, then deletes the account with the funder as beneficiary.
//
//   node scripts/recover.mjs            dry run (default): prints the plan, sends nothing
//   node scripts/recover.mjs --apply    sends transactions
//
// recovery files. No key is ever printed. Testnet only; refuses ids that are not sub-accounts of the funder.
import { readFileSync, readdirSync, unlinkSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';

// ---- pure selection logic (unit tested) ----


/** True only when the RPC error says the account does not exist. Rate limits and network errors are NOT "gone". */
export function isAccountMissingError(e) {
  const text = [e?.type, e?.name, e?.code, e?.message, e?.cause?.message].filter(Boolean).join(' ');
  return /UNKNOWN_ACCOUNT|AccountDoesNotExist|does not exist|doesn'?t exist/i.test(text);
}

/** True for transient RPC failures worth retrying (429, 5xx, network). */
export function isTransientRpcError(e) {
  const text = [e?.message, e?.cause?.message].filter(Boolean).join(' ');
  return /429|rate limit|fetch failed|ECONN|ETIMEDOUT|timeout|502|503|504|socket/i.test(text);
}

/** Retries a transient failure with a growing pause; any other error is thrown at once. */
export async function withRpcRetry(fn, { tries = 8, baseMs = 1500, sleep = (ms) => new Promise((r) => setTimeout(r, ms)) } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries || !isTransientRpcError(e)) throw e;
      await sleep(baseMs * (i + 1));
    }
  }
}

/** Parse a recovery file body; returns [{id,key}] with only well-formed entries. */
export function parseRecovery(text) {
  let j;
  try { j = JSON.parse(text); } catch { return []; }
  if (!j || !Array.isArray(j.accounts)) return [];
  return j.accounts.filter((a) => a && typeof a.id === 'string' && typeof a.key === 'string' && a.key.startsWith('ed25519:'));
}

/** An account is safe to touch only if it is a testnet sub-account of the funder. */
export function isRecoverable(id, funderId) {
  return id.endsWith('.testnet') && id !== funderId && id.endsWith(`.${funderId}`);
}

/**
 * Build the plan. `state` maps id -> { exists: bool, usdc: bigint }.
 * Returns { actions: [{id, key, sweep: bigint, delete: true}], skipped: [{id, reason}] }.
 */
export function buildPlan(entries, funderId, state) {
  const actions = [];
  const skipped = [];
  const seen = new Set();
  for (const e of entries) {
    if (seen.has(e.id)) { skipped.push({ id: e.id, reason: 'duplicate' }); continue; }
    seen.add(e.id);
    if (!isRecoverable(e.id, funderId)) { skipped.push({ id: e.id, reason: 'not a sub-account of the funder' }); continue; }
    const s = state[e.id];
    if (!s || !s.exists) { skipped.push({ id: e.id, reason: 'already gone' }); continue; }
    actions.push({ id: e.id, key: e.key, sweep: s.usdc > 0n ? s.usdc : 0n, delete: true });
  }
  return { actions, skipped };
}

// ---- CLI ----
async function main() {
  const apply = process.argv.includes('--apply');
  const RPC = process.env.RPC_URL ?? 'https://rpc.testnet.fastnear.com';
  const FUNDER_ID = process.env.FUNDER_ID ?? 'envtest-theo-1747.testnet';
  const KEY_DIR = process.env.KEY_DIR;
  if (!FUNDER_ID.endsWith('.testnet')) throw new Error('testnet only');

  const files = readdirSync(HERE).filter((f) => /^\.recovery-.*\.json$/.test(f));
  if (files.length === 0) { console.log('no .recovery-*.json files: nothing to recover'); return; }
  const per = files.map((f) => ({ f, entries: parseRecovery(readFileSync(join(HERE, f), 'utf8')) }));
  const entries = per.flatMap((p) => p.entries);

  const { JsonRpcProvider, Account, KeyPair, KeyPairSigner } = await import('near-api-js');
  const provider = new JsonRpcProvider({ url: RPC });
  // A read that fails for any reason other than "account does not exist" aborts: guessing 0 USDC or "gone"
  // could delete an account that still holds funds.
  const ftBal = (id) => withRpcRetry(async () => BigInt(await provider.callFunction({ contractId: USDC, method: 'ft_balance_of', args: { account_id: id } }) || '0'));
  const state = {};
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  for (const e of entries) {
    try {
      await withRpcRetry(() => provider.viewAccount({ accountId: e.id }));
      state[e.id] = { exists: true, usdc: await ftBal(e.id) };
    } catch (err) {
      if (!isAccountMissingError(err)) throw new Error(`cannot read state of ${e.id}: ${String(err.message ?? err).slice(0, 120)}`);
      state[e.id] = { exists: false, usdc: 0n };
    }
    await sleep(400);
  }
  const plan = buildPlan(entries, FUNDER_ID, state);
  for (const s of plan.skipped) console.log('skip  ', s.id, '-', s.reason);
  for (const a of plan.actions) console.log(apply ? 'apply ' : 'dryrun', a.id, 'sweep', a.sweep.toString(), 'USDC units, then delete -> beneficiary', FUNDER_ID);
  if (!apply) { console.log('dry run only; pass --apply to execute'); return; }

  const T = (n) => BigInt(n) * 1_000_000_000_000n;
  let clean = true;
  for (const a of plan.actions) {
    const acct = new Account(a.id, provider, new KeyPairSigner(KeyPair.fromString(a.key)));
    try {
      if (a.sweep > 0n) await withRpcRetry(() => acct.callFunctionRaw({ contractId: USDC, methodName: 'ft_transfer', args: { receiver_id: FUNDER_ID, amount: a.sweep.toString() }, gas: T(50), deposit: 1n }));
    } catch (e) { clean = false; console.error('sweep failed', a.id, String(e.message).slice(0, 120)); continue; }
    try { await withRpcRetry(() => acct.deleteAccount(FUNDER_ID)); console.log('deleted', a.id); }
    catch (e) { clean = false; console.error('delete failed', a.id, String(e.message).slice(0, 120)); }
    await sleep(500);
  }
  if (clean) for (const f of files) unlinkSync(join(HERE, f));
  else console.error('NOT CLEAN: recovery files kept');
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('RECOVER ERROR:', String(e.message ?? e).slice(0, 300)); process.exit(1); });
}
