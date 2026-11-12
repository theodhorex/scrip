#!/usr/bin/env node
// scripts/verify-onchain.mjs
// Read-only verification of results/*.json transactions against public NEAR testnet RPC.
// Node 20+, zero npm dependencies.
import { readFileSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import crypto from 'node:crypto';

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, '..');
const RESULTS_DIR = join(ROOT, 'results');
const DEFAULT_RPC = 'https://archival-rpc.testnet.fastnear.com';
const B58_ALPHABET = '123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
const B58_HASH = /^[1-9A-HJ-NP-Za-km-z]{43,44}$/;
const ACCOUNT_REGEX = /[a-z0-9_.-]+\.testnet/g;

/** Base58 encode a Buffer/Uint8Array without third-party dependencies */
export function toBase58(buffer) {
  if (!buffer || buffer.length === 0) return '';
  const digits = [];
  for (let i = 0; i < buffer.length; i++) {
    let carry = buffer[i];
    for (let j = 0; j < digits.length; ++j) {
      carry += digits[j] << 8;
      digits[j] = carry % 58;
      carry = (carry / 58) | 0;
    }
    while (carry > 0) {
      digits.push(carry % 58);
      carry = (carry / 58) | 0;
    }
  }
  let str = '';
  for (let i = 0; i < buffer.length && buffer[i] === 0; i++) str += '1';
  for (let i = digits.length - 1; i >= 0; i--) str += B58_ALPHABET[digits[i]];
  return str;
}

export function accountsInText(text) {
  return [...new Set(text.match(ACCOUNT_REGEX) ?? [])];
}

/**
 * Parse results files to extract claimed txs and expectations.
 * @param {Record<string, unknown>} docsMap { 'demo.json': parsedJson, ... }
 */
export function parseClaimedTxs(docsMap) {
  const items = [];

  for (const [file, doc] of Object.entries(docsMap)) {
    if (!doc || typeof doc !== 'object') continue;
    const rawText = JSON.stringify(doc);
    const docAccounts = accountsInText(rawText);
    const candidateSenders = [
      ...new Set([
        process.env.RELAYER_ID ?? 'relayer-theo-1747.testnet',
        process.env.FUNDER_ID ?? 'envtest-theo-1747.testnet',
        ...docAccounts,
      ].filter((a) => a.endsWith('.testnet'))),
    ];

    if (file === 'demo.json') {
      // Invoices
      const agents = doc.agents ?? {};
      for (const [agentName, agentData] of Object.entries(agents)) {
        for (let idx = 0; idx < (agentData.invoices ?? []).length; idx++) {
          const inv = agentData.invoices[idx];
          if (!inv.txHash || !B58_HASH.test(inv.txHash)) continue;
          const isSuccess = inv.paid === true && !inv.rejectionCode;
          items.push({
            file,
            label: `agents.${agentName}.invoices[${idx}]`,
            txHash: inv.txHash,
            expectedStatus: isSuccess ? 'SUCCESS' : 'REJECTED',
            expectedCode: inv.rejectionCode ?? null,
            candidateSenders,
          });
        }
      }

      // txs block
      if (doc.txs && typeof doc.txs === 'object') {
        for (const [name, hash] of Object.entries(doc.txs)) {
          if (!hash || !B58_HASH.test(hash)) continue;
          items.push({
            file,
            label: `txs.${name}`,
            txHash: hash,
            expectedStatus: 'SUCCESS',
            expectedCode: null,
            candidateSenders,
          });
        }
      }
    } else if (file === 'gate.json') {
      // attacks block
      const attacks = doc.steps?.attacks ?? {};
      if (attacks.recipientNotAllowed?.tx && B58_HASH.test(attacks.recipientNotAllowed.tx)) {
        items.push({
          file,
          label: 'steps.attacks.recipientNotAllowed',
          txHash: attacks.recipientNotAllowed.tx,
          expectedStatus: 'REJECTED',
          expectedCode: 'RECIPIENT_NOT_ALLOWED',
          candidateSenders,
        });
      }
      if (attacks.overCap?.tx && B58_HASH.test(attacks.overCap.tx)) {
        items.push({
          file,
          label: 'steps.attacks.overCap',
          txHash: attacks.overCap.tx,
          expectedStatus: 'REJECTED',
          expectedCode: 'OVER_PER_PAYMENT_CAP',
          candidateSenders,
        });
      }

      // txs block
      if (doc.txs && typeof doc.txs === 'object') {
        for (const [name, hash] of Object.entries(doc.txs)) {
          if (!hash || !B58_HASH.test(hash)) continue;
          items.push({
            file,
            label: `txs.${name}`,
            txHash: hash,
            expectedStatus: 'SUCCESS',
            expectedCode: null,
            candidateSenders,
          });
        }
      }
    } else if (file === 'attack.json') {
      // Benchmark catalog results: contains aggregate cases, not individual transaction hashes.
      // Handled cleanly with 0 tx entries.
    }
  }

  // Deduplicate by txHash if needed while preserving label context
  const seen = new Set();
  const deduped = [];
  for (const item of items) {
    if (!seen.has(item.txHash)) {
      seen.add(item.txHash);
      deduped.push(item);
    }
  }

  return deduped;
}

/** Classify raw NEAR RPC transaction response */
export function classifyOnchainResult(result) {
  if (!result) return { status: 'UNVERIFIABLE', code: null, error: 'empty RPC response' };

  const txStatus = result.status;
  if (txStatus?.Failure) {
    return {
      status: 'FAILURE',
      code: null,
      error: typeof txStatus.Failure === 'string' ? txStatus.Failure : JSON.stringify(txStatus.Failure),
    };
  }

  const outcomes = result.receipts_outcome ?? [];
  for (const o of outcomes) {
    const outcome = o.outcome ?? {};

    if (outcome.status?.Failure) {
      return {
        status: 'FAILURE',
        code: null,
        error: typeof outcome.status.Failure === 'string' ? outcome.status.Failure : JSON.stringify(outcome.status.Failure),
      };
    }

    const val = outcome.status?.SuccessValue;
    if (val) {
      try {
        const decoded = Buffer.from(val, 'base64').toString('utf8');
        const parsed = JSON.parse(decoded);
        if (parsed?.Rejected?.code) {
          return { status: 'REJECTED', code: parsed.Rejected.code, error: null };
        }
      } catch {
        // Ignored
      }
    }

    for (const log of (outcome.logs ?? [])) {
      if (typeof log === 'string' && log.startsWith('EVENT_JSON:')) {
        try {
          const ev = JSON.parse(log.slice('EVENT_JSON:'.length));
          if (ev.event === 'rejected' && Array.isArray(ev.data) && ev.data[0]?.code) {
            return { status: 'REJECTED', code: ev.data[0].code, error: null };
          }
        } catch {
          // Ignored
        }
      }
    }
  }

  if (txStatus?.SuccessValue !== undefined || txStatus?.SuccessReceiptId) {
    return { status: 'SUCCESS', code: null, error: null };
  }

  return { status: 'UNVERIFIABLE', code: null, error: 'unrecognized outcome status' };
}

/** Match claimed outcome against classified onchain outcome */
export function matchClaimWithOnchain(claim, onchain) {
  if (onchain.status === 'UNVERIFIABLE') {
    return { outcome: 'UNVERIFIABLE', reason: onchain.error ?? 'unverifiable' };
  }

  if (claim.expectedStatus === 'SUCCESS') {
    if (onchain.status === 'SUCCESS') {
      return { outcome: 'VERIFIED', reason: 'matches claimed success' };
    }
    if (onchain.status === 'REJECTED') {
      return { outcome: 'MISMATCHED', reason: `expected SUCCESS but was rejected: ${onchain.code}` };
    }
    return { outcome: 'MISMATCHED', reason: `expected SUCCESS but tx failed: ${onchain.error ?? 'unknown'}` };
  }

  if (claim.expectedStatus === 'REJECTED') {
    if (onchain.status === 'REJECTED') {
      if (!claim.expectedCode || claim.expectedCode === onchain.code) {
        return { outcome: 'VERIFIED', reason: `rejected with expected ${onchain.code}` };
      }
      return { outcome: 'MISMATCHED', reason: `expected rejection ${claim.expectedCode} but got ${onchain.code}` };
    }
    if (onchain.status === 'SUCCESS') {
      return { outcome: 'MISMATCHED', reason: `expected REJECTED(${claim.expectedCode}) but tx succeeded` };
    }
    return { outcome: 'MISMATCHED', reason: `expected REJECTED(${claim.expectedCode}) but failed with: ${onchain.error}` };
  }

  return { outcome: 'UNVERIFIABLE', reason: 'unknown claimed status' };
}

/** Summarize array of { outcome: 'VERIFIED' | 'MISMATCHED' | 'UNVERIFIABLE' } */
export function summarizeResults(items) {
  let verified = 0;
  let mismatched = 0;
  let unverifiable = 0;

  for (const item of items) {
    if (item.outcome === 'VERIFIED') verified++;
    else if (item.outcome === 'MISMATCHED') mismatched++;
    else unverifiable++;
  }

  let exitCode = 0;
  if (mismatched > 0) exitCode = 1;
  else if (unverifiable > 0) exitCode = 2;

  return { verified, mismatched, unverifiable, exitCode };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** Query RPC with retries for 429/5xx and timeout */
export async function queryTxStatus(txHash, candidateSenders, options = {}) {
  const fetchFn = options.fetchFn ?? globalThis.fetch;
  const rpcUrl = options.rpcUrl ?? process.env.NEAR_RPC ?? DEFAULT_RPC;
  const maxRetries = options.maxRetries ?? 4;
  const baseDelayMs = options.baseDelayMs ?? 1000;
  const timeoutMs = options.timeoutMs ?? 8000;

  if (!candidateSenders || candidateSenders.length === 0) {
    return { status: 'UNVERIFIABLE', code: null, error: 'missing sender account id' };
  }

  for (const sender of candidateSenders) {
    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      const ctl = new AbortController();
      const timer = setTimeout(() => ctl.abort(), timeoutMs);

      try {
        const res = await fetchFn(rpcUrl, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({
            jsonrpc: '2.0',
            id: 1,
            method: 'EXPERIMENTAL_tx_status',
            params: [txHash, sender],
          }),
          signal: ctl.signal,
        });

        clearTimeout(timer);

        const data = await res.json().catch(() => null);

        // Handle in-body JSON-RPC 429 rate limit errors
        if (data?.error?.code === -429 || res.status === 429 || (res.status >= 500 && res.status < 600)) {
          if (attempt < maxRetries) {
            await sleep(baseDelayMs * 2 ** attempt);
            continue;
          }
          return { status: 'UNVERIFIABLE', code: null, error: (data?.error?.message ?? `HTTP ${res.status}`) + ' after retries' };
        }

        if (data?.result) {
          const classified = classifyOnchainResult(data.result);
          return { ...classified, senderUsed: sender };
        }

        // If unknown transaction or handler error, try next sender or method
        if (data?.error?.cause?.name === 'UNKNOWN_TRANSACTION') {
          break; // Try next candidate sender
        }
      } catch (err) {
        clearTimeout(timer);
        if (attempt < maxRetries) {
          await sleep(baseDelayMs * 2 ** attempt);
          continue;
        }
        return { status: 'UNVERIFIABLE', code: null, error: err.message ?? String(err) };
      }
    }
  }

  return { status: 'UNVERIFIABLE', code: null, error: 'transaction not found for candidate senders' };
}

/** Check contract account on chain (optional step) */
export async function checkContractAccount(contractId, rpcUrl, fetchFn = globalThis.fetch) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), 6000);

  try {
    const res = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'query',
        params: { request_type: 'view_account', finality: 'final', account_id: contractId },
      }),
      signal: ctl.signal,
    });
    clearTimeout(timer);
    const data = await res.json().catch(() => null);
    if (data?.error) {
      return { ok: false, exists: false, error: data.error.data ?? data.error.message };
    }

    const codeHash = data?.result?.code_hash;

    // Check access keys
    const resKeys = await fetchFn(rpcUrl, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        jsonrpc: '2.0',
        id: 1,
        method: 'query',
        params: { request_type: 'view_access_key_list', finality: 'final', account_id: contractId },
      }),
    });
    const keysData = await resKeys.json().catch(() => null);
    const keys = keysData?.result?.keys ?? [];
    const hasFullAccess = keys.some((k) => k.access_key?.permission === 'FullAccess');

    return {
      ok: true,
      exists: true,
      codeHash,
      hasFullAccess,
      keyCount: keys.length,
    };
  } catch (err) {
    clearTimeout(timer);
    return { ok: false, exists: false, error: err.message ?? String(err) };
  }
}

async function main() {
  const args = process.argv.slice(2);
  const isJson = args.includes('--json');
  const rpcUrl = process.env.NEAR_RPC ?? DEFAULT_RPC;

  // Load results files
  const fileNames = ['demo.json', 'gate.json', 'attack.json'];
  const docsMap = {};
  for (const name of fileNames) {
    const p = join(RESULTS_DIR, name);
    if (existsSync(p)) {
      try {
        docsMap[name] = JSON.parse(readFileSync(p, 'utf8'));
      } catch (e) {
        if (!isJson) console.error(`Warning: could not parse ${name}: ${e.message}`);
      }
    }
  }

  const items = parseClaimedTxs(docsMap);
  const results = [];

  if (!isJson) {
    console.log(`Checking ${items.length} recorded transactions against ${rpcUrl} ...\n`);
  }

  for (const item of items) {
    const onchain = await queryTxStatus(item.txHash, item.candidateSenders, { rpcUrl });
    const matched = matchClaimWithOnchain(item, onchain);
    const shortHash = `${item.txHash.slice(0, 8)}...${item.txHash.slice(-6)}`;

    const record = {
      file: item.file,
      label: item.label,
      txHash: item.txHash,
      shortHash,
      claimed: item.expectedStatus + (item.expectedCode ? `(${item.expectedCode})` : ''),
      onchain: onchain.status + (onchain.code ? `(${onchain.code})` : ''),
      outcome: matched.outcome,
      reason: matched.reason,
    };
    results.push(record);

    if (!isJson) {
      const outcomeTag = matched.outcome.padEnd(12);
      const claimedTag = `[claimed: ${record.claimed}]`.padEnd(32);
      const onchainTag = `[onchain: ${record.onchain}]`.padEnd(30);
      console.log(`${outcomeTag} ${shortHash}  ${claimedTag}  ${onchainTag}  (${matched.reason})`);
    }

    // Delay between calls to respect rate limits
    await sleep(200);
  }

  // Optional contract check
  let contractCheckResult = null;
  const contractId = process.env.CONTRACT_ID ?? process.env.SCRIP_CONTRACT_ID;
  const wasmPath = join(ROOT, 'contracts/scrip/target/wasm32-unknown-unknown/release/scrip.wasm');
  let localWasmHash = null;

  if (existsSync(wasmPath)) {
    try {
      const wasmBuf = readFileSync(wasmPath);
      localWasmHash = toBase58(crypto.createHash('sha256').update(wasmBuf).digest());
    } catch {
      // Ignored
    }
  }

  if (contractId) {
    const chk = await checkContractAccount(contractId, rpcUrl);
    let wasmMatched = null;
    if (chk.exists && localWasmHash && chk.codeHash) {
      wasmMatched = localWasmHash === chk.codeHash;
    }
    contractCheckResult = {
      contractId,
      ...chk,
      localWasmPresent: Boolean(localWasmHash),
      localWasmHash,
      wasmMatched,
    };

    if (!isJson) {
      console.log('\n--- Contract Verification ---');
      if (!chk.exists) {
        console.log(`Contract account ${contractId}: not found on-chain (likely deleted in cleanup)`);
      } else {
        console.log(`Contract account: ${contractId}`);
        console.log(`Full-access keys: ${chk.hasFullAccess ? 'DETECTED (WARNING)' : 'None (Locked)'}`);
        console.log(`Onchain code_hash: ${chk.codeHash}`);
        if (localWasmHash) {
          console.log(`Local wasm sha256: ${localWasmHash} (${wasmMatched ? 'MATCH' : 'MISMATCH'})`);
        } else {
          console.log('build lokal tidak ada: dilewati');
        }
      }
    }
  } else if (!isJson && localWasmHash) {
    console.log(`\nLocal wasm sha256: ${localWasmHash} (contract check skipped: no CONTRACT_ID configured)`);
  }

  const summary = summarizeResults(results);

  if (isJson) {
    console.log(JSON.stringify({
      rpc: rpcUrl,
      summary,
      transactions: results,
      contract: contractCheckResult,
    }, null, 2));
  } else {
    console.log(`\nSummary: ${summary.verified} verified, ${summary.mismatched} mismatched, ${summary.unverifiable} unverifiable`);
  }

  process.exit(summary.exitCode);
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main().catch((err) => {
    console.error('VERIFY ERROR:', err.message ?? err);
    process.exit(2);
  });
}
