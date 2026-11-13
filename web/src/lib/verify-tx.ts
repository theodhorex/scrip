import demoJson from "../data/demo.json" with { type: "json" };
import demoLlmJson from "../data/demo-llm.json" with { type: "json" };
import gateJson from "../data/gate.json" with { type: "json" };

export type TxClassificationType = "SUCCESS" | "FAILURE" | "UNVERIFIABLE";

export type TxClassification =
  | { type: "SUCCESS" }
  | { type: "FAILURE"; errorCode?: string; rawError?: string }
  | { type: "UNVERIFIABLE"; reason: string };

export interface Claim {
  expectedSuccess?: boolean;
  expectedErrorCode?: string;
}

export type VerificationVerdict = "VERIFIED" | "MISMATCHED" | "UNVERIFIABLE";

export interface VerificationItem {
  id: string;
  source: "demo.json" | "demo-llm.json" | "gate.json";
  label: string;
  txHash: string;
  senderId?: string;
  claim: Claim;
  /** ISO time the recorded run started (startedAt of the source file). The exact on-chain time comes from the verification result. */
  recordedAt?: string;
}

export interface VerificationResult {
  txHash: string;
  senderId?: string;
  classification: TxClassification;
  verdict: VerificationVerdict;
  reason?: string;
  claim?: Claim;
  /** Where the transaction data came from: the FastNear indexer or a JSON-RPC node. */
  source?: "indexer" | "rpc";
  /** ISO time of the block that included the transaction. Only the indexer path returns it. */
  blockTime?: string;
}

/** Reads the block time (ISO, UTC) from a converted indexer body (`result.transaction_outcome.block_timestamp`, nanoseconds). */
export function blockTimeFromBody(body: unknown): string | undefined {
  const ts = (body as { result?: { transaction_outcome?: { block_timestamp?: unknown } } } | null)?.result?.transaction_outcome?.block_timestamp;
  if (typeof ts !== "number" && typeof ts !== "string") return undefined;
  const ms = Number(BigInt(ts) / BigInt(1000000));
  const d = new Date(ms);
  return Number.isNaN(d.getTime()) ? undefined : d.toISOString();
}

/** "13 Nov 2026, 04:25:09 UTC". Fixed zone so server and browser render the same text. */
export function formatUtc(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const date = new Intl.DateTimeFormat("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" }).format(d);
  return `${date}, ${d.toISOString().slice(11, 19)} UTC`;
}

const KNOWN_CODES = [
  "RECIPIENT_NOT_ALLOWED",
  "OVER_PER_PAYMENT_CAP",
  "OVER_BUDGET",
  "TRANSFER_FAILED",
  "METHOD_NOT_ALLOWED",
  "GAS_TOO_LOW",
  "KEY_NOT_ALLOWED",
  "NOT_ACTIVE",
  "EXPIRED",
  "NEEDS_APPROVAL",
  "APPROVAL_USED",
  "APPROVAL_EXPIRED",
  "TOO_MANY_OPEN",
] as const;

/**
 * Extracts error code from panic messages or raw strings.
 */
export function extractErrorCode(text: string): string | undefined {
  if (!text || typeof text !== "string") return undefined;

  // Check known codes first
  for (const code of KNOWN_CODES) {
    if (text.includes(code)) return code;
  }

  // Look for 'CODE' or "CODE" inside panicked message
  const match = text.match(/'([A-Z0-9_]{3,})'/) || text.match(/"([A-Z0-9_]{3,})"/);
  if (match) return match[1];

  // Look for panic: CODE or panicked at CODE
  const panicMatch = text.match(/(?:panicked at|panic:)\s*([A-Z0-9_]+)/i);
  if (panicMatch) return panicMatch[1];

  return undefined;
}

function parseFailureObject(failure: unknown): { errorCode?: string; rawError: string } {
  const raw = typeof failure === "string" ? failure : JSON.stringify(failure);
  let detail = raw;

  if (typeof failure === "object" && failure !== null) {
    const f = failure as Record<string, unknown>;
    const actionError = f.ActionError as Record<string, unknown> | undefined;
    const kind = actionError?.kind as Record<string, unknown> | undefined;
    const funcError = kind?.FunctionCallError as Record<string, unknown> | undefined;
    if (typeof funcError?.ExecutionError === "string") {
      detail = funcError.ExecutionError;
    }
  }

  return {
    errorCode: extractErrorCode(detail),
    rawError: detail,
  };
}

/**
 * Scrip does not panic on a refused payment: the contract returns `{"Rejected":{"code":...}}` as the
 * receipt's SuccessValue (and emits a `rejected` NEP-297 event). A refusal is therefore a successful
 * receipt that carries a rejection code, and must be read as a refusal, not as a payment.
 */
export function decodeRejection(outcome: Record<string, unknown> | undefined): string | undefined {
  if (!outcome) return undefined;
  const status = outcome.status as Record<string, unknown> | undefined;
  const value = status?.SuccessValue;
  if (typeof value === "string" && value.length > 0) {
    try {
      const parsed = JSON.parse(atob(value)) as { Rejected?: { code?: unknown } };
      if (typeof parsed?.Rejected?.code === "string") return parsed.Rejected.code;
    } catch {
      // not JSON: an ordinary return value
    }
  }
  const logs = outcome.logs;
  if (Array.isArray(logs)) {
    for (const log of logs) {
      if (typeof log === "string" && log.startsWith("EVENT_JSON:")) {
        try {
          const ev = JSON.parse(log.slice("EVENT_JSON:".length)) as { event?: string; data?: Array<{ code?: unknown }> };
          const code = ev?.data?.[0]?.code;
          if (ev?.event === "rejected" && typeof code === "string") return code;
        } catch {
          // ignore malformed event
        }
      }
    }
  }
  return undefined;
}

/**
 * Pure function: Classifies NEAR RPC EXPERIMENTAL_tx_status response.
 */
export function classifyRpcResponse(body: unknown): TxClassification {
  if (!body || typeof body !== "object") {
    return { type: "UNVERIFIABLE", reason: "Malformed or empty RPC response" };
  }

  const obj = body as Record<string, unknown>;

  // RPC-level error
  if (obj.error) {
    const err = obj.error as Record<string, unknown> | string;
    let msg = "RPC returned error";
    if (typeof err === "string") {
      msg = err;
    } else if (typeof err === "object" && err !== null) {
      msg = (typeof err.data === "string" && err.data) ||
        (typeof err.message === "string" && err.message) ||
        JSON.stringify(err);
    }
    return { type: "UNVERIFIABLE", reason: msg };
  }

  const result = obj.result as Record<string, unknown> | undefined;
  if (!result || typeof result !== "object") {
    return { type: "UNVERIFIABLE", reason: "RPC response missing result property" };
  }

  // 1. Check top-level status
  const status = result.status as Record<string, unknown> | undefined;
  if (status?.Failure) {
    const parsed = parseFailureObject(status.Failure);
    return { type: "FAILURE", errorCode: parsed.errorCode, rawError: parsed.rawError };
  }

  // 2. Check receipts outcomes for failures
  const receipts = result.receipts_outcome;
  if (Array.isArray(receipts)) {
    for (const r of receipts) {
      const outcome = (r as Record<string, unknown>)?.outcome as Record<string, unknown> | undefined;
      const recStatus = outcome?.status as Record<string, unknown> | undefined;
      if (recStatus?.Failure) {
        const parsed = parseFailureObject(recStatus.Failure);
        return { type: "FAILURE", errorCode: parsed.errorCode, rawError: parsed.rawError };
      }
      const rejected = decodeRejection(outcome);
      if (rejected) {
        return { type: "FAILURE", errorCode: rejected, rawError: `Rejected(${rejected})` };
      }
    }
  }

  // 3. Check for successful execution
  if (
    status?.SuccessValue !== undefined ||
    status?.SuccessReceiptId !== undefined ||
    result.final_execution_status === "FINAL" ||
    result.final_execution_status === "EXECUTED"
  ) {
    return { type: "SUCCESS" };
  }

  return { type: "UNVERIFIABLE", reason: "Unknown RPC status shape" };
}

/**
 * Pure function: Compares classification against expected claim.
 */
export function compareClaim(
  classification: TxClassification,
  claim?: Claim,
): { verdict: VerificationVerdict; reason?: string } {
  if (classification.type === "UNVERIFIABLE") {
    return { verdict: "UNVERIFIABLE", reason: classification.reason };
  }

  const expectedSuccess = claim?.expectedSuccess ?? (claim?.expectedErrorCode ? false : true);

  if (expectedSuccess) {
    if (classification.type === "SUCCESS") {
      return { verdict: "VERIFIED" };
    }
    return {
      verdict: "MISMATCHED",
      reason: `Claimed success, but transaction failed on-chain (${classification.errorCode || "error"})`,
    };
  }

  // Expected failure
  if (classification.type === "SUCCESS") {
    return {
      verdict: "MISMATCHED",
      reason: "Claimed failure, but transaction succeeded on-chain",
    };
  }

  if (claim?.expectedErrorCode) {
    if (classification.errorCode === claim.expectedErrorCode) {
      return { verdict: "VERIFIED" };
    }
    return {
      verdict: "MISMATCHED",
      reason: `Claimed error ${claim.expectedErrorCode}, but got ${classification.errorCode || "unknown code"}`,
    };
  }

  return { verdict: "VERIFIED" };
}

/**
 * Converts a FastNear Transactions API response (`POST /v0/transactions`) into the JSON-RPC result shape,
 * so one classifier reads both sources. Returns an UNVERIFIABLE reason when the hash is unknown.
 */
export function indexerToRpcBody(body: unknown, txHash: string): { body?: unknown; reason?: string } {
  const list = (body as { transactions?: unknown[] } | null)?.transactions;
  if (!Array.isArray(list) || list.length === 0) return { reason: "Indexer does not know this transaction yet" };
  const tx = list.find((t) => (t as { execution_outcome?: { id?: string } })?.execution_outcome?.id === txHash) as
    | { execution_outcome?: Record<string, unknown>; receipts?: Array<{ execution_outcome?: Record<string, unknown> }> }
    | undefined;
  if (!tx?.execution_outcome) return { reason: "Indexer returned no outcome for this transaction" };
  const receiptsOutcome = (tx.receipts ?? [])
    .map((r) => r.execution_outcome)
    .filter((o): o is Record<string, unknown> => !!o);
  return {
    body: {
      result: {
        final_execution_status: "FINAL",
        status: { SuccessValue: "" },
        transaction_outcome: tx.execution_outcome,
        receipts_outcome: receiptsOutcome,
      },
    },
  };
}

export const FASTNEAR_INDEXER_URL = "https://tx.test.fastnear.com/v0/transactions";

async function fetchViaIndexer(
  fetcher: typeof fetch,
  indexerUrl: string,
  txHash: string,
  timeoutMs: number,
): Promise<{ body?: unknown; reason?: string }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetcher(indexerUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ tx_hashes: [txHash] }),
      signal: controller.signal,
    });
    if (response.status === 429) return { reason: "Indexer rate limited (HTTP 429)" };
    if (!response.ok) return { reason: `Indexer responded with HTTP ${response.status}` };
    return indexerToRpcBody(await response.json(), txHash);
  } catch (err: unknown) {
    const timedOut = (err instanceof Error && err.name === "AbortError") || controller.signal.aborted;
    return { reason: timedOut ? `Indexer timed out after ${Math.round(timeoutMs / 1000)}s` : `Indexer network error: ${err instanceof Error ? err.message : String(err)}` };
  } finally {
    clearTimeout(timer);
  }
}

export interface FetchAndVerifyOptions {
  txHash: string;
  senderId?: string;
  rpcUrl?: string;
  /** When set, the indexer is asked first (no sender account needed); the RPC is the fallback. */
  indexerUrl?: string;
  claim?: Claim;
  fetchFn?: typeof fetch;
  timeoutMs?: number;
}

/**
 * Fetches tx status via NEAR RPC EXPERIMENTAL_tx_status and verifies against claim.
 * Never throws: all failures/timeouts/missing senders map cleanly to UNVERIFIABLE.
 */
export async function fetchAndVerifyTx(options: FetchAndVerifyOptions): Promise<VerificationResult> {
  const { txHash, senderId, claim, rpcUrl = "https://archival-rpc.testnet.fastnear.com", timeoutMs = 10_000 } = options;
  const fetcher = options.fetchFn ?? fetch;

  if (options.indexerUrl) {
    let viaIndexer = await fetchViaIndexer(fetcher, options.indexerUrl, txHash, timeoutMs);
    // One retry after a pause when the indexer is rate limited or briefly unreachable (a page load fires many lookups at once).
    if (!viaIndexer.body && /429|timed out|network error/i.test(viaIndexer.reason ?? "")) {
      await new Promise((r) => setTimeout(r, 1200));
      viaIndexer = await fetchViaIndexer(fetcher, options.indexerUrl, txHash, timeoutMs);
    }
    if (viaIndexer.body) {
      const classification = classifyRpcResponse(viaIndexer.body);
      const comparison = compareClaim(classification, claim);
      return { txHash, senderId, classification, verdict: comparison.verdict, reason: comparison.reason, claim, source: "indexer", blockTime: blockTimeFromBody(viaIndexer.body) };
    }
    // Indexer could not answer: fall through to the RPC node below.
  }

  if (!senderId || !senderId.trim()) {
    const unverified: TxClassification = {
      type: "UNVERIFIABLE",
      reason: "Missing sender account id: EXPERIMENTAL_tx_status requires [tx_hash, sender_account_id]",
    };
    return {
      txHash,
      senderId: undefined,
      classification: unverified,
      verdict: "UNVERIFIABLE",
      reason: unverified.reason,
      claim,
    };
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  let response: Response;
  try {
    response = await fetcher(rpcUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "verify-tx",
        method: "EXPERIMENTAL_tx_status",
        params: [txHash, senderId.trim()],
      }),
      signal: controller.signal,
    });
  } catch (err: unknown) {
    clearTimeout(timer);
    const isTimeout =
      (err instanceof Error && err.name === "AbortError") ||
      controller.signal.aborted;
    const reason = isTimeout
      ? `RPC request timed out after ${Math.round(timeoutMs / 1000)}s`
      : `Network error: ${err instanceof Error ? err.message : String(err)}`;
    const classification: TxClassification = { type: "UNVERIFIABLE", reason };
    return {
      txHash,
      senderId,
      classification,
      verdict: "UNVERIFIABLE",
      reason,
      claim,
    };
  } finally {
    clearTimeout(timer);
  }

  if (response.status === 429) {
    const classification: TxClassification = {
      type: "UNVERIFIABLE",
      reason: "RPC rate limited (HTTP 429)",
    };
    return {
      txHash,
      senderId,
      classification,
      verdict: "UNVERIFIABLE",
      reason: classification.reason,
      claim,
    };
  }

  if (!response.ok) {
    const classification: TxClassification = {
      type: "UNVERIFIABLE",
      reason: `RPC responded with HTTP ${response.status}`,
    };
    return {
      txHash,
      senderId,
      classification,
      verdict: "UNVERIFIABLE",
      reason: classification.reason,
      claim,
    };
  }

  let body: unknown;
  try {
    body = await response.json();
  } catch {
    const classification: TxClassification = {
      type: "UNVERIFIABLE",
      reason: "RPC response body was not valid JSON",
    };
    return {
      txHash,
      senderId,
      classification,
      verdict: "UNVERIFIABLE",
      reason: classification.reason,
      claim,
    };
  }

  const classification = classifyRpcResponse(body);
  const comparison = compareClaim(classification, claim);

  return {
    txHash,
    senderId,
    classification,
    verdict: comparison.verdict,
    reason: comparison.reason,
    claim,
    source: "rpc",
  };
}

/**
 * Concurrency limiter that runs an async worker pool with a maximum degree of parallelism.
 */
export async function runWithConcurrencyLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T, index: number) => Promise<R>,
  onItemDone?: (result: R, index: number) => void,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let nextIdx = 0;

  async function worker() {
    while (nextIdx < items.length) {
      const idx = nextIdx++;
      const res = await fn(items[idx], idx);
      results[idx] = res;
      onItemDone?.(res, idx);
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers: Promise<void>[] = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(worker());
  }
  await Promise.all(workers);
  return results;
}

/**
 * Builds the map of txHash -> sender from facilitator logs in demo.json and gate.json.
 */
function buildFacilitatorMap(): Map<string, string> {
  const map = new Map<string, string>();

  const parseLogLine = (line: string) => {
    try {
      const parsed = JSON.parse(line) as { tx?: string; agent?: string };
      if (parsed.tx && parsed.agent) {
        map.set(parsed.tx, parsed.agent);
      }
    } catch {
      // ignore non-json log lines
    }
  };

  if (Array.isArray(demoJson?.facilitatorLog)) {
    for (const line of demoJson.facilitatorLog) {
      if (typeof line === "string") parseLogLine(line);
    }
  }

  if (Array.isArray(gateJson?.facilitatorLog)) {
    for (const line of gateJson.facilitatorLog) {
      if (typeof line === "string") parseLogLine(line);
    }
  }

  if (Array.isArray(demoLlmJson?.facilitatorLog)) {
    for (const line of demoLlmJson.facilitatorLog) {
      if (typeof line === "string") parseLogLine(line);
    }
  }

  return map;
}

/**
 * Extracts all verification items from demo.json and gate.json.
 */
export function extractVerificationItems(): VerificationItem[] {
  const items: VerificationItem[] = [];
  const facilitatorMap = buildFacilitatorMap();

  // 1. From demo.json: Naive agent invoices
  const naiveInvoices = demoJson?.agents?.naive?.invoices;
  if (Array.isArray(naiveInvoices)) {
    naiveInvoices.forEach((inv, i) => {
      if (inv.txHash) {
        items.push({
          id: `demo-naive-${i}-${inv.mode}`,
          source: "demo.json",
          label: `Demo Naive: ${inv.mode} invoice`,
          txHash: inv.txHash,
          senderId: facilitatorMap.get(inv.txHash),
          claim: {
            expectedSuccess: inv.paid,
            expectedErrorCode: inv.rejectionCode || undefined,
          },
        });
      }
    });
  }

  // 2. From demo.json: Scrip agent invoices
  const scripInvoices = demoJson?.agents?.scrip?.invoices;
  if (Array.isArray(scripInvoices)) {
    scripInvoices.forEach((inv, i) => {
      if (inv.txHash) {
        items.push({
          id: `demo-scrip-${i}-${inv.mode}`,
          source: "demo.json",
          label: `Demo Scrip: ${inv.mode} payment (${inv.rejectionCode || "PAID"})`,
          txHash: inv.txHash,
          senderId: facilitatorMap.get(inv.txHash),
          claim: {
            expectedSuccess: inv.paid,
            expectedErrorCode: inv.rejectionCode || undefined,
          },
        });
      }
    });
  }

  // 3. From demo.json: Lifecycle txs
  const demoTxs = demoJson?.txs as Record<string, string> | undefined;
  if (demoTxs && typeof demoTxs === "object") {
    for (const [key, hash] of Object.entries(demoTxs)) {
      if (typeof hash === "string" && hash.length > 10) {
        items.push({
          id: `demo-tx-${key}`,
          source: "demo.json",
          label: `Demo lifecycle: ${key}`,
          txHash: hash,
          senderId: facilitatorMap.get(hash),
          claim: { expectedSuccess: true },
        });
      }
    }
  }

  // 3b. From demo-llm.json: recorded decisions of real models, re-executed on testnet by two wallets.
  const llmAgents = demoLlmJson?.agents as
    | Record<string, { decisions?: Array<{ model: string; label: string; paid: boolean; txHash: string | null; rejectionCode: string | null }> }>
    | undefined;
  for (const agentName of ["naive", "scrip"]) {
    const decisions = llmAgents?.[agentName]?.decisions;
    if (!Array.isArray(decisions)) continue;
    decisions.forEach((d, i) => {
      if (!d.txHash) return;
      items.push({
        id: `llm-${agentName}-${i}-${d.label}`,
        source: "demo-llm.json",
        label: `Model replay ${agentName === "naive" ? "Naive" : "Scrip"}: ${d.model} ${d.label} (${d.rejectionCode || "PAID"})`,
        txHash: d.txHash,
        senderId: facilitatorMap.get(d.txHash),
        claim: {
          expectedSuccess: d.paid,
          expectedErrorCode: d.rejectionCode || undefined,
        },
      });
    });
  }

  // 4. From gate.json: Attacks
  const attacks = gateJson?.steps?.attacks as Record<string, unknown> | undefined;
  if (attacks && typeof attacks === "object") {
    for (const [key, val] of Object.entries(attacks)) {
      if (typeof val === "object" && val !== null) {
        const attackObj = val as { tx?: string; rejected?: string[] };
        if (attackObj.tx) {
          items.push({
            id: `gate-attack-${key}`,
            source: "gate.json",
            label: `Gate attack: ${key}`,
            txHash: attackObj.tx,
            senderId: facilitatorMap.get(attackObj.tx),
            claim: {
              expectedSuccess: false,
              expectedErrorCode: attackObj.rejected?.[0],
            },
          });
        }
      }
    }
  }

  // 5. From gate.json: Lifecycle txs
  const gateTxs = gateJson?.txs as Record<string, string> | undefined;
  if (gateTxs && typeof gateTxs === "object") {
    for (const [key, hash] of Object.entries(gateTxs)) {
      if (typeof hash === "string" && hash.length > 10) {
        // avoid duplicate if already added
        if (!items.some((it) => it.txHash === hash)) {
          items.push({
            id: `gate-tx-${key}`,
            source: "gate.json",
            label: `Gate tx: ${key}`,
            txHash: hash,
            senderId: facilitatorMap.get(hash),
            claim: { expectedSuccess: true },
          });
        }
      }
    }
  }

  // 6. From gate.json: Extra facilitator txs. The run makes a second payment (settles) and then a third
  // request that overflows the budget; steps.budget.thirdRejected says the last one is refused.
  if (Array.isArray(gateJson?.facilitatorLog)) {
    const extras: Array<{ tx: string; agent?: string; code?: string }> = [];
    for (const line of gateJson.facilitatorLog) {
      if (typeof line !== "string") continue;
      try {
        const parsed = JSON.parse(line) as { tx?: string; agent?: string; code?: string };
        if (parsed.tx && !items.some((it) => it.txHash === parsed.tx) && !extras.some((e) => e.tx === parsed.tx)) {
          extras.push({ tx: parsed.tx, agent: parsed.agent, code: parsed.code });
        }
      } catch {
        // ignore
      }
    }
    const budgetSteps = (gateJson as { steps?: { budget?: { thirdRejected?: unknown } } }).steps?.budget;
    const thirdRejected = Array.isArray(budgetSteps?.thirdRejected) ? (budgetSteps?.thirdRejected as unknown[]) : [];
    const refusedCode = typeof thirdRejected[0] === "string" ? thirdRejected[0] : undefined;
    extras.forEach((e, idx) => {
      const isRefused = Boolean(refusedCode) && idx === extras.length - 1 && extras.length >= 2;
      items.push({
        id: `gate-log-${e.tx.slice(0, 8)}`,
        source: "gate.json",
        label: isRefused ? `Gate budget attack (${refusedCode})` : `Gate log tx (${e.code || "tx"})`,
        txHash: e.tx,
        senderId: e.agent,
        claim: isRefused ? { expectedSuccess: false, expectedErrorCode: refusedCode } : { expectedSuccess: true },
      });
    });
  }

  const runStart: Record<VerificationItem["source"], string | undefined> = {
    "demo.json": demoJson?.startedAt,
    "demo-llm.json": demoLlmJson?.startedAt,
    "gate.json": gateJson?.startedAt,
  };
  for (const it of items) it.recordedAt = runStart[it.source];
  return items;
}
