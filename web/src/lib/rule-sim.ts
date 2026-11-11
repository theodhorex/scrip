// Pure browser simulation of the Scrip contract's payment rules (the "rule machine").
// It delegates every policy decision to `evaluate` in rules.ts, which mirrors `request_payment`
// in contracts/scrip/src/lib.rs (order verified by rules.test.mjs). It is NOT a chain call.
// Numbers below are an illustrative mandate, not recorded data. Erasable TS only (node --test).
import type { RejectCode } from "./rules";
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { evaluate } from "./rules.ts";

export const SIM = {
  mandateId: 1,
  agent: "agent.testnet",
  merchant: "shop.testnet",
  stranger: "dmx-unknown.testnet",
  deposited: "1500000",
  budget: "1000000",
  perPaymentCap: "400000",
  approvalThreshold: "250000",
  nowMs: 1_800_000_000_000,
  expiresAtMs: 1_800_000_000_000 + 86_400_000 * 30,
  approvalTtlMs: 3_600_000,
} as const;

export const AMOUNT_MIN_MILLI = 10;
export const AMOUNT_MAX_MILLI = 600;
export const AMOUNT_STEP_MILLI = 10;

export type RecipientChoice = "allowed" | "unknown";
export type SimInput = { to: RecipientChoice; amountMilli: number; approved: boolean };
export const DEFAULT_INPUT: SimInput = { to: "allowed", amountMilli: 100, approved: false };

export type SimState = {
  spent: string;
  reserved: string;
  openRequests: number;
  nextRequestId: number;
  nonce: number;
};

export type SimEvent = {
  event: "reserved" | "settled" | "rejected";
  data: {
    mandate_id: number;
    recipient: string;
    amount: string;
    request_id?: number;
    code?: RejectCode;
  };
};

export type SimResult =
  | { outcome: "settled"; code?: undefined; state: SimState; reservedState: SimState; events: SimEvent[] }
  | { outcome: "rejected"; code: RejectCode; state: SimState; reservedState: SimState; events: SimEvent[] };

export function milliToUnits(milli: number): string {
  return (BigInt(Math.round(milli)) * BigInt(1000)).toString();
}

export function initialSim(): SimState {
  return { spent: "0", reserved: "0", openRequests: 0, nextRequestId: 0, nonce: 1 };
}

/** One agent call to request_payment. A guardian approval is created for this exact payment when `approved`. */
export function submitPayment(state: SimState, input: SimInput): SimResult {
  const recipient = input.to === "allowed" ? SIM.merchant : SIM.stranger;
  const amount = milliToUnits(input.amountMilli);
  const nonce = state.nonce;
  const approvals = input.approved
    ? [{ recipient, amount, nonce, expiresAtMs: SIM.nowMs + SIM.approvalTtlMs, used: false }]
    : [];
  const verdict = evaluate(
    {
      id: SIM.mandateId, status: "Active", expiresAtMs: SIM.expiresAtMs, recipients: [SIM.merchant],
      perPaymentCap: SIM.perPaymentCap, budget: SIM.budget, approvalThreshold: SIM.approvalThreshold,
    },
    { deposited: SIM.deposited, spent: state.spent, reserved: state.reserved, openRequests: state.openRequests, nowMs: SIM.nowMs, approvals },
    { recipient, amount, nonce },
  );
  const base = { mandate_id: SIM.mandateId, recipient, amount };

  if (!verdict.ok) {
    return {
      outcome: "rejected", code: verdict.code, state, reservedState: state,
      events: [{ event: "rejected", data: { ...base, code: verdict.code } }],
    };
  }
  const requestId = state.nextRequestId;
  const reservedState: SimState = {
    ...state,
    reserved: (BigInt(state.reserved) + BigInt(amount)).toString(),
    openRequests: state.openRequests + 1,
    nextRequestId: requestId + 1,
    nonce: nonce + 1,
  };
  // The token transfer is assumed to succeed here: the simulation does not model a failing ft_transfer.
  const settled: SimState = {
    ...reservedState,
    reserved: state.reserved,
    spent: (BigInt(state.spent) + BigInt(amount)).toString(),
    openRequests: state.openRequests,
  };
  return {
    outcome: "settled", state: settled, reservedState,
    events: [
      { event: "reserved", data: { ...base, request_id: requestId } },
      { event: "settled", data: { ...base, request_id: requestId } },
    ],
  };
}

/** The contract's NEP-297 log line (standard "scrip", version "1.0.0"). */
export function formatEvent(e: SimEvent): string {
  return `EVENT_JSON:${JSON.stringify({ standard: "scrip", version: "1.0.0", event: e.event, data: [e.data] })}`;
}

/** Parses `to=unknown&amount=300&approved=1` (amount in thousandths of a USDC). Unknown input falls back to defaults. */
export function parseRuleQuery(raw: string): SimInput {
  const p = new URLSearchParams(raw.replace(/^[?#]/, ""));
  const to: RecipientChoice = p.get("to") === "unknown" ? "unknown" : "allowed";
  const n = Number(p.get("amount"));
  const amountMilli = Number.isFinite(n) && /^\d{1,6}$/.test(p.get("amount") ?? "")
    ? Math.min(AMOUNT_MAX_MILLI, Math.max(AMOUNT_MIN_MILLI, Math.round(n / AMOUNT_STEP_MILLI) * AMOUNT_STEP_MILLI))
    : DEFAULT_INPUT.amountMilli;
  return { to, amountMilli, approved: p.get("approved") === "1" };
}

export function toRuleQuery(i: SimInput): string {
  return `to=${i.to}&amount=${i.amountMilli}${i.approved ? "&approved=1" : ""}`;
}
