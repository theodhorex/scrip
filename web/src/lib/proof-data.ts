// Pure mapper for real testnet gate proof output (`src/data/gate.json`).
// All hashes and numbers are derived from the recorded testnet run.
// Uses erasable TypeScript + standard JSON import attributes for native Node test execution.
import gateJson from "../data/gate.json" with { type: "json" };
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { EXPLORER_TX_BASE } from "./network.ts";

const USDC_DECIMALS = 6;
const USDC_BASE = BigInt(10) ** BigInt(USDC_DECIMALS);
const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/;

export type ProofStep = {
  key: string;
  label: string;
  hash: string;
  shortHash: string;
  explorerUrl: string;
  explanation: string;
  resultSummary: string | null;
};

export type AttackProof = {
  key: string;
  label: string;
  rejectionCode: string;
  httpStatus: number;
  txHash: string | null;
  shortTx: string | null;
  note: string;
};

export type CleanExitProof = {
  leftoverAccounts: string[];
  leftoverCount: number;
  funderUsdcBefore: string;
  funderUsdcAfter: string;
  funderBalanced: boolean;
  contractUsdcLeft: string;
  contractDrained: boolean;
  withdrawnUsdc: string;
};

export type ProofLandingData = {
  network: string;
  startedAt: string;
  finishedAt: string;
  wasmBytes: number;
  steps: ProofStep[];
  attacks: AttackProof[];
  cleanup: CleanExitProof;
};

function asObject(value: unknown, label: string): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new Error(`Invalid ${label}: expected object`);
  }
  return value as Record<string, unknown>;
}

function asString(obj: Record<string, unknown>, key: string, label: string): string {
  const v = obj[key];
  if (typeof v !== "string" || v.length === 0) {
    throw new Error(`Invalid ${label}.${key}: expected non-empty string`);
  }
  return v;
}

function asAmountString(obj: Record<string, unknown>, key: string, label: string): string {
  const v = obj[key];
  if (typeof v !== "string" || !DECIMAL_UINT.test(v)) {
    throw new Error(`Invalid ${label}.${key}: expected canonical decimal uint string`);
  }
  return v;
}

export function formatUsdc6(rawUnits: string | bigint, fractionDigits = 2): string {
  const units =
    typeof rawUnits === "bigint"
      ? rawUnits
      : (() => {
          if (!DECIMAL_UINT.test(rawUnits)) {
            throw new Error(`Invalid USDC unit string: "${rawUnits}"`);
          }
          return BigInt(rawUnits);
        })();

  const whole = units / USDC_BASE;
  const rem = units % USDC_BASE;
  const fullFrac = rem.toString().padStart(USDC_DECIMALS, "0");
  if (fractionDigits <= 0) return whole.toString();
  const sliced = fullFrac.slice(0, fractionDigits).padEnd(fractionDigits, "0");
  return `${whole.toString()}.${sliced}`;
}

export function shortenHash(hash: string): string {
  if (typeof hash !== "string" || hash.length <= 10) return hash;
  return `${hash.slice(0, 4)}…${hash.slice(-3)}`;
}

export function explorerTxUrl(hash: string): string {
  const base = EXPLORER_TX_BASE.replace(/\/+$/, "");
  return `${base}/${encodeURIComponent(hash)}`;
}

export function mapProofData(raw: unknown): ProofLandingData {
  const root = asObject(raw, "gate.json");
  const network = asString(root, "network", "gate.json");
  const startedAt = asString(root, "startedAt", "gate.json");
  const finishedAt = asString(root, "finishedAt", "gate.json");
  const wasmBytes = typeof root.wasmBytes === "number" ? root.wasmBytes : 0;

  const txs = asObject(root.txs, "gate.json.txs");
  const stepsObj = asObject(root.steps, "gate.json.steps");
  const funded = asObject(stepsObj.funded, "gate.json.steps.funded");
  const validPayment = asObject(stepsObj.validPayment, "gate.json.steps.validPayment");
  const exit = asObject(stepsObj.exit, "gate.json.steps.exit");
  const attacksObj = asObject(stepsObj.attacks, "gate.json.steps.attacks");

  const depositedUsdc = formatUsdc6(asAmountString(funded, "deposited", "funded"));
  const spentUsdc = formatUsdc6(asAmountString(validPayment, "spent", "validPayment"));
  const merchantGainedUsdc = formatUsdc6(
    asAmountString(validPayment, "merchantGained", "validPayment"),
  );
  const withdrawnUsdc = formatUsdc6(asAmountString(exit, "withdrawn", "exit"));
  const contractUsdcLeftUnits = asAmountString(exit, "contractUsdcLeft", "exit");
  const contractUsdcLeft = formatUsdc6(contractUsdcLeftUnits);

  const steps: ProofStep[] = [
    {
      key: "deploy",
      label: "Deploy",
      hash: asString(txs, "deploy", "gate.json.txs"),
      shortHash: shortenHash(asString(txs, "deploy", "gate.json.txs")),
      explorerUrl: explorerTxUrl(asString(txs, "deploy", "gate.json.txs")),
      explanation: "Deploy Amanat smart contract wasm binary to NEAR testnet",
      resultSummary: wasmBytes > 0 ? `${Math.round(wasmBytes / 1024)} KB wasm bytecode` : null,
    },
    {
      key: "init",
      label: "Initialize",
      hash: asString(txs, "init", "gate.json.txs"),
      shortHash: shortenHash(asString(txs, "init", "gate.json.txs")),
      explorerUrl: explorerTxUrl(asString(txs, "init", "gate.json.txs")),
      explanation: "Initialize contract state with testnet admin authority",
      resultSummary: "Contract initialized and active",
    },
    {
      key: "createMandate",
      label: "Create Mandate",
      hash: asString(txs, "createMandate", "gate.json.txs"),
      shortHash: shortenHash(asString(txs, "createMandate", "gate.json.txs")),
      explorerUrl: explorerTxUrl(asString(txs, "createMandate", "gate.json.txs")),
      explanation: "Register spending mandate with strict per-payment cap and merchant whitelist",
      resultSummary: "Mandate registered with the rules engine",
    },
    {
      key: "fund",
      label: "Fund Mandate",
      hash: asString(txs, "fund", "gate.json.txs"),
      shortHash: shortenHash(asString(txs, "fund", "gate.json.txs")),
      explorerUrl: explorerTxUrl(asString(txs, "fund", "gate.json.txs")),
      explanation: "Deposit 6-decimal NEP-141 USDC into mandate escrow vault",
      resultSummary: `Deposited ${depositedUsdc} USDC into vault`,
    },
    {
      key: "validPayment",
      label: "Valid Payment",
      hash: asString(txs, "validPayment", "gate.json.txs"),
      shortHash: shortenHash(asString(txs, "validPayment", "gate.json.txs")),
      explorerUrl: explorerTxUrl(asString(txs, "validPayment", "gate.json.txs")),
      explanation: "Authorized AI agent settles payment to whitelisted merchant via gasless relayer",
      resultSummary: `Spent ${spentUsdc} USDC · Merchant gained ${merchantGainedUsdc} USDC`,
    },
    {
      key: "revoke",
      label: "Revoke Mandate",
      hash: asString(txs, "revoke", "gate.json.txs"),
      shortHash: shortenHash(asString(txs, "revoke", "gate.json.txs")),
      explorerUrl: explorerTxUrl(asString(txs, "revoke", "gate.json.txs")),
      explanation: "Owner immediately revokes mandate, locking all further withdrawals and payments",
      resultSummary: "Mandate status set to Revoked",
    },
    {
      key: "withdraw",
      label: "Withdraw Remainder",
      hash: asString(txs, "withdraw", "gate.json.txs"),
      shortHash: shortenHash(asString(txs, "withdraw", "gate.json.txs")),
      explorerUrl: explorerTxUrl(asString(txs, "withdraw", "gate.json.txs")),
      explanation: "Funder recovers 100% of unused USDC escrow back to funding wallet",
      resultSummary: `Withdrawn ${withdrawnUsdc} USDC · Contract left: ${contractUsdcLeft} USDC`,
    },
  ];

  // Map attacks accurately from gate.json.steps.attacks
  const attackDefs: Array<{
    key: string;
    label: string;
    note: string;
  }> = [
    {
      key: "recipientNotAllowed",
      label: "Unauthorized recipient",
      note: "Prompt-injected agent attempted transfer to non-whitelisted recipient; rejected on-chain",
    },
    {
      key: "overCap",
      label: "Over per-payment cap",
      note: "Payment exceeding the per-transaction limit was blocked by the atomic guard",
    },
    {
      key: "guardianMethodViaRelay",
      label: "Guardian method via relay",
      note: "Attacker tried to call guardian-only contract method through relayer; rejected with 400",
    },
    {
      key: "lowGas",
      label: "Insufficient gas invocation",
      note: "Underfunded gas payload refused by relay facilitator before hitting the chain",
    },
    {
      key: "forgedKey",
      label: "Forged signature key",
      note: "Transaction signed with an unauthorized public key rejected by relay facilitator",
    },
  ];

  const attacks: AttackProof[] = attackDefs.map((def) => {
    const rawAttack = asObject(attacksObj[def.key], `gate.json.steps.attacks.${def.key}`);
    const httpStatus = typeof rawAttack.http === "number" ? rawAttack.http : 400;

    let rejectionCode = "";
    if (typeof rawAttack.code === "string") {
      rejectionCode = rawAttack.code;
    } else if (Array.isArray(rawAttack.rejected) && typeof rawAttack.rejected[0] === "string") {
      rejectionCode = rawAttack.rejected[0];
    }

    const txHash = typeof rawAttack.tx === "string" ? rawAttack.tx : null;

    return {
      key: def.key,
      label: def.label,
      rejectionCode,
      httpStatus,
      txHash,
      shortTx: txHash ? shortenHash(txHash) : null,
      note: def.note,
    };
  });

  // Cleanup section
  const beforeObj = asObject(root.before, "gate.json.before");
  const afterObj = asObject(root.after, "gate.json.after");
  const funderUsdcBefore = formatUsdc6(
    asAmountString(beforeObj, "funderUsdc", "gate.json.before"),
  );
  const funderUsdcAfter = formatUsdc6(
    asAmountString(afterObj, "funderUsdc", "gate.json.after"),
  );

  const rawLeftovers = (root as Record<string, unknown>).leftoverAccounts;
  const leftoverAccounts = Array.isArray(rawLeftovers)
    ? rawLeftovers.filter((item): item is string => typeof item === "string")
    : [];

  return {
    network,
    startedAt,
    finishedAt,
    wasmBytes,
    steps,
    attacks,
    cleanup: {
      leftoverAccounts,
      leftoverCount: leftoverAccounts.length,
      funderUsdcBefore,
      funderUsdcAfter,
      funderBalanced: funderUsdcBefore === funderUsdcAfter,
      contractUsdcLeft,
      contractDrained: contractUsdcLeftUnits === "0",
      withdrawnUsdc,
    },
  };
}

export const PROOF_DATA: ProofLandingData = mapProofData(gateJson);
