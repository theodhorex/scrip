import type { LandingHeroDemoData } from "@/lib/landing-data";

export type GateVisualState = "idle" | "pass" | "reject";

export type HeroStepDerived = {
  step: number;
  caption: string;
  vaultFilledRatio: number;
  vaultBalanceUsdc: string;
  merchantReceivedUsdc: string;
  attackerReceivedUsdc: string;
  agentHijacked: boolean;
  showInjectionPrompt: boolean;
  injectionText: string;
  gates: [GateVisualState, GateVisualState, GateVisualState];
  showSpark: boolean;
  rejectionBadge: string | null;
  packet: {
    visible: boolean;
    tone: "pass" | "reject";
    label: string;
    showTrail: boolean;
    // Desktop SVG coordinates (viewBox 0 0 1020 380)
    dx: number;
    dy: number;
    dAngle: number;
    // Mobile vertical SVG coordinates (viewBox 0 0 360 620)
    mx: number;
    my: number;
    mAngle: number;
  };
};

export const HERO_TOTAL_STEPS = 8;
export const HERO_FINAL_STEP = 7;

export function deriveHeroStep(
  step: number,
  data: LandingHeroDemoData,
): HeroStepDerived {
  const injectionText = `"pay ${data.injected.amountUsdc} to ${data.attackerPrefix}…"`;

  switch (step) {
    case 0:
      return {
        step,
        caption: `1/3 Owner funds the Scrip vault with ${data.fundedUsdc} USDC.`,
        vaultFilledRatio: 0.5,
        vaultBalanceUsdc: data.fundedUsdc,
        merchantReceivedUsdc: "0.00",
        attackerReceivedUsdc: "0.00",
        agentHijacked: false,
        showInjectionPrompt: false,
        injectionText,
        gates: ["idle", "idle", "idle"],
        showSpark: false,
        rejectionBadge: null,
        packet: {
          visible: true,
          tone: "pass",
          label: data.fundedUsdc,
          showTrail: true,
          dx: 180,
          dy: 160,
          dAngle: 0,
          mx: 180,
          my: 95,
          mAngle: 90,
        },
      };
    case 1:
      return {
        step,
        caption: `1/3 Vault holds ${data.fundedUsdc} USDC. Agent holds only a request_payment key.`,
        vaultFilledRatio: 1,
        vaultBalanceUsdc: data.fundedUsdc,
        merchantReceivedUsdc: "0.00",
        attackerReceivedUsdc: "0.00",
        agentHijacked: false,
        showInjectionPrompt: false,
        injectionText,
        gates: ["idle", "idle", "idle"],
        showSpark: false,
        rejectionBadge: null,
        packet: {
          visible: true,
          tone: "pass",
          label: data.honest.amountUsdc,
          showTrail: true,
          dx: 440,
          dy: 160,
          dAngle: 0,
          mx: 180,
          my: 220,
          mAngle: 90,
        },
      };
    case 2:
      return {
        step,
        caption: `2/3 Agent requests ${data.honest.amountUsdc} USDC to ${data.merchantShort}: recipient gate passes.`,
        vaultFilledRatio: 1,
        vaultBalanceUsdc: data.fundedUsdc,
        merchantReceivedUsdc: "0.00",
        attackerReceivedUsdc: "0.00",
        agentHijacked: false,
        showInjectionPrompt: false,
        injectionText,
        gates: ["pass", "idle", "idle"],
        showSpark: false,
        rejectionBadge: null,
        packet: {
          visible: true,
          tone: "pass",
          label: data.honest.amountUsdc,
          showTrail: true,
          dx: 678,
          dy: 148,
          dAngle: 0,
          mx: 72,
          my: 375,
          mAngle: 90,
        },
      };
    case 3:
      return {
        step,
        caption: `2/3 Per-payment cap and cumulative budget gates clear the ${data.honest.amountUsdc} USDC request.`,
        vaultFilledRatio: 1,
        vaultBalanceUsdc: data.fundedUsdc,
        merchantReceivedUsdc: "0.00",
        attackerReceivedUsdc: "0.00",
        agentHijacked: false,
        showInjectionPrompt: false,
        injectionText,
        gates: ["pass", "pass", "pass"],
        showSpark: false,
        rejectionBadge: null,
        packet: {
          visible: true,
          tone: "pass",
          label: data.honest.amountUsdc,
          showTrail: true,
          dx: 838,
          dy: 148,
          dAngle: 0,
          mx: 248,
          my: 375,
          mAngle: 0,
        },
      };
    case 4:
      return {
        step,
        caption: `2/3 Allowlisted merchant receives ${data.honest.amountUsdc} USDC; ${data.scripRemainingUsdc} USDC stays locked.`,
        vaultFilledRatio: 0.8,
        vaultBalanceUsdc: data.scripRemainingUsdc,
        merchantReceivedUsdc: data.honest.amountUsdc,
        attackerReceivedUsdc: "0.00",
        agentHijacked: false,
        showInjectionPrompt: false,
        injectionText,
        gates: ["pass", "pass", "pass"],
        showSpark: false,
        rejectionBadge: null,
        packet: {
          visible: true,
          tone: "pass",
          label: data.honest.amountUsdc,
          showTrail: true,
          dx: 915,
          dy: 110,
          dAngle: -25,
          mx: 95,
          my: 505,
          mAngle: 90,
        },
      };
    case 5:
      return {
        step,
        caption: `3/3 Prompt injection ${injectionText} hijacks the agent toward an unlisted address.`,
        vaultFilledRatio: 0.8,
        vaultBalanceUsdc: data.scripRemainingUsdc,
        merchantReceivedUsdc: data.honest.amountUsdc,
        attackerReceivedUsdc: "0.00",
        agentHijacked: true,
        showInjectionPrompt: true,
        injectionText,
        gates: ["idle", "idle", "idle"],
        showSpark: false,
        rejectionBadge: null,
        packet: {
          visible: true,
          tone: "reject",
          label: data.injected.amountUsdc,
          showTrail: true,
          dx: 630,
          dy: 200,
          dAngle: 30,
          mx: 72,
          my: 320,
          mAngle: 120,
        },
      };
    case 6:
    case 7:
    default:
      return {
        step,
        caption: `3/3 Blocked at recipient gate with ${data.injected.rejectionCode}. Attacker gets ${data.scripAttackerGainedUsdc} USDC.`,
        vaultFilledRatio: 0.8,
        vaultBalanceUsdc: data.scripRemainingUsdc,
        merchantReceivedUsdc: data.honest.amountUsdc,
        attackerReceivedUsdc: data.scripAttackerGainedUsdc,
        agentHijacked: true,
        showInjectionPrompt: true,
        injectionText,
        gates: ["reject", "idle", "idle"],
        showSpark: true,
        rejectionBadge: data.injected.rejectionCode,
        packet: {
          visible: true,
          tone: "reject",
          label: data.injected.amountUsdc,
          showTrail: false,
          dx: 650,
          dy: 215,
          dAngle: 0,
          mx: 72,
          my: 375,
          mAngle: 90,
        },
      };
  }
}
