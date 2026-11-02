// PLACEHOLDER DATA. Nothing here comes from a chain or from a test run.
// Replace with RPC reads once the contract is deployed (see lib/scrip.ts).
// Never present these numbers as results; the UI marks them as sample data.
import type { ScripEvent, Mandate } from "./types";

const USDC = (n: number) => String(n * 1_000_000);

export const MOCK_MANDATES: Mandate[] = [
  {
    id: 1,
    owner: "owner.example.testnet",
    guardian: "guardian.example.testnet",
    agent: "agent.example.testnet",
    token: "usdc.example.testnet",
    deposited: USDC(50),
    budget: USDC(50),
    spent: USDC(12),
    reserved: USDC(3),
    withdrawn: "0",
    perPaymentCap: USDC(5),
    approvalThreshold: USDC(2),
    expiresAtMs: Date.UTC(2026, 10, 14, 23, 59),
    status: "Active",
    openRequests: 1,
    recipients: ["merchant-a.example.testnet", "merchant-b.example.testnet"],
  },
  {
    id: 2,
    owner: "owner.example.testnet",
    guardian: "guardian.example.testnet",
    agent: "agent-2.example.testnet",
    token: "usdc.example.testnet",
    deposited: USDC(20),
    budget: USDC(20),
    spent: USDC(20),
    reserved: "0",
    withdrawn: "0",
    perPaymentCap: USDC(2),
    approvalThreshold: USDC(1),
    expiresAtMs: Date.UTC(2026, 10, 10, 12, 0),
    status: "Revoked",
    openRequests: 0,
    recipients: ["merchant-a.example.testnet"],
  },
];

export const MOCK_EVENTS: ScripEvent[] = [
  { name: "mandate_created", mandateId: 1, atMs: Date.UTC(2026, 10, 2, 9, 0) },
  { name: "deposited", mandateId: 1, amount: USDC(50), atMs: Date.UTC(2026, 10, 2, 9, 1) },
  { name: "settled", mandateId: 1, requestId: 1, recipient: "merchant-a.example.testnet", amount: USDC(4), atMs: Date.UTC(2026, 10, 2, 9, 30) },
  { name: "rejected", mandateId: 1, requestId: 2, recipient: "attacker.example.testnet", amount: USDC(5), code: "RECIPIENT_NOT_ALLOWED", atMs: Date.UTC(2026, 10, 2, 9, 31) },
  { name: "reserved", mandateId: 1, requestId: 3, recipient: "merchant-b.example.testnet", amount: USDC(3), atMs: Date.UTC(2026, 10, 2, 9, 40) },
];
