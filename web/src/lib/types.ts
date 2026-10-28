// Mirrors the Mandate model in AMANAT_PRD_dan_Rencana_Eksekusi.md section 3.1.
// All amounts are U128 JSON strings (token base units).
export type U128 = string;

export type MandateStatus = "Active" | "Revoked";

export type Mandate = {
  id: number;
  owner: string;
  guardian: string;
  agent: string;
  token: string;
  deposited: U128;
  budget: U128;
  spent: U128;
  reserved: U128;
  withdrawn: U128;
  perPaymentCap: U128;
  approvalThreshold: U128;
  expiresAtMs: number;
  status: MandateStatus;
  openRequests: number;
  recipients: string[];
};

// Event names from the NEP-297 standard `amanat` v1.0.0 (PRD section 3.5).
export type AmanatEventName =
  | "mandate_created"
  | "deposited"
  | "reserved"
  | "rejected"
  | "settled"
  | "refunded"
  | "intent_approved"
  | "tightened"
  | "loosened"
  | "revoked"
  | "withdrawn"
  | "stale_resolved";

// Rejection codes returned by request_payment (PRD section 3.3).
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

export type AmanatEvent = {
  name: AmanatEventName;
  mandateId: number;
  requestId?: number;
  recipient?: string;
  amount?: U128;
  code?: RejectCode;
  atMs: number;
  txHash?: string;
};
