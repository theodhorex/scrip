// Pure state, dial math, and animation-sequence helper for the Rule Machine diorama.
// Calls `evaluate()` from `./rules` and reads real testnet accounts from `./landing-data`.
// Uses only erasable TypeScript syntax so `node --test` executes it natively.
import type { RejectCode, RuleEvaluation, RuleMandate } from "./rules";
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { evaluate } from "./rules.ts";
// @ts-expect-error Node strip-types ESM loader requires .ts extension
import { HERO_DEMO_DATA, formatUsdcFixed, shortenAccount } from "./landing-data.ts";

export const MANDATE_BUDGET_UNITS = "1000000"; // 1.00 USDC
export const MANDATE_CAP_UNITS = "500000"; // 0.50 USDC
export const MANDATE_BUDGET_USDC = formatUsdcFixed(MANDATE_BUDGET_UNITS);
export const MANDATE_CAP_USDC = formatUsdcFixed(MANDATE_CAP_UNITS);

export const MERCHANT_ACCOUNT: string = HERO_DEMO_DATA.merchantAccount;
export const MERCHANT_SHORT: string = HERO_DEMO_DATA.merchantShort;
export const ATTACKER_ACCOUNT: string = HERO_DEMO_DATA.attackerAccount;
export const ATTACKER_SHORT: string = HERO_DEMO_DATA.attackerShort;

export const DIAL_MIN_USDC = 0.05;
export const DIAL_MAX_USDC = 1.2;
export const DIAL_STEP_USDC = 0.05;

const DIAL_MIN_CENTS = 5;
const DIAL_MAX_CENTS = 120;
const DIAL_STEP_CENTS = 5;
const FIXED_NOW_MS = 1_800_000_000_000;
const FIXED_EXPIRES_AT_MS = FIXED_NOW_MS + 86_400_000 * 30;

export const FIXED_RULE_MANDATE: RuleMandate = {
  id: 1,
  status: "Active",
  expiresAtMs: FIXED_EXPIRES_AT_MS,
  recipients: [MERCHANT_ACCOUNT],
  perPaymentCap: MANDATE_CAP_UNITS,
  budget: MANDATE_BUDGET_UNITS,
  approvalThreshold: MANDATE_CAP_UNITS,
};

export type GateStatus = "idle" | "pass" | "reject";

export type PacketStage =
  | "idle"
  | "spawn"
  | "gate-0"
  | "gate-1"
  | "gate-2"
  | "merchant"
  | "rejected";

export type AnimationFrame = {
  stage: PacketStage;
  gates: [GateStatus, GateStatus, GateStatus];
  leverDown: boolean;
  sparkGate: 0 | 1 | 2 | null;
  activeCode: RejectCode | null;
  durationMs: number;
};

export type AttemptHistoryItem = {
  id: number;
  recipient: string;
  recipientShort: string;
  amountUsdc: string;
  result: RuleEvaluation;
  remainingUsdc: string;
};

export type RuleMachineState = {
  spentUnits: string;
  spentUsdc: string;
  remainingUnits: string;
  remainingUsdc: string;
  remainingRatio: number;
  nonce: number;
  gateStates: [GateStatus, GateStatus, GateStatus];
  activeCode: RejectCode | null;
  packetStage: PacketStage;
  packetTone: "pass" | "reject";
  packetLabel: string;
  lastMessage: string;
  history: AttemptHistoryItem[];
};

function clampCents(cents: number): number {
  const snapped = Math.round(cents / DIAL_STEP_CENTS) * DIAL_STEP_CENTS;
  return Math.max(DIAL_MIN_CENTS, Math.min(DIAL_MAX_CENTS, snapped));
}

export function stepDialUsdc(currentUsdc: number, deltaSteps: number): number {
  const currentCents = Math.round(currentUsdc * 100);
  const nextCents = clampCents(currentCents + deltaSteps * DIAL_STEP_CENTS);
  return nextCents / 100;
}

export function usdcToRawUnits(amountUsdc: number): string {
  const cents = clampCents(Math.round(amountUsdc * 100));
  return (BigInt(cents) * BigInt(10_000)).toString();
}

export function rawUnitsToDialUsdc(rawUnits: string): number {
  const cents = Number(BigInt(rawUnits) / BigInt(10_000));
  return clampCents(cents) / 100;
}

export function dialAngleDeg(amountUsdc: number): number {
  const cents = clampCents(Math.round(amountUsdc * 100));
  const ratio = (cents - DIAL_MIN_CENTS) / (DIAL_MAX_CENTS - DIAL_MIN_CENTS);
  return Math.round((-135 + ratio * 270) * 100) / 100;
}

export function deriveGateStates(
  evaluation: RuleEvaluation,
): [GateStatus, GateStatus, GateStatus] {
  if (evaluation.ok) {
    return ["pass", "pass", "pass"];
  }
  if (evaluation.code === "OVER_PER_PAYMENT_CAP") {
    return ["pass", "reject", "idle"];
  }
  if (evaluation.code === "OVER_BUDGET") {
    return ["pass", "pass", "reject"];
  }
  return ["reject", "idle", "idle"];
}

export function deriveAnimationFrames(evaluation: RuleEvaluation): AnimationFrame[] {
  const spawnFrame: AnimationFrame = {
    stage: "spawn",
    gates: ["idle", "idle", "idle"],
    leverDown: true,
    sparkGate: null,
    activeCode: null,
    durationMs: 240,
  };

  if (evaluation.ok) {
    return [
      spawnFrame,
      {
        stage: "gate-0",
        gates: ["pass", "idle", "idle"],
        leverDown: true,
        sparkGate: null,
        activeCode: null,
        durationMs: 280,
      },
      {
        stage: "gate-1",
        gates: ["pass", "pass", "idle"],
        leverDown: false,
        sparkGate: null,
        activeCode: null,
        durationMs: 280,
      },
      {
        stage: "gate-2",
        gates: ["pass", "pass", "pass"],
        leverDown: false,
        sparkGate: null,
        activeCode: null,
        durationMs: 280,
      },
      {
        stage: "merchant",
        gates: ["pass", "pass", "pass"],
        leverDown: false,
        sparkGate: null,
        activeCode: null,
        durationMs: 0,
      },
    ];
  }

  const code = evaluation.code;
  if (code === "OVER_PER_PAYMENT_CAP") {
    return [
      spawnFrame,
      {
        stage: "gate-0",
        gates: ["pass", "idle", "idle"],
        leverDown: false,
        sparkGate: null,
        activeCode: null,
        durationMs: 280,
      },
      {
        stage: "gate-1",
        gates: ["pass", "reject", "idle"],
        leverDown: false,
        sparkGate: 1,
        activeCode: code,
        durationMs: 360,
      },
      {
        stage: "rejected",
        gates: ["pass", "reject", "idle"],
        leverDown: false,
        sparkGate: null,
        activeCode: code,
        durationMs: 0,
      },
    ];
  }

  if (code === "OVER_BUDGET") {
    return [
      spawnFrame,
      {
        stage: "gate-0",
        gates: ["pass", "idle", "idle"],
        leverDown: false,
        sparkGate: null,
        activeCode: null,
        durationMs: 260,
      },
      {
        stage: "gate-1",
        gates: ["pass", "pass", "idle"],
        leverDown: false,
        sparkGate: null,
        activeCode: null,
        durationMs: 260,
      },
      {
        stage: "gate-2",
        gates: ["pass", "pass", "reject"],
        leverDown: false,
        sparkGate: 2,
        activeCode: code,
        durationMs: 360,
      },
      {
        stage: "rejected",
        gates: ["pass", "pass", "reject"],
        leverDown: false,
        sparkGate: null,
        activeCode: code,
        durationMs: 0,
      },
    ];
  }

  return [
    spawnFrame,
    {
      stage: "gate-0",
      gates: ["reject", "idle", "idle"],
      leverDown: false,
      sparkGate: 0,
      activeCode: code,
      durationMs: 360,
    },
    {
      stage: "rejected",
      gates: ["reject", "idle", "idle"],
      leverDown: false,
      sparkGate: null,
      activeCode: code,
      durationMs: 0,
    },
  ];
}

export function createInitialMachineState(): RuleMachineState {
  return {
    spentUnits: "0",
    spentUsdc: formatUsdcFixed("0"),
    remainingUnits: MANDATE_BUDGET_UNITS,
    remainingUsdc: MANDATE_BUDGET_USDC,
    remainingRatio: 1,
    nonce: 1,
    gateStates: ["idle", "idle", "idle"],
    activeCode: null,
    packetStage: "idle",
    packetTone: "pass",
    packetLabel: "",
    lastMessage: `Ready: select Merchant (${MERCHANT_SHORT}) or Attacker (${ATTACKER_SHORT}), turn the brass dial, and pull the lever.`,
    history: [],
  };
}

export function applyLeverPull(
  prev: RuleMachineState,
  input: { recipient: string; amountUsdc: number },
): {
  evaluation: RuleEvaluation;
  frames: AnimationFrame[];
  nextState: RuleMachineState;
} {
  const rawUnits = usdcToRawUnits(input.amountUsdc);
  const amountFormatted = formatUsdcFixed(rawUnits);
  const recipientShort = shortenAccount(input.recipient);

  const evaluation = evaluate(
    FIXED_RULE_MANDATE,
    {
      deposited: MANDATE_BUDGET_UNITS,
      spent: prev.spentUnits,
      reserved: "0",
      openRequests: 0,
      nowMs: FIXED_NOW_MS,
      approvals: [],
    },
    {
      recipient: input.recipient,
      amount: rawUnits,
      nonce: prev.nonce,
    },
  );

  const budgetBig = BigInt(MANDATE_BUDGET_UNITS);
  const prevSpentBig = BigInt(prev.spentUnits);
  const nextSpentBig = evaluation.ok ? prevSpentBig + BigInt(rawUnits) : prevSpentBig;
  const remainingBig = budgetBig > nextSpentBig ? budgetBig - nextSpentBig : BigInt(0);

  const spentUnits = nextSpentBig.toString();
  const remainingUnits = remainingBig.toString();
  const spentUsdc = formatUsdcFixed(spentUnits);
  const remainingUsdc = formatUsdcFixed(remainingUnits);
  const remainingRatio = Number(remainingBig) / Number(budgetBig);

  const frames = deriveAnimationFrames(evaluation);
  const finalFrame = frames[frames.length - 1];

  const lastMessage = evaluation.ok
    ? `Nonce #${prev.nonce}: ${amountFormatted} USDC to ${recipientShort} cleared all three gates. Remaining budget: ${remainingUsdc} USDC.`
    : `Nonce #${prev.nonce}: ${amountFormatted} USDC to ${recipientShort} rejected with ${evaluation.code}. Remaining budget: ${remainingUsdc} USDC.`;

  const historyItem: AttemptHistoryItem = {
    id: prev.nonce,
    recipient: input.recipient,
    recipientShort,
    amountUsdc: amountFormatted,
    result: evaluation,
    remainingUsdc,
  };

  return {
    evaluation,
    frames,
    nextState: {
      spentUnits,
      spentUsdc,
      remainingUnits,
      remainingUsdc,
      remainingRatio,
      nonce: prev.nonce + 1,
      gateStates: finalFrame.gates,
      activeCode: finalFrame.activeCode,
      packetStage: finalFrame.stage,
      packetTone: evaluation.ok ? "pass" : "reject",
      packetLabel: `${amountFormatted} USDC`,
      lastMessage,
      history: [historyItem, ...prev.history.slice(0, 4)],
    },
  };
}

export const AUTO_DEMO_HONEST_USDC: number = rawUnitsToDialUsdc(
  HERO_DEMO_DATA.honest.amountUnits,
);
export const AUTO_DEMO_ATTACK_USDC: number = rawUnitsToDialUsdc(
  HERO_DEMO_DATA.injected.amountUnits,
);

export function computeAutoDemoSequence() {
  const initial = createInitialMachineState();
  const step1 = applyLeverPull(initial, {
    recipient: MERCHANT_ACCOUNT,
    amountUsdc: AUTO_DEMO_HONEST_USDC,
  });
  const step2 = applyLeverPull(step1.nextState, {
    recipient: ATTACKER_ACCOUNT,
    amountUsdc: AUTO_DEMO_ATTACK_USDC,
  });
  return { initial, step1, step2 };
}
