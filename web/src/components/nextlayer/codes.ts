/** Plain-English reading of the contract's reject codes. Order numbers follow request_payment in contracts/scrip/src/lib.rs. */
export const REJECT_TEXT: Record<string, { step: string; text: string }> = {
  NOT_ACTIVE: { step: "check 2", text: "The mandate is revoked, so nothing can be spent." },
  EXPIRED: { step: "check 2", text: "The mandate has expired." },
  RECIPIENT_NOT_ALLOWED: { step: "check 3", text: "That account is not on the mandate's recipient list. The list is fixed by the owner; the agent cannot add to it." },
  OVER_PER_PAYMENT_CAP: { step: "check 4", text: "The amount is above the per-payment cap (or zero)." },
  TOO_MANY_OPEN: { step: "check 5", text: "Too many requests are waiting for their transfer to finish (limit 32)." },
  OVER_BUDGET: { step: "check 6", text: "Spent + reserved + this amount would pass the budget. The budget is a ceiling, not a target." },
  NEEDS_APPROVAL: { step: "check 7", text: "Above the approval threshold, so the guardian must approve this exact payment first." },
  APPROVAL_USED: { step: "check 7", text: "That approval was already used once." },
  APPROVAL_EXPIRED: { step: "check 7", text: "That approval has expired." },
};
