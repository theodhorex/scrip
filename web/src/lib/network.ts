// Single source of truth for NEAR network configuration.
export const NETWORK = "testnet";
export const EXPLORER_TX_BASE = "https://testnet.nearblocks.io/txns";
export const EXPLORER_ACCOUNT_BASE = "https://testnet.nearblocks.io/accounts";
export const RPC_URL = "https://rpc.testnet.fastnear.com";

/**
 * Returns true if the account ID belongs to NEAR testnet (ends with .testnet).
 */
export function isTestnetAccount(id: string): boolean {
  return typeof id === "string" && id.endsWith(".testnet");
}
