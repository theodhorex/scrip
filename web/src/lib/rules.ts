// Pure mirror of `request_payment` policy checks in `contracts/amanat/src/lib.rs` (steps 2 to 7).
// Order is strict: first failing check wins and returns `{ ok: false, code }`.
// Uses only erasable TypeScript syntax so `node --test` executes it natively.

export const MAX_OPEN = 32;
export const U128_MAX = (BigInt(1) << BigInt(128)) - BigInt(1);

export type RejectCode =
  | "NOT_ACTIVE"
  | "EXPIRED"
  | "RECIPIENT_NOT_ALLOWED"
  | "OVER_PER_PAYMENT_CAP"
  | "TOO_MANY_OPEN"
  | "OVER_BUDGET"
  | "NEEDS_APPROVAL"
  | "APPROVAL_USED"
  | "APPROVAL_EXPIRED";

export type RuleEvaluation =
  | { ok: true }
  | { ok: false; code: RejectCode };

export type AmountInput = string | bigint;

export type RuleMandate = {
  id?: number;
  status: "Active" | "Revoked";
  expiresAtMs: number;
  recipients: readonly string[];
  perPaymentCap: AmountInput;
  budget: AmountInput;
  approvalThreshold: AmountInput;
};

export type ApprovalRecord = {
  mandateId?: number;
  recipient: string;
  amount: AmountInput;
  nonce: number;
  mandateExpiresAtMs?: number;
  expiresAtMs: number;
  used: boolean;
};

export type RuleState = {
  deposited: AmountInput;
  spent: AmountInput;
  reserved?: AmountInput;
  withdrawn?: AmountInput;
  openRequests?: number;
  nowMs: number;
  approvals?: readonly ApprovalRecord[];
};

export type PaymentRequest = {
  recipient: string;
  amount: AmountInput;
  nonce: number;
};

const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/;

function toBigInt(value: AmountInput): bigint {
  if (typeof value === "bigint") return value;
  const trimmed = value.trim();
  if (!DECIMAL_UINT.test(trimmed)) {
    throw new Error(`Invalid integer amount: "${value}"`);
  }
  return BigInt(trimmed);
}

export function evaluate(
  mandate: RuleMandate,
  state: RuleState,
  request: PaymentRequest,
): RuleEvaluation {
  // Step 2a: mandate must be Active
  if (mandate.status !== "Active") {
    return { ok: false, code: "NOT_ACTIVE" };
  }

  // Step 2b: mandate must not be expired (`now >= m.expires_at_ms`)
  if (state.nowMs >= mandate.expiresAtMs) {
    return { ok: false, code: "EXPIRED" };
  }

  // Step 3: recipient must be in the mandate allowlist
  if (!mandate.recipients.includes(request.recipient)) {
    return { ok: false, code: "RECIPIENT_NOT_ALLOWED" };
  }

  // Step 4: `0 < amount <= per_payment_cap`
  const amount = toBigInt(request.amount);
  const perPaymentCap = toBigInt(mandate.perPaymentCap);
  if (amount <= BigInt(0) || amount > perPaymentCap) {
    return { ok: false, code: "OVER_PER_PAYMENT_CAP" };
  }

  // Step 5: open requests below `MAX_OPEN` (32)
  const openRequests = state.openRequests ?? 0;
  if (openRequests >= MAX_OPEN) {
    return { ok: false, code: "TOO_MANY_OPEN" };
  }

  // Step 6: budget (`ceiling = min(budget, deposited.saturating_sub(withdrawn))`, u128 overflow checked)
  const budget = toBigInt(mandate.budget);
  const deposited = toBigInt(state.deposited);
  const withdrawn = toBigInt(state.withdrawn ?? "0");
  const spent = toBigInt(state.spent);
  const reserved = toBigInt(state.reserved ?? "0");

  const netDeposited = deposited > withdrawn ? deposited - withdrawn : BigInt(0);
  const ceiling = budget < netDeposited ? budget : netDeposited;
  const needed = spent + reserved + amount;

  if (
    spent > U128_MAX ||
    reserved > U128_MAX ||
    amount > U128_MAX ||
    spent + reserved > U128_MAX ||
    needed > U128_MAX ||
    needed > ceiling
  ) {
    return { ok: false, code: "OVER_BUDGET" };
  }

  // Step 7: guardian approval required when `amount > approval_threshold`
  const approvalThreshold = toBigInt(mandate.approvalThreshold);
  if (amount > approvalThreshold) {
    const mandateId = mandate.id ?? 1;
    const match = (state.approvals ?? []).find(
      (a) =>
        (a.mandateId ?? mandateId) === mandateId &&
        a.recipient === request.recipient &&
        toBigInt(a.amount) === amount &&
        a.nonce === request.nonce &&
        (a.mandateExpiresAtMs ?? mandate.expiresAtMs) === mandate.expiresAtMs,
    );
    if (!match) {
      return { ok: false, code: "NEEDS_APPROVAL" };
    }
    if (match.used) {
      return { ok: false, code: "APPROVAL_USED" };
    }
    if (state.nowMs >= match.expiresAtMs) {
      return { ok: false, code: "APPROVAL_EXPIRED" };
    }
  }

  return { ok: true };
}
