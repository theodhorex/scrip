// Read-only check of every tx hash recorded in results/*.json against the public testnet JSON-RPC.
// For each hash: does the chain know it, and is its execution status a success?
// No keys, no transactions. Usage: node scripts/verify-links.mjs   (exit 1 if any hash is not verified)
import { readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const RESULTS = join(HERE, '..', 'results');
const RPC = process.env.RPC_URL ?? 'https://rpc.testnet.fastnear.com';
const B58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ACCOUNT = /[a-z0-9_.-]+\.testnet/g;
const HASH_IN_TEXT = /[1-9A-HJ-NP-Za-km-z]{43,44}/g;

// Walk a JSON value; collect {hash, path}. Hashes embedded in log strings (facilitatorLog) count too.
export function extractHashes(value, path = '$', out = new Map()) {
  if (typeof value === 'string') {
    if (B58_HASH.test(value)) { if (!out.has(value)) out.set(value, path); }
    else if (path.includes('Log')) {
      const m = value.match(/"tx":"([1-9A-HJ-NP-Za-km-z]{43,44})"/);
      if (m && !out.has(m[1])) out.set(m[1], path);
    }
  } else if (Array.isArray(value)) value.forEach((v, i) => extractHashes(v, `${path}[${i}]`, out));
  else if (value && typeof value === 'object') for (const [k, v] of Object.entries(value)) extractHashes(v, `${path}.${k}`, out);
  return out;
}

export function accountsIn(text) { return [...new Set(text.match(ACCOUNT) ?? [])]; }

/** Classify a `tx` RPC result. */
export function classify(result) {
  const st = result?.status;
  if (!st) return { ok: false, why: 'no status' };
  if (st.Failure) return { ok: false, why: 'tx failed' };
  const failedReceipt = (result.receipts_outcome ?? []).some((o) => o.outcome?.status?.Failure);
  return { ok: Boolean(st.SuccessValue !== undefined || st.SuccessReceiptId), receiptFailure: failedReceipt, why: failedReceipt ? 'tx ok, a receipt failed' : 'ok' };
}

async function rpc(method, params) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 20000);
  try {
    const res = await fetch(RPC, { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method, params }) });
    return await res.json();
  } finally { clearTimeout(timer); }
}

async function lookup(hash, senders) {
  for (const sender of senders) {
    for (const method of ['tx', 'EXPERIMENTAL_tx_status']) {
      try {
        const j = await rpc(method, { tx_hash: hash, sender_account_id: sender, wait_until: 'FINAL' });
        if (j.result) return { sender, result: j.result };
      } catch { /* try next */ }
    }
  }
  return null;
}

async function main() {
  const files = readdirSync(RESULTS).filter((f) => f.endsWith('.json')).sort();
  const funder = process.env.FUNDER_ID ?? 'envtest-theo-1747.testnet';
  const relayer = process.env.RELAYER_ID ?? 'relayer-theo-1747.testnet';
  let bad = 0; let total = 0;
  for (const f of files) {
    const text = readFileSync(join(RESULTS, f), 'utf8');
    const hashes = extractHashes(JSON.parse(text));
    // Candidate senders: ids that appear in the file (sub-accounts of the funder, funder, relayer).
    const senders = [...new Set([funder, relayer, ...accountsIn(text)])];
    for (const [hash, path] of hashes) {
      total++;
      const r = await lookup(hash, senders);
      if (!r) { bad++; console.log(`NOT FOUND   ${f} ${path} ${hash}`); continue; }
      const c = classify(r.result);
      if (!c.ok) bad++;
      console.log(`${c.ok ? 'OK         ' : 'FAILED     '} ${f} ${path} ${hash} (${c.why})`);
    }
  }
  console.log(`${total - bad}/${total} verified`);
  if (bad) process.exit(1);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((e) => { console.error('VERIFY ERROR:', String(e.message ?? e).slice(0, 200)); process.exit(2); });
}
