import demoJson from "../data/demo.json" with { type: "json" };
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
  source: "demo.json" | "gate.json";
  label: string;
  txHash: string;
  senderId?: string;
  claim: Claim;
}

export interface VerificationResult {
  txHash: string;
  senderId?: string;
  classification: TxClassification;
  verdict: VerificationVerdict;
  reason?: string;
  claim?: Claim;
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

export interface FetchAndVerifyOptions {
  txHash: string;
  senderId?: string;
  rpcUrl?: string;
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

  // 6. From gate.json: Extra facilitator txs (second payment, budget overflow)
  if (Array.isArray(gateJson?.facilitatorLog)) {
    for (const line of gateJson.facilitatorLog) {
      if (typeof line === "string") {
        try {
          const parsed = JSON.parse(line) as { tx?: string; agent?: string; code?: string };
          if (parsed.tx && !items.some((it) => it.txHash === parsed.tx)) {
            items.push({
              id: `gate-log-${parsed.tx.slice(0, 8)}`,
              source: "gate.json",
              label: `Gate log tx (${parsed.code || "tx"})`,
              txHash: parsed.tx,
              senderId: parsed.agent,
              claim: { expectedSuccess: true },
            });
          }
        } catch {
          // ignore
        }
      }
    }
  }

  return items;
}
