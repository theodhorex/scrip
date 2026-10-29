import { MandateMapError } from "@/lib/mandate-map";
import { RpcError, RpcRateLimitError, RpcTimeoutError } from "@/lib/chain";

function describe(error: unknown): { title: string; detail: string } {
  if (error instanceof RpcRateLimitError) {
    return {
      title: "Chain read rate-limited",
      detail: "The NEAR testnet RPC returned HTTP 429. Wait a moment and reload.",
    };
  }
  if (error instanceof RpcTimeoutError) {
    return { title: "Chain read timed out", detail: "The NEAR testnet RPC did not answer in time. Reload to retry." };
  }
  if (error instanceof MandateMapError) {
    return {
      title: "Unexpected data from the contract",
      detail: `The on-chain mandate did not match the expected shape (${error.message}).`,
    };
  }
  if (error instanceof RpcError) {
    return { title: "The contract call failed", detail: error.message };
  }
  return {
    title: "Could not read from the chain",
    detail: error instanceof Error ? error.message : "Unknown error while reading from NEAR testnet.",
  };
}

// Shown instead of data whenever a live chain read fails. Never sample data.
export function ChainError({ error }: { error: unknown }) {
  console.error("[amanat] chain read failed:", error);
  const { title, detail } = describe(error);
  return (
    <div role="alert" className="bp-plate bp-plate-reject bp-app-notice">
      <span className="bp-app-chip bp-app-chip-reject" aria-hidden="true">
        <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8">
          <path d="M2 2l6 6M8 2 2 8" />
        </svg>
        CHAIN_READ_FAILED
      </span>
      <div className="min-w-0">
        <h2 className="bp-app-notice-title">{title}</h2>
        <p className="bp-app-notice-body break-words">{detail}</p>
        <p className="bp-app-notice-body">
          Live data is configured, so no sample data is shown in its place.
        </p>
      </div>
    </div>
  );
}
