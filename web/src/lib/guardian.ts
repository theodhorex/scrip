// Pure mirror of `tighten` and `loosen` policy checks in `contracts/scrip/src/lib.rs`.
// Order of checks, bound conditions, and error codes match lib.rs identically.
// Uses only erasable TypeScript syntax so `node --test` executes it natively.

export const MAX_RECIPIENTS = 16;
export const MAX_RECIPIENT_BYTES = 64;

export type AmountInput = string | bigint;

export type GuardianRejectCode =
  | "NOT_STRICTER"
  | "NOT_LOOSER"
  | "BUDGET_BELOW_COMMITTED"
  | "BUDGET_ABOVE_DEPOSITED"
  | "CAP_ABOVE_BUDGET"
  | "THRESHOLD_ABOVE_CAP"
  | "EXPIRY_NOT_IN_FUTURE"
  | "NO_SUCH_RECIPIENT"
  | "DUPLICATE_RECIPIENT"
  | "TOO_MANY_RECIPIENTS"
  | "INVALID_RECIPIENT"
  | "NOT_ACTIVE";

export type GuardianMandate = {
  id?: number;
  status?: "Active" | "Revoked";
  budget: AmountInput;
  perPaymentCap: AmountInput;
  approvalThreshold: AmountInput;
  expiresAtMs: number;
  recipients: readonly string[];
  deposited?: AmountInput;
  spent?: AmountInput;
  reserved?: AmountInput;
  withdrawn?: AmountInput;
  [key: string]: unknown;
};

export type GuardianState = {
  deposited?: AmountInput;
  spent?: AmountInput;
  reserved?: AmountInput;
  withdrawn?: AmountInput;
  nowMs?: number;
  [key: string]: unknown;
};

export type Change =
  | { Budget: AmountInput }
  | { PerPaymentCap: AmountInput }
  | { ApprovalThreshold: AmountInput }
  | { AddRecipient: string }
  | { RemoveRecipient: string }
  | { Expiry: number }
  | { type: "Budget"; value: AmountInput }
  | { type: "PerPaymentCap"; value: AmountInput }
  | { type: "ApprovalThreshold"; value: AmountInput }
  | { type: "AddRecipient"; recipient?: string; value?: string }
  | { type: "RemoveRecipient"; recipient?: string; value?: string }
  | { type: "Expiry"; expiry?: number; value?: number };

export type GuardianResult =
  | { ok: true; mandate: GuardianMandate }
  | { ok: false; code: GuardianRejectCode };

const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/;

function toBigInt(value: AmountInput): bigint {
  if (typeof value === "bigint") return value;
  const trimmed = value.trim();
  if (!DECIMAL_UINT.test(trimmed)) {
    throw new Error(`Invalid integer amount: "${value}"`);
  }
  return BigInt(trimmed);
}

// Recipient rule: 1..=64 bytes of [a-z0-9._-]
export function validateRecipient(recipient: string): boolean {
  if (!recipient || recipient.length > MAX_RECIPIENT_BYTES) {
    return false;
  }
  return /^[a-z0-9._-]+$/.test(recipient);
}

type ParsedChange =
  | { kind: "Budget"; value: bigint }
  | { kind: "PerPaymentCap"; value: bigint }
  | { kind: "ApprovalThreshold"; value: bigint }
  | { kind: "AddRecipient"; recipient: string }
  | { kind: "RemoveRecipient"; recipient: string }
  | { kind: "Expiry"; expiryMs: number };

function parseChange(change: Change): ParsedChange {
  if ("Budget" in change) {
    return { kind: "Budget", value: toBigInt(change.Budget) };
  }
  if ("PerPaymentCap" in change) {
    return { kind: "PerPaymentCap", value: toBigInt(change.PerPaymentCap) };
  }
  if ("ApprovalThreshold" in change) {
    return { kind: "ApprovalThreshold", value: toBigInt(change.ApprovalThreshold) };
  }
  if ("AddRecipient" in change) {
    return { kind: "AddRecipient", recipient: change.AddRecipient };
  }
  if ("RemoveRecipient" in change) {
    return { kind: "RemoveRecipient", recipient: change.RemoveRecipient };
  }
  if ("Expiry" in change) {
    return { kind: "Expiry", expiryMs: change.Expiry };
  }

  // Discriminated union format
  if ("type" in change) {
    switch (change.type) {
      case "Budget":
        return { kind: "Budget", value: toBigInt(change.value) };
      case "PerPaymentCap":
        return { kind: "PerPaymentCap", value: toBigInt(change.value) };
      case "ApprovalThreshold":
        return { kind: "ApprovalThreshold", value: toBigInt(change.value) };
      case "AddRecipient":
        return { kind: "AddRecipient", recipient: change.recipient ?? change.value ?? "" };
      case "RemoveRecipient":
        return { kind: "RemoveRecipient", recipient: change.recipient ?? change.value ?? "" };
      case "Expiry":
        return { kind: "Expiry", expiryMs: change.expiry ?? change.value ?? 0 };
    }
  }

  throw new Error(`Unsupported change structure: ${JSON.stringify(change)}`);
}

export function applyChange(
  mode: "tighten" | "loosen",
  mandate: GuardianMandate,
  state: GuardianState,
  change: Change,
): GuardianResult {
  if (mandate.status && mandate.status !== "Active") {
    return { ok: false, code: "NOT_ACTIVE" };
  }

  const parsed = parseChange(change);

  if (mode === "tighten") {
    switch (parsed.kind) {
      case "Budget": {
        const currentBudget = toBigInt(mandate.budget);
        if (parsed.value >= currentBudget) {
          return { ok: false, code: "NOT_STRICTER" };
        }
        const spent = toBigInt(state?.spent ?? mandate.spent ?? "0");
        const reserved = toBigInt(state?.reserved ?? mandate.reserved ?? "0");
        const committed = spent + reserved;
        if (parsed.value < committed) {
          return { ok: false, code: "BUDGET_BELOW_COMMITTED" };
        }
        return {
          ok: true,
          mandate: {
            ...mandate,
            budget: parsed.value.toString(),
          },
        };
      }

      case "PerPaymentCap": {
        const currentCap = toBigInt(mandate.perPaymentCap);
        if (parsed.value >= currentCap) {
          return { ok: false, code: "NOT_STRICTER" };
        }
        return {
          ok: true,
          mandate: {
            ...mandate,
            perPaymentCap: parsed.value.toString(),
          },
        };
      }

      case "ApprovalThreshold": {
        const currentThreshold = toBigInt(mandate.approvalThreshold);
        if (parsed.value >= currentThreshold) {
          return { ok: false, code: "NOT_STRICTER" };
        }
        return {
          ok: true,
          mandate: {
            ...mandate,
            approvalThreshold: parsed.value.toString(),
          },
        };
      }

      case "AddRecipient": {
        return { ok: false, code: "NOT_STRICTER" };
      }

      case "RemoveRecipient": {
        if (!mandate.recipients.includes(parsed.recipient)) {
          return { ok: false, code: "NO_SUCH_RECIPIENT" };
        }
        return {
          ok: true,
          mandate: {
            ...mandate,
            recipients: mandate.recipients.filter((r) => r !== parsed.recipient),
          },
        };
      }

      case "Expiry": {
        if (parsed.expiryMs >= mandate.expiresAtMs) {
          return { ok: false, code: "NOT_STRICTER" };
        }
        const now = state?.nowMs ?? Date.now();
        if (parsed.expiryMs <= now) {
          return { ok: false, code: "EXPIRY_NOT_IN_FUTURE" };
        }
        return {
          ok: true,
          mandate: {
            ...mandate,
            expiresAtMs: parsed.expiryMs,
          },
        };
      }
    }
  }

  // mode === "loosen"
  switch (parsed.kind) {
    case "Budget": {
      const currentBudget = toBigInt(mandate.budget);
      if (parsed.value <= currentBudget) {
        return { ok: false, code: "NOT_LOOSER" };
      }
      const deposited = toBigInt(state?.deposited ?? mandate.deposited ?? "0");
      const withdrawn = toBigInt(state?.withdrawn ?? mandate.withdrawn ?? "0");
      const free = deposited > withdrawn ? deposited - withdrawn : BigInt(0);
      if (parsed.value > free) {
        return { ok: false, code: "BUDGET_ABOVE_DEPOSITED" };
      }
      return {
        ok: true,
        mandate: {
          ...mandate,
          budget: parsed.value.toString(),
        },
      };
    }

    case "PerPaymentCap": {
      const currentCap = toBigInt(mandate.perPaymentCap);
      if (parsed.value <= currentCap) {
        return { ok: false, code: "NOT_LOOSER" };
      }
      const currentBudget = toBigInt(mandate.budget);
      if (parsed.value > currentBudget) {
        return { ok: false, code: "CAP_ABOVE_BUDGET" };
      }
      return {
        ok: true,
        mandate: {
          ...mandate,
          perPaymentCap: parsed.value.toString(),
        },
      };
    }

    case "ApprovalThreshold": {
      const currentThreshold = toBigInt(mandate.approvalThreshold);
      if (parsed.value <= currentThreshold) {
        return { ok: false, code: "NOT_LOOSER" };
      }
      const currentCap = toBigInt(mandate.perPaymentCap);
      if (parsed.value > currentCap) {
        return { ok: false, code: "THRESHOLD_ABOVE_CAP" };
      }
      return {
        ok: true,
        mandate: {
          ...mandate,
          approvalThreshold: parsed.value.toString(),
        },
      };
    }

    case "AddRecipient": {
      if (!validateRecipient(parsed.recipient)) {
        return { ok: false, code: "INVALID_RECIPIENT" };
      }
      if (mandate.recipients.includes(parsed.recipient)) {
        return { ok: false, code: "DUPLICATE_RECIPIENT" };
      }
      if (mandate.recipients.length >= MAX_RECIPIENTS) {
        return { ok: false, code: "TOO_MANY_RECIPIENTS" };
      }
      return {
        ok: true,
        mandate: {
          ...mandate,
          recipients: [...mandate.recipients, parsed.recipient],
        },
      };
    }

    case "RemoveRecipient": {
      return { ok: false, code: "NOT_LOOSER" };
    }

    case "Expiry": {
      if (parsed.expiryMs <= mandate.expiresAtMs) {
        return { ok: false, code: "NOT_LOOSER" };
      }
      return {
        ok: true,
        mandate: {
          ...mandate,
          expiresAtMs: parsed.expiryMs,
        },
      };
    }
  }
}
