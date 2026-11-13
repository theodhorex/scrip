// Owner flow (pure): builds the wallet transactions that let anyone create their own mandate
// on the live Scrip contract from the browser. Erasable TypeScript only, so `node --test` imports it.
//
// Flow: (1) one wallet approval creates two sub-accounts of the owner: the agent (with a
// function-call key that can only call request_payment on the contract) and the guardian;
// (2) create_mandate; (3) fund it with an NEP-141 token (testnet USDC, or wNEAR wrapped in the
// same transaction); later (4) revoke and (5) withdraw what is left.

export type TokenInfo = { id: string; symbol: string; decimals: number; wrapsNear: boolean };

export const TOKENS: Record<"wnear" | "usdc", TokenInfo> = {
  wnear: { id: "wrap.testnet", symbol: "wNEAR", decimals: 24, wrapsNear: true },
  usdc: { id: "3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af", symbol: "USDC", decimals: 6, wrapsNear: false },
};

export const YOCTO_PER_NEAR = BigInt("1000000000000000000000000");
export const STORAGE_DEPOSIT_YOCTO = "1250000000000000000000"; // 0.00125 NEAR, NEP-145 registration on both tokens
export const MANDATE_DEPOSIT_YOCTO = "50000000000000000000000"; // 0.05 NEAR, required by create_mandate
export const TGAS = BigInt("1000000000000");
const gas = (t: number) => (BigInt(t) * TGAS).toString();

export type WalletAction =
  | { type: "CreateAccount" }
  | { type: "Transfer"; params: { deposit: string } }
  | { type: "AddKey"; params: { publicKey: string; accessKey: { permission: "FullAccess" | { receiverId: string; allowance?: string; methodNames?: string[] } } } }
  | { type: "FunctionCall"; params: { methodName: string; args: object; gas: string; deposit: string } };

export type WalletTx = { receiverId: string; actions: WalletAction[] };

/** "1.5" with 24 decimals -> "1500000000000000000000000". Null unless a plain positive decimal within `decimals` places. */
export function toUnits(value: string, decimals: number): string | null {
  const t = value.trim();
  const re = decimals > 0 ? new RegExp(`^\\d+(\\.\\d{1,${decimals}})?$`) : /^\d+$/;
  if (!re.test(t)) return null;
  const [w, f = ""] = t.split(".");
  const units = BigInt(w) * BigInt(10) ** BigInt(decimals) + BigInt(f.padEnd(decimals, "0") || "0");
  return units > BigInt(0) ? units.toString() : null;
}

export function fromUnits(units: string, decimals: number): string {
  if (decimals === 0) return units;
  const p = units.padStart(decimals + 1, "0");
  const whole = p.slice(0, -decimals).replace(/^0+(?=\d)/, "");
  const frac = p.slice(-decimals).replace(/0+$/, "");
  return frac ? `${whole}.${frac}` : whole;
}

export function nearToYocto(near: string): string {
  const u = toUnits(near, 24);
  if (!u) throw new Error(`bad NEAR amount: ${near}`);
  return u;
}

/** Implicit (64 hex) and EVM-style accounts cannot create sub-accounts; named .testnet accounts can. */
export function canCreateSubaccounts(ownerId: string): boolean {
  if (/^[0-9a-f]{64}$/.test(ownerId)) return false;
  if (/^0x[0-9a-f]{40}$/.test(ownerId)) return false;
  return ownerId.endsWith(".testnet") && ownerId.length <= 64 - "scrip-agent-xxxxxx.".length;
}

/** Six lowercase base-36 characters from the given random bytes (crypto.getRandomValues in the browser). */
export function suffixFrom(bytes: Uint8Array): string {
  return Array.from(bytes.slice(0, 6), (b) => (b % 36).toString(36)).join("");
}

export function partyIds(ownerId: string, suffix: string): { agentId: string; guardianId: string } {
  return { agentId: `scrip-agent-${suffix}.${ownerId}`, guardianId: `scrip-guard-${suffix}.${ownerId}` };
}

export type SetupInput = {
  contractId: string;
  agentId: string;
  guardianId: string;
  agentPublicKey: string;
  guardianPublicKey: string;
  agentNear: string; // NEAR moved to the agent account; it pays the gas of request_payment
  allowanceNear: string; // gas allowance on the agent's function-call key
  guardianNear: string;
};

/** Transactions for the first wallet approval: create the agent and the guardian. */
export function buildSetupTxs(i: SetupInput): WalletTx[] {
  return [
    {
      receiverId: i.agentId,
      actions: [
        { type: "CreateAccount" },
        { type: "Transfer", params: { deposit: nearToYocto(i.agentNear) } },
        {
          type: "AddKey",
          params: {
            publicKey: i.agentPublicKey,
            accessKey: { permission: { receiverId: i.contractId, allowance: nearToYocto(i.allowanceNear), methodNames: ["request_payment"] } },
          },
        },
      ],
    },
    {
      receiverId: i.guardianId,
      actions: [
        { type: "CreateAccount" },
        { type: "Transfer", params: { deposit: nearToYocto(i.guardianNear) } },
        { type: "AddKey", params: { publicKey: i.guardianPublicKey, accessKey: { permission: "FullAccess" } } },
      ],
    },
  ];
}

export type MandateInput = {
  contractId: string;
  agentId: string;
  guardianId: string;
  token: TokenInfo;
  budget: string;
  perPaymentCap: string;
  approvalThreshold: string;
  recipients: string[];
  expiresAtMs: number;
};

export type MandateCheck = { ok: true; budget: string; cap: string; threshold: string } | { ok: false; error: string };

/** Mirrors the contract's create_mandate checks so the wallet is only opened for a call that can succeed. */
export function checkMandate(ownerId: string, i: MandateInput, nowMs: number): MandateCheck {
  const budget = toUnits(i.budget, i.token.decimals);
  const cap = toUnits(i.perPaymentCap, i.token.decimals);
  const threshold = toUnits(i.approvalThreshold, i.token.decimals);
  if (!budget || !cap || !threshold) return { ok: false, error: `Amounts must be positive numbers with up to ${i.token.decimals} decimals.` };
  if (BigInt(budget) < BigInt(cap)) return { ok: false, error: "The budget must be at least the per-payment cap." };
  if (BigInt(threshold) > BigInt(cap)) return { ok: false, error: "The approval threshold cannot be above the per-payment cap." };
  if (i.recipients.length === 0) return { ok: false, error: "Add at least one allowed recipient." };
  if (i.recipients.length > 16) return { ok: false, error: "At most 16 allowed recipients." };
  if (new Set(i.recipients).size !== i.recipients.length) return { ok: false, error: "Each recipient can appear only once." };
  if (i.agentId === ownerId) return { ok: false, error: "The agent cannot be the owner." };
  if (i.guardianId === ownerId || i.guardianId === i.agentId) return { ok: false, error: "The guardian must differ from the owner and the agent." };
  if (i.expiresAtMs <= nowMs) return { ok: false, error: "The expiry must be in the future." };
  return { ok: true, budget, cap, threshold };
}

export function buildCreateMandateTx(i: MandateInput, units: { budget: string; cap: string; threshold: string }): WalletTx {
  return {
    receiverId: i.contractId,
    actions: [
      {
        type: "FunctionCall",
        params: {
          methodName: "create_mandate",
          args: {
            agent: i.agentId,
            guardian: i.guardianId,
            token: i.token.id,
            budget: units.budget,
            per_payment_cap: units.cap,
            approval_threshold: units.threshold,
            recipients: i.recipients,
            expires_at_ms: i.expiresAtMs,
          },
          gas: gas(60),
          deposit: MANDATE_DEPOSIT_YOCTO,
        },
      },
    ],
  };
}

/**
 * One transaction to the token contract: register the owner, the Scrip contract and every recipient
 * (registration_only refunds the deposit when already registered), wrap NEAR first when the token is
 * wNEAR, then ft_transfer_call into the mandate. Recipients must be registered or a payment would be refunded.
 */
export function buildFundTx(p: { token: TokenInfo; contractId: string; ownerId: string; mandateId: number; amountUnits: string; recipients: string[] }): WalletTx {
  const register = [p.ownerId, p.contractId, ...p.recipients].map<WalletAction>((account_id) => ({
    type: "FunctionCall",
    params: { methodName: "storage_deposit", args: { account_id, registration_only: true }, gas: gas(10), deposit: STORAGE_DEPOSIT_YOCTO },
  }));
  const wrap: WalletAction[] = p.token.wrapsNear
    ? [{ type: "FunctionCall", params: { methodName: "near_deposit", args: {}, gas: gas(10), deposit: p.amountUnits } }]
    : [];
  const transfer: WalletAction = {
    type: "FunctionCall",
    params: {
      methodName: "ft_transfer_call",
      args: { receiver_id: p.contractId, amount: p.amountUnits, msg: JSON.stringify({ mandate_id: p.mandateId }) },
      gas: gas(100),
      deposit: "1",
    },
  };
  return { receiverId: p.token.id, actions: [...register, ...wrap, transfer] };
}

export function buildRevokeTx(contractId: string, mandateId: number): WalletTx {
  return { receiverId: contractId, actions: [{ type: "FunctionCall", params: { methodName: "revoke", args: { mandate_id: mandateId }, gas: gas(30), deposit: "0" } }] };
}

export function buildWithdrawTx(contractId: string, mandateId: number, amountUnits: string): WalletTx {
  return { receiverId: contractId, actions: [{ type: "FunctionCall", params: { methodName: "withdraw", args: { mandate_id: mandateId, amount: amountUnits }, gas: gas(100), deposit: "0" } }] };
}

/** Free remainder an owner can withdraw after revoke: deposited - spent - reserved - withdrawn (never negative). */
export function freeRemainder(m: { deposited: string; spent: string; reserved: string; withdrawn: string }): string {
  const v = BigInt(m.deposited) - BigInt(m.spent) - BigInt(m.reserved) - BigInt(m.withdrawn);
  return v > BigInt(0) ? v.toString() : "0";
}

function b64ToText(s: string): string {
  const bin = atob(s);
  return new TextDecoder().decode(Uint8Array.from(bin, (c) => c.charCodeAt(0)));
}

/** The new mandate id from a create_mandate outcome: the return value, or the mandate_created event as a fallback. */
export function mandateIdFromOutcome(outcome: unknown): number | null {
  const o = outcome as {
    status?: { SuccessValue?: string };
    receipts_outcome?: Array<{ outcome?: { logs?: string[] } }>;
  } | null;
  const sv = o?.status?.SuccessValue;
  if (typeof sv === "string" && sv.length > 0) {
    try {
      const v = JSON.parse(b64ToText(sv));
      if (Number.isSafeInteger(Number(v))) return Number(v);
    } catch {
      /* fall through to the event */
    }
  }
  for (const r of o?.receipts_outcome ?? []) {
    for (const log of r.outcome?.logs ?? []) {
      if (!log.startsWith("EVENT_JSON:")) continue;
      try {
        const ev = JSON.parse(log.slice("EVENT_JSON:".length)) as { event?: string; data?: Array<{ mandate_id?: number | string }> };
        const id = ev.event === "mandate_created" ? ev.data?.[0]?.mandate_id : undefined;
        if (id !== undefined && Number.isSafeInteger(Number(id))) return Number(id);
      } catch {
        /* not ours */
      }
    }
  }
  return null;
}

/** True when an outcome's top-level status is a failure (the wallet resolved, but the chain said no). */
export function outcomeFailed(outcome: unknown): string | null {
  const st = (outcome as { status?: Record<string, unknown> } | null)?.status;
  if (st && typeof st === "object" && "Failure" in st) return JSON.stringify(st.Failure).slice(0, 300);
  return null;
}

/** What the browser keeps for one mandate the visitor created (testnet only; keys stay in this browser). */
export type OwnedMandate = {
  v: 1;
  ownerId: string;
  contractId: string;
  mandateId: number | null;
  agentId: string;
  agentPublicKey: string;
  agentKey: string;
  guardianId: string;
  guardianKey: string;
  token: TokenInfo;
  recipients: string[];
  budget: string;
  perPaymentCap: string;
  approvalThreshold: string;
  expiresAtMs: number;
  createdAt: string;
  funded: boolean;
  txs: Record<string, string>;
};

export function parseOwned(raw: string | null): OwnedMandate[] {
  if (!raw) return [];
  try {
    const v = JSON.parse(raw);
    return Array.isArray(v) ? v.filter((m) => m && m.v === 1 && typeof m.agentId === "string" && typeof m.agentKey === "string") : [];
  } catch {
    return [];
  }
}
