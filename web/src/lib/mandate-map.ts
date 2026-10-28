// Pure, dependency-free mapping from the contract's snake_case `get_mandate`
// view to the UI `Mandate` type. Chain data is never trusted: every field is
// validated and a typed error is thrown instead of coercing or defaulting.
// (Imports from this file use only erasable TypeScript so `node --test` can run it.)
import type { Mandate, MandateStatus } from "./types";

export class MandateMapError extends Error {
  field: string;
  constructor(field: string, reason: string) {
    super(`Invalid mandate view: "${field}" ${reason}`);
    this.name = "MandateMapError";
    this.field = field;
  }
}

const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);
const CANONICAL_DECIMAL = /^(0|[1-9][0-9]*)$/;
const ACCOUNT_ID = /^[a-z0-9._-]{2,64}$/;
const STATUSES: readonly MandateStatus[] = ["Active", "Revoked"];

function amount(raw: Record<string, unknown>, field: string): string {
  const v = raw[field];
  if (typeof v !== "string" || !CANONICAL_DECIMAL.test(v)) {
    throw new MandateMapError(field, "must be a canonical decimal string");
  }
  if (BigInt(v) > U128_MAX) throw new MandateMapError(field, "exceeds u128");
  return v;
}

function account(v: unknown, field: string): string {
  if (typeof v !== "string" || !ACCOUNT_ID.test(v)) {
    throw new MandateMapError(field, "must be a NEAR account id");
  }
  return v;
}

function counter(raw: Record<string, unknown>, field: string): number {
  const v = raw[field];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new MandateMapError(field, "must be a non-negative integer");
  }
  return v;
}

// u64 fields may arrive as a JSON number or, with near-sdk U64, a decimal string.
function timestampMs(raw: Record<string, unknown>, field: string): number {
  const v = raw[field];
  if (typeof v === "string" && CANONICAL_DECIMAL.test(v)) {
    const n = Number(v);
    if (Number.isSafeInteger(n)) return n;
  }
  return counter(raw, field);
}

export function mapMandateView(raw: unknown, id: number): Mandate {
  if (!Number.isSafeInteger(id) || id < 0) {
    throw new MandateMapError("id", "must be a non-negative integer");
  }
  if (typeof raw !== "object" || raw === null || Array.isArray(raw)) {
    throw new MandateMapError("(root)", "must be an object");
  }
  const r = raw as Record<string, unknown>;

  const status = r.status;
  if (typeof status !== "string" || !STATUSES.includes(status as MandateStatus)) {
    throw new MandateMapError("status", 'must be "Active" or "Revoked"');
  }

  const recipients = r.recipients;
  if (!Array.isArray(recipients)) {
    throw new MandateMapError("recipients", "must be an array");
  }

  return {
    id,
    owner: account(r.owner, "owner"),
    guardian: account(r.guardian, "guardian"),
    agent: account(r.agent, "agent"),
    token: account(r.token, "token"),
    deposited: amount(r, "deposited"),
    budget: amount(r, "budget"),
    spent: amount(r, "spent"),
    reserved: amount(r, "reserved"),
    withdrawn: amount(r, "withdrawn"),
    perPaymentCap: amount(r, "per_payment_cap"),
    approvalThreshold: amount(r, "approval_threshold"),
    expiresAtMs: timestampMs(r, "expires_at_ms"),
    status: status as MandateStatus,
    openRequests: counter(r, "open_requests"),
    recipients: recipients.map((rec) => account(rec, "recipients")),
  };
}
