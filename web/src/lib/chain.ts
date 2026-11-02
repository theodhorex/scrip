// Server-only NEAR testnet read access: a plain JSON-RPC `query/call_function`.
// No wallet, no SDK. Never import this from a client component.
import "server-only";

export const DEFAULT_RPC_URL = "https://rpc.testnet.fastnear.com";
const TIMEOUT_MS = 8_000;
const ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;
const METHOD_NAME = /^[a-z_][a-z0-9_]{0,63}$/;

export class ChainReadError extends Error {
  constructor(message: string) {
    super(message);
    this.name = new.target.name;
  }
}
export class RpcConfigError extends ChainReadError {}
export class RpcTimeoutError extends ChainReadError {}
export class RpcRateLimitError extends ChainReadError {}
export class RpcHttpError extends ChainReadError {}
export class RpcResponseError extends ChainReadError {}
export class RpcError extends ChainReadError {
  code: number | undefined;
  constructor(message: string, code?: number) {
    super(message);
    this.code = code;
  }
}

// Testnet only: the hostname (not just any part of the URL) must mention "testnet".
function rpcUrl(): string {
  const raw = process.env.SCRIP_RPC_URL || DEFAULT_RPC_URL;
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    throw new RpcConfigError("SCRIP_RPC_URL is not a valid URL");
  }
  if (url.protocol !== "https:" || !url.hostname.includes("testnet")) {
    throw new RpcConfigError("SCRIP_RPC_URL must be an https testnet endpoint");
  }
  return url.toString();
}

function decodeResult<T>(bytes: unknown): T {
  if (!Array.isArray(bytes) || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new RpcResponseError("RPC result is not a byte array");
  }
  const text = new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(bytes));
  try {
    return JSON.parse(text) as T;
  } catch {
    throw new RpcResponseError("contract result is not valid JSON");
  }
}

// Returns the parsed JSON of the view method. `T` is only a hint: validate the
// shape (see mapMandateView) before using it.
export async function viewCall<T = unknown>(
  contractId: string,
  method: string,
  args: Record<string, unknown> = {},
): Promise<T> {
  if (!ACCOUNT_ID.test(contractId)) throw new RpcConfigError("contract id is not a valid account id");
  if (!METHOD_NAME.test(method)) throw new RpcConfigError("invalid view method name");
  const url = rpcUrl();

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS);
  let res: Response;
  try {
    res = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      cache: "no-store",
      signal: controller.signal,
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: "scrip-web",
        method: "query",
        params: {
          request_type: "call_function",
          finality: "final",
          account_id: contractId,
          method_name: method,
          args_base64: Buffer.from(JSON.stringify(args)).toString("base64"),
        },
      }),
    });
  } catch (e) {
    if (controller.signal.aborted) throw new RpcTimeoutError(`RPC request timed out after ${TIMEOUT_MS} ms`);
    throw new RpcHttpError(`RPC request failed: ${e instanceof Error ? e.message : "network error"}`);
  } finally {
    clearTimeout(timer);
  }

  if (res.status === 429) throw new RpcRateLimitError("RPC rate limit reached (HTTP 429)");
  if (!res.ok) throw new RpcHttpError(`RPC responded with HTTP ${res.status}`);

  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new RpcResponseError("RPC response is not JSON");
  }
  if (typeof body !== "object" || body === null) throw new RpcResponseError("RPC response is not an object");
  const { result, error } = body as { result?: unknown; error?: unknown };

  if (error !== undefined && error !== null) {
    const e = error as { message?: unknown; name?: unknown; code?: unknown; cause?: { name?: unknown } };
    const detail = [e.name, e.cause?.name, e.message].filter((s) => typeof s === "string").join(": ");
    throw new RpcError(detail || "RPC returned an error", typeof e.code === "number" ? e.code : undefined);
  }
  if (typeof result !== "object" || result === null) throw new RpcResponseError("RPC response has no result");
  const r = result as { result?: unknown; error?: unknown };
  // A contract panic or missing method comes back as `result.error` (a string).
  if (typeof r.error === "string") throw new RpcError(r.error);
  return decodeResult<T>(r.result);
}
