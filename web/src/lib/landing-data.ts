// Pure mapper for real testnet outputs copied into `src/data/attack.json` and `src/data/demo.json`.
// No outcome numbers are hardcoded: every figure rendered on the landing page is derived here.
// Uses erasable TypeScript + standard JSON import attributes so `node --test` runs natively.
import attackJson from "../data/attack.json" with { type: "json" };
import demoJson from "../data/demo.json" with { type: "json" };

const USDC_DECIMALS = 6;
const USDC_BASE = BigInt(10) ** BigInt(USDC_DECIMALS);
const DECIMAL_UINT = /^(0|[1-9][0-9]*)$/;

export type RaceContractCase = {
  contract: "naive" | "scrip";
  attempts: number;
  acceptedByRpc: number;
  burstMs: number;
  burstSeconds: string;
  paymentsPaid: number;
  spentUnits: string;
  spentUsdc: string;
  overBudgetUnits: string;
  overBudgetUsdc: string;
  exceededBudget: boolean;
};

export type LandingRaceData = {
  network: string;
  startedAt: string;
  finishedAt: string;
  totalAttempts: number;
  paceMs: number;
  paymentUnits: string;
  paymentUsdc: string;
  budgetUnits: string;
  budgetUsdc: string;
  fundedUnits: string;
  fundedUsdc: string;
  naive: RaceContractCase;
  scrip: RaceContractCase;
};

export type LandingHeroDemoData = {
  network: string;
  startedAt: string;
  note: string;
  fundedUnits: string;
  fundedUsdc: string;
  merchantAccount: string;
  merchantShort: string;
  attackerAccount: string;
  attackerShort: string;
  attackerPrefix: string;
  honest: {
    amountUnits: string;
    amountUsdc: string;
    paid: boolean;
    txHash: string;
  };
  injected: {
    amountUnits: string;
    amountUsdc: string;
    paidByNaive: boolean;
    paidByScrip: boolean;
    rejectionCode: string;
    txHash: string;
  };
  overcharge: {
    amountUnits: string;
    amountUsdc: string;
    paidByScrip: boolean;
    rejectionCode: string;
    txHash: string;
  };
  naiveAttackerGainedUnits: string;
  naiveAttackerGainedUsdc: string;
  scripAttackerGainedUnits: string;
  scripAttackerGainedUsdc: string;
  scripRemainingUnits: string;
  scripRemainingUsdc: string;
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
    throw new Error(`Invalid ${label}.${key}: expected canonical decimal string`);
  }
  return v;
}

function asInt(obj: Record<string, unknown>, key: string, label: string): number {
  const v = obj[key];
  if (typeof v !== "number" || !Number.isSafeInteger(v) || v < 0) {
    throw new Error(`Invalid ${label}.${key}: expected non-negative integer`);
  }
  return v;
}

function asBool(obj: Record<string, unknown>, key: string, label: string): boolean {
  const v = obj[key];
  if (typeof v !== "boolean") {
    throw new Error(`Invalid ${label}.${key}: expected boolean`);
  }
  return v;
}

export function formatUsdcFixed(
  rawUnits: string | bigint,
  fractionDigits = 2,
): string {
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

export function shortenAccount(accountId: string): string {
  if (accountId.length <= 20) return accountId;
  const parts = accountId.split(".");
  if (parts.length >= 2) {
    return `${parts[0]}…${parts[parts.length - 1]}`;
  }
  return `${accountId.slice(0, 8)}…${accountId.slice(-6)}`;
}

function mapRaceCase(
  rawCase: unknown,
  expectedContract: "naive" | "scrip",
): RaceContractCase {
  const c = asObject(rawCase, `attack.json case(${expectedContract})`);
  const contract = asString(c, "contract", "attack.json case");
  if (contract !== expectedContract) {
    throw new Error(
      `Invalid attack.json case: expected "${expectedContract}", got "${contract}"`,
    );
  }
  const broadcast = asObject(c.broadcast, `attack.json ${expectedContract}.broadcast`);
  const burstMs = asInt(broadcast, "burstMs", `attack.json ${expectedContract}.broadcast`);
  const spentUnits = asAmountString(c, "spent", `attack.json ${expectedContract}`);
  const overBudgetUnits = asAmountString(
    c,
    "overBudgetBy",
    `attack.json ${expectedContract}`,
  );
  const paymentsPaidStr = asAmountString(
    c,
    "paymentsPaid",
    `attack.json ${expectedContract}`,
  );

  return {
    contract: expectedContract,
    attempts: asInt(broadcast, "n", `attack.json ${expectedContract}.broadcast`),
    acceptedByRpc: asInt(
      broadcast,
      "accepted",
      `attack.json ${expectedContract}.broadcast`,
    ),
    burstMs,
    burstSeconds: (burstMs / 1000).toFixed(1),
    paymentsPaid: Number(paymentsPaidStr),
    spentUnits,
    spentUsdc: formatUsdcFixed(spentUnits),
    overBudgetUnits,
    overBudgetUsdc: formatUsdcFixed(overBudgetUnits),
    exceededBudget: asBool(c, "exceededBudget", `attack.json ${expectedContract}`),
  };
}

export function mapAttackData(raw: unknown): LandingRaceData {
  if (!Array.isArray(raw) || raw.length === 0) {
    throw new Error("Invalid attack.json: expected non-empty array of runs");
  }
  const run = asObject(raw[0], "attack.json[0]");
  const params = asObject(run.params, "attack.json[0].params");
  const cases = run.cases;
  if (!Array.isArray(cases)) {
    throw new Error("Invalid attack.json[0].cases: expected array");
  }

  const naiveRaw = cases.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).contract === "naive",
  );
  const scripRaw = cases.find(
    (item) =>
      typeof item === "object" &&
      item !== null &&
      (item as Record<string, unknown>).contract === "scrip",
  );
  if (!naiveRaw || !scripRaw) {
    throw new Error("Invalid attack.json: missing naive or scrip case");
  }

  const paymentUnits = asAmountString(params, "amount", "attack.json params");
  const budgetUnits = asAmountString(params, "budget", "attack.json params");
  const fundedUnits = asAmountString(params, "funded", "attack.json params");

  return {
    network: asString(run, "network", "attack.json"),
    startedAt: asString(run, "startedAt", "attack.json"),
    finishedAt: asString(run, "finishedAt", "attack.json"),
    totalAttempts: asInt(params, "N", "attack.json params"),
    paceMs: asInt(params, "PACE_MS", "attack.json params"),
    paymentUnits,
    paymentUsdc: formatUsdcFixed(paymentUnits),
    budgetUnits,
    budgetUsdc: formatUsdcFixed(budgetUnits),
    fundedUnits,
    fundedUsdc: formatUsdcFixed(fundedUnits),
    naive: mapRaceCase(naiveRaw, "naive"),
    scrip: mapRaceCase(scripRaw, "scrip"),
  };
}

function findInvoice(
  invoices: unknown,
  mode: string,
  label: string,
): Record<string, unknown> {
  if (!Array.isArray(invoices)) {
    throw new Error(`Invalid ${label}: expected invoices array`);
  }
  const found = invoices.find(
    (inv) =>
      typeof inv === "object" &&
      inv !== null &&
      (inv as Record<string, unknown>).mode === mode,
  );
  if (!found) {
    throw new Error(`Invalid ${label}: missing "${mode}" invoice`);
  }
  return asObject(found, `${label}.${mode}`);
}

export function mapDemoData(raw: unknown): LandingHeroDemoData {
  const root = asObject(raw, "demo.json");
  const agents = asObject(root.agents, "demo.json.agents");
  const naive = asObject(agents.naive, "demo.json.agents.naive");
  const scrip = asObject(agents.scrip, "demo.json.agents.scrip");
  const mandateFinal = asObject(root.mandateFinal, "demo.json.mandateFinal");

  const scripHonest = findInvoice(
    scrip.invoices,
    "honest",
    "demo.json.agents.scrip.invoices",
  );
  const scripInjected = findInvoice(
    scrip.invoices,
    "injected",
    "demo.json.agents.scrip.invoices",
  );
  const scripOvercharge = findInvoice(
    scrip.invoices,
    "overcharge",
    "demo.json.agents.scrip.invoices",
  );
  const naiveInjected = findInvoice(
    naive.invoices,
    "injected",
    "demo.json.agents.naive.invoices",
  );

  const fundedUnits = asAmountString(
    mandateFinal,
    "deposited",
    "demo.json.mandateFinal",
  );
  const merchantAccount = asString(
    scripHonest,
    "payTo",
    "demo.json.scrip.honest",
  );
  const attackerAccount = asString(
    scripInjected,
    "payTo",
    "demo.json.scrip.injected",
  );
  const honestUnits = asAmountString(
    scripHonest,
    "amount",
    "demo.json.scrip.honest",
  );
  const injectedUnits = asAmountString(
    scripInjected,
    "amount",
    "demo.json.scrip.injected",
  );
  const overchargeUnits = asAmountString(
    scripOvercharge,
    "amount",
    "demo.json.scrip.overcharge",
  );
  const naiveGainedUnits = asAmountString(
    naive,
    "attackerGained",
    "demo.json.agents.naive",
  );
  const scripGainedUnits = asAmountString(
    scrip,
    "attackerGained",
    "demo.json.agents.scrip",
  );
  const scripRemainingUnits = asAmountString(
    scrip,
    "after",
    "demo.json.agents.scrip",
  );

  return {
    network: asString(root, "network", "demo.json"),
    startedAt: asString(root, "startedAt", "demo.json"),
    note: asString(root, "note", "demo.json"),
    fundedUnits,
    fundedUsdc: formatUsdcFixed(fundedUnits),
    merchantAccount,
    merchantShort: shortenAccount(merchantAccount),
    attackerAccount,
    attackerShort: shortenAccount(attackerAccount),
    attackerPrefix: attackerAccount.split(".")[0] ?? attackerAccount,
    honest: {
      amountUnits: honestUnits,
      amountUsdc: formatUsdcFixed(honestUnits),
      paid: asBool(scripHonest, "paid", "demo.json.scrip.honest"),
      txHash: asString(scripHonest, "txHash", "demo.json.scrip.honest"),
    },
    injected: {
      amountUnits: injectedUnits,
      amountUsdc: formatUsdcFixed(injectedUnits),
      paidByNaive: asBool(naiveInjected, "paid", "demo.json.naive.injected"),
      paidByScrip: asBool(scripInjected, "paid", "demo.json.scrip.injected"),
      rejectionCode: asString(
        scripInjected,
        "rejectionCode",
        "demo.json.scrip.injected",
      ),
      txHash: asString(scripInjected, "txHash", "demo.json.scrip.injected"),
    },
    overcharge: {
      amountUnits: overchargeUnits,
      amountUsdc: formatUsdcFixed(overchargeUnits),
      paidByScrip: asBool(
        scripOvercharge,
        "paid",
        "demo.json.scrip.overcharge",
      ),
      rejectionCode: asString(
        scripOvercharge,
        "rejectionCode",
        "demo.json.scrip.overcharge",
      ),
      txHash: asString(
        scripOvercharge,
        "txHash",
        "demo.json.scrip.overcharge",
      ),
    },
    naiveAttackerGainedUnits: naiveGainedUnits,
    naiveAttackerGainedUsdc: formatUsdcFixed(naiveGainedUnits),
    scripAttackerGainedUnits: scripGainedUnits,
    scripAttackerGainedUsdc: formatUsdcFixed(scripGainedUnits),
    scripRemainingUnits,
    scripRemainingUsdc: formatUsdcFixed(scripRemainingUnits),
  };
}

export const RACE_DATA: LandingRaceData = mapAttackData(attackJson);
export const HERO_DEMO_DATA: LandingHeroDemoData = mapDemoData(demoJson);
