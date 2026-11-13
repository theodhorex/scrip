// Live demo helpers (pure). The demo config comes from src/data/live.json, written by scripts/live-setup.mjs.
// Erasable TypeScript only, so `node --test` can import it directly.
import liveJson from "../data/live.json" with { type: "json" };

export type LiveConfig = {
  network: string;
  contractId: string;
  agentId: string;
  guardianId: string;
  ownerId: string;
  token: string;
  mandateId: number;
  recipients: string[];
  budget: string;
  perPaymentCap: string;
  approvalThreshold: string;
  expiresAtMs: number;
  agentPublicKey: string;
  agentKey: string;
  keyAllowanceNear: string;
  createdAt: string;
  txs: Record<string, string>;
};

export const LIVE = liveJson as LiveConfig;

export type PaymentOutcome =
  | { kind: "settled"; requestId: number }
  | { kind: "refunded"; requestId: number }
  | { kind: "rejected"; code: string }
  | { kind: "failed"; detail: string }
  | { kind: "unknown" };

function decodeBase64(s: string): string {
  if (typeof atob === "function") {
    const bin = atob(s);
    const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
    return new TextDecoder().decode(bytes);
  }
  return "";
}

/** Reads the final result of a `request_payment` transaction (the outcome's `status`). */
export function parsePaymentOutcome(outcome: unknown): PaymentOutcome {
  const status = (outcome as { status?: Record<string, unknown> } | null)?.status;
  if (!status || typeof status !== "object") return { kind: "unknown" };
  if ("Failure" in status) {
    return { kind: "failed", detail: JSON.stringify(status.Failure).slice(0, 400) };
  }
  const sv = status.SuccessValue;
  if (typeof sv !== "string" || sv.length === 0) return { kind: "unknown" };
  try {
    const v = JSON.parse(decodeBase64(sv)) as Record<string, { request_id?: number; code?: string }>;
    if (v.Settled) return { kind: "settled", requestId: Number(v.Settled.request_id) };
    if (v.Refunded) return { kind: "refunded", requestId: Number(v.Refunded.request_id) };
    if (v.Rejected && typeof v.Rejected.code === "string") return { kind: "rejected", code: v.Rejected.code };
  } catch {
    return { kind: "unknown" };
  }
  return { kind: "unknown" };
}

/** "0.05" -> "50000" (6 decimals). Null when not a plain positive decimal with at most 6 places. */
export function usdcToUnits(usdc: string): string | null {
  const t = usdc.trim();
  if (!/^\d+(\.\d{1,6})?$/.test(t)) return null;
  const [w, f = ""] = t.split(".");
  return (BigInt(w) * BigInt(1000000) + BigInt(f.padEnd(6, "0"))).toString();
}

export function unitsToUsdc(units: string): string {
  const p = units.padStart(7, "0");
  const whole = p.slice(0, -6).replace(/^0+(?=\d)/, "");
  const frac = p.slice(-6).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

/** NEAR account id rules: 2 to 64 chars, lowercase, parts of [a-z0-9] joined by - or _, separated by dots. */
export function isValidAccountId(id: string): boolean {
  if (id.length < 2 || id.length > 64) return false;
  return /^(([a-z\d]+[-_])*[a-z\d]+\.)*([a-z\d]+[-_])*[a-z\d]+$/.test(id);
}

export type LiveStats = { budget: string; deposited: string; withdrawn: string; spent: string; reserved: string };

/** What the agent can still spend: min(budget, deposited - withdrawn) - spent - reserved, floored at zero. */
export function remaining(s: LiveStats): string {
  const dep = BigInt(s.deposited) - BigInt(s.withdrawn);
  const ceiling = BigInt(s.budget) < dep ? BigInt(s.budget) : dep;
  const left = ceiling - BigInt(s.spent) - BigInt(s.reserved);
  return (left > BigInt(0) ? left : BigInt(0)).toString();
}
