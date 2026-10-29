"use client";

import { memo, type KeyboardEvent, type MouseEvent } from "react";
import {
  IsoBox,
  IsoCylinder,
  IsoGround,
  IsoLine,
  IsoShadow,
  isoProject,
  tone,
  type Pt,
} from "./Iso";
import {
  MANDATE_BUDGET_USDC,
  MERCHANT_ACCOUNT,
  MERCHANT_SHORT,
  ATTACKER_ACCOUNT,
  ATTACKER_SHORT,
  dialAngleDeg,
  type GateStatus,
  type PacketStage,
} from "@/lib/rule-machine";
import type { RejectCode } from "@/lib/rules";
import styles from "./RuleMachineScene.module.css";

export type RuleMachineSceneProps = {
  recipient: string;
  amountUsdc: number;
  nonce: number;
  spentUsdc: string;
  remainingUsdc: string;
  remainingRatio: number;
  gateStates: [GateStatus, GateStatus, GateStatus];
  activeCode: RejectCode | null;
  packetStage: PacketStage;
  packetTone: "pass" | "reject";
  packetLabel: string;
  leverDown: boolean;
  sparkGate: 0 | 1 | 2 | null;
  isRunning: boolean;
  reducedMotion?: boolean;
  onSelectRecipient: (recipient: string) => void;
  onStepDial: (deltaSteps: number) => void;
  onPullLever: () => void;
  onReset: () => void;
};

// Design tokens per DESIGN_V2.md
const STEEL = "#8fa3c4";
const VAULT = "#1f4fd8";
const NAVY = "#0c1527";
const NAVY_RAISED = "#14223d";
const PAPER = "#e8eef7";
const BRASS = "#c9a24a";
const PASS = "var(--bp-pass)";
const REJECT = "var(--bp-reject)";

function activateOnKey(cb: () => void) {
  return (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      cb();
    }
  };
}

function RivetRow({
  ptsList,
  r = 1.4,
  fill = BRASS,
}: {
  ptsList: Pt[];
  r?: number;
  fill?: string;
}) {
  return (
    <g aria-hidden="true">
      {ptsList.map((pt, idx) => {
        const [cx, cy] = isoProject(pt);
        return <circle key={idx} cx={cx} cy={cy} r={r} fill={fill} opacity={0.88} />;
      })}
    </g>
  );
}

function IsoText({
  x,
  y,
  z = 0,
  text,
  size = 11,
  fill = "var(--bp-muted)",
  anchor = "middle",
  weight = 500,
  alongX = false,
}: {
  x: number;
  y: number;
  z?: number;
  text: string;
  size?: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  weight?: number;
  /** Skew the baseline to follow the isometric x axis (30 degrees) so text sits flat on a wall. */
  alongX?: boolean;
}) {
  const [sx, sy] = isoProject([x, y, z]);
  return (
    <text
      x={alongX ? 0 : sx}
      y={alongX ? 0 : sy}
      transform={alongX ? `translate(${sx.toFixed(1)} ${sy.toFixed(1)}) skewY(30)` : undefined}
      textAnchor={anchor}
      fontFamily="var(--font-geist-mono), ui-monospace, monospace"
      fontSize={size}
      fontWeight={weight}
      fill={fill}
      letterSpacing="0.04em"
      style={{ pointerEvents: "none", userSelect: "none" }}
    >
      {text}
    </text>
  );
}

function getPacketCoordinates(stage: PacketStage): Pt {
  switch (stage) {
    case "idle":
      return [72, 148, 26];
    case "spawn":
      return [108, 148, 20];
    case "gate-0":
      return [175, 148, 20];
    case "gate-1":
      return [255, 148, 20];
    case "gate-2":
      return [335, 148, 20];
    case "merchant":
      return [432, 148, 28];
    case "rejected":
      return [285, 232, 12];
  }
}

function gateLampColor(status: GateStatus): string {
  if (status === "pass") return PASS;
  if (status === "reject") return REJECT;
  return "#eab308"; // warm idle amber
}

export const RuleMachineScene = memo(function RuleMachineScene({
  recipient,
  amountUsdc,
  nonce,
  spentUsdc,
  remainingUsdc,
  remainingRatio,
  gateStates,
  activeCode,
  packetStage,
  packetTone,
  packetLabel,
  leverDown,
  sparkGate,
  isRunning,
  reducedMotion = false,
  onSelectRecipient,
  onStepDial,
  onPullLever,
  onReset,
}: RuleMachineSceneProps) {
  // Lever coordinates
  const leverBasePt: Pt = [78, 118, 59];
  const [leverBaseSx, leverBaseSy] = isoProject(leverBasePt);
  const leverHandleOffset = leverDown ? 14 : 0;
  const [leverTipSx, leverTipSy] = isoProject([78, 118, 86 - leverHandleOffset]);

  // Dial knob coordinates on machine top
  const dialPt: Pt = [54, 138, 59];
  const [dialSx, dialSy] = isoProject(dialPt);
  const dialAngle = dialAngleDeg(amountUsdc);
  const rad = (dialAngle * Math.PI) / 180;
  const needleLen = 10;
  const needleTipSx = dialSx + Math.sin(rad) * needleLen;
  const needleTipSy = dialSy - Math.cos(rad) * (needleLen * 0.7);

  // Focus ring coordinates
  const [resetFocusSx, resetFocusSy] = isoProject([45, 120, 59]);
  const [merchantFocusSx, merchantFocusSy] = isoProject([442, 148, 0]);
  const [attackerFocusSx, attackerFocusSy] = isoProject([146, 258, 0]);

  // Traveling packet
  const packetPt = getPacketCoordinates(packetStage);
  const [packetSx, packetSy] = isoProject(packetPt);
  const isPacketVisible = packetStage !== "idle";

  const handleDialClick = (e: MouseEvent) => {
    if (e.shiftKey) {
      onStepDial(-1);
    } else {
      onStepDial(1);
    }
  };

  const handleDialKeyDown = (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "ArrowUp" || e.key === "ArrowRight") {
      e.preventDefault();
      onStepDial(1);
    } else if (e.key === "ArrowDown" || e.key === "ArrowLeft") {
      e.preventDefault();
      onStepDial(-1);
    } else if (e.key === "PageUp") {
      e.preventDefault();
      onStepDial(4);
    } else if (e.key === "PageDown") {
      e.preventDefault();
      onStepDial(-4);
    } else if (e.key === "Home") {
      e.preventDefault();
      onStepDial(-24);
    } else if (e.key === "End") {
      e.preventDefault();
      onStepDial(24);
    }
  };

  // Spark coordinate
  const sparkX = sparkGate === 0 ? 175 : sparkGate === 1 ? 255 : sparkGate === 2 ? 335 : 0;
  const [sparkSx, sparkSy] = isoProject([sparkX, 148, 30]);

  return (
    <svg
      viewBox="20 80 740 440"
      className="w-full h-auto block select-none overflow-visible"
      aria-label="Isometric diorama of the gatekeeper rule machine with conveyor belt, lever, dial knob, three gate pillars, and destination targets"
      role="group"
    >
      <defs>
        {/* Gradients for lighting & glow */}
        <radialGradient id="lamp-pass-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--bp-pass)" stopOpacity="0.85" />
          <stop offset="60%" stopColor="var(--bp-pass)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--bp-pass)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lamp-reject-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--bp-reject)" stopOpacity="0.85" />
          <stop offset="60%" stopColor="var(--bp-reject)" stopOpacity="0.3" />
          <stop offset="100%" stopColor="var(--bp-reject)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="lamp-idle-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="#eab308" stopOpacity="0.7" />
          <stop offset="70%" stopColor="#eab308" stopOpacity="0.15" />
          <stop offset="100%" stopColor="#eab308" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="beacon-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--bp-pass)" stopOpacity="0.9" />
          <stop offset="50%" stopColor="var(--bp-pass)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--bp-pass)" stopOpacity="0" />
        </radialGradient>
        <radialGradient id="attacker-beacon-glow" cx="50%" cy="50%" r="50%">
          <stop offset="0%" stopColor="var(--bp-reject)" stopOpacity="0.9" />
          <stop offset="50%" stopColor="var(--bp-reject)" stopOpacity="0.35" />
          <stop offset="100%" stopColor="var(--bp-reject)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g transform="translate(345, 95)">
        {/* ============================================================== */}
        {/* 1. GROUND PLATE & CONTACT SHADOWS                              */}
        {/* ============================================================== */}
        <IsoGround w={480} d={320} color={NAVY} cell={40} />

        {/* Contact shadows under physical elements */}
        <IsoShadow x={35} y={110} w={65} d={75} />
        <IsoShadow x={95} y={135} w={325} d={30} />
        <IsoShadow x={168} y={118} w={20} d={16} />
        <IsoShadow x={248} y={118} w={20} d={16} />
        <IsoShadow x={328} y={118} w={20} d={16} />
        <IsoShadow x={415} y={130} w={52} d={44} />
        <IsoShadow x={125} y={240} w={48} d={40} />
        <IsoShadow x={260} y={210} w={55} d={42} />

        {/* Floor perimeter brass rivets */}
        <RivetRow
          ptsList={[
            [10, 10, 0],
            [120, 10, 0],
            [240, 10, 0],
            [360, 10, 0],
            [470, 10, 0],
            [470, 80, 0],
            [470, 160, 0],
            [470, 240, 0],
            [470, 310, 0],
            [360, 310, 0],
            [240, 310, 0],
            [120, 310, 0],
            [10, 310, 0],
            [10, 240, 0],
            [10, 160, 0],
            [10, 80, 0],
          ]}
          r={1.6}
        />

        {/* ============================================================== */}
        {/* 2. THE VAULT (BACKGROUND BUDGET LEDGER)                         */}
        {/* ============================================================== */}
        <g transform="translate(58,-34)">
        {/* Vault Main Housing */}
        <IsoBox x={180} y={30} z={0} w={150} d={45} h={70} color={NAVY_RAISED} edge={STEEL} />
        {/* Vault Chamfered Header */}
        <IsoBox x={184} y={33} z={70} w={142} d={39} h={6} color={VAULT} edge={PAPER} />
        {/* Floor captions in front of the vault (kept off the bar so nothing overlaps) */}
        <IsoText x={255} y={52} z={77} text="RESERVE VAULT #1" size={8} fill={PAPER} weight={700} alongX />
        <IsoText x={326} y={106} z={0} text={`SPENT ${spentUsdc} USDC`} size={8} fill="var(--bp-muted)" weight={600} />

        {/* Vault Budget Progress Meter on Front Wall */}
        <IsoBox x={192} y={75} z={24} w={126} d={2} h={22} color="#080e1b" edge={STEEL} />
        {/* Shrinking Budget Liquid/Bar */}
        {remainingRatio > 0 && (
          <IsoBox
            x={194}
            y={76}
            z={26}
            w={Math.max(4, Math.round(122 * Math.min(1, remainingRatio)))}
            d={1}
            h={18}
            color={tone(PASS).top}
            edge={PASS}
          />
        )}
        <IsoText
          x={251}
          y={76}
          z={31}
          text={`${remainingUsdc} / ${MANDATE_BUDGET_USDC}`}
          size={8}
          fill={PAPER}
          weight={700}
          alongX
        />

        {/* Vault Rivets & Lock Dial */}
        <IsoCylinder x={312} y={76} z={62} r={4} h={2} color={BRASS} />
        <RivetRow
          ptsList={[
            [185, 75, 10],
            [185, 75, 45],
            [325, 75, 10],
            [325, 75, 45],
          ]}
          r={1.5}
        />

        </g>

        {/* ============================================================== */}
        {/* 3. CONVEYOR BELT                                               */}
        {/* ============================================================== */}
        {/* Belt Frame & Legs */}
        <IsoBox x={95} y={135} z={0} w={325} d={30} h={16} color={NAVY_RAISED} edge={STEEL} />
        {/* Dark Moving Belt Surface */}
        <IsoBox x={97} y={137} z={16} w={321} d={26} h={2} color="#152136" edge="#223659" />

        {/* Rotating End Rollers */}
        <IsoCylinder x={96} y={150} z={8} r={7} h={8} color={STEEL} />
        <IsoCylinder x={420} y={150} z={8} r={7} h={8} color={STEEL} />

        {/* Conveyor Tread Lines */}
        {[135, 175, 215, 255, 295, 335, 375, 410].map((tx) => (
          <IsoLine
            key={`tread-${tx}`}
            points={[
              [tx, 137, 18],
              [tx, 163, 18],
            ]}
            stroke="#2b4065"
            strokeWidth={1.2}
            className={isRunning && !reducedMotion ? styles.beltActive : undefined}
          />
        ))}

        {/* Diverter chute from conveyor to Rejected Bin at Gate 1 & 2 */}
        <IsoBox x={268} y={165} z={10} w={32} d={50} h={6} color={STEEL} edge={BRASS} />
        <IsoLine
          points={[
            [268, 165, 16],
            [276, 215, 12],
          ]}
          stroke={REJECT}
          strokeWidth={1.8}
        />

        {/* ============================================================== */}
        {/* 4. THREE GATE PILLARS (RECIPIENT, CAP, BUDGET)                 */}
        {/* ============================================================== */}

        {/* GATE 0: Recipient allowlist */}
        <g>
          {/* Base & Column */}
          <IsoBox x={168} y={118} z={0} w={18} d={16} h={62} color={STEEL} edge={NAVY_RAISED} />
          <IsoBox x={166} y={116} z={62} w={22} d={20} h={5} color={NAVY_RAISED} edge={STEEL} />
          {/* Indicator Lamp */}
          <IsoCylinder
            x={177}
            y={126}
            z={67}
            r={5}
            h={8}
            color={gateLampColor(gateStates[0])}
          />
          {/* Lamp glow */}
          {(() => {
            const [lampSx, lampSy] = isoProject([177, 126, 75]);
            const glowId =
              gateStates[0] === "pass"
                ? "lamp-pass-glow"
                : gateStates[0] === "reject"
                  ? "lamp-reject-glow"
                  : "lamp-idle-glow";
            return (
              <circle
                cx={lampSx}
                cy={lampSy}
                r={16}
                fill={`url(#${glowId})`}
                className={styles.lampGlow}
              />
            );
          })()}
          {/* Barrier Arm: pivots up on pass */}
          <g
            className={reducedMotion ? styles.barrierInstant : styles.barrierArm}
            style={{
              transformOrigin: `${isoProject([177, 134, 34])[0]}px ${isoProject([177, 134, 34])[1]}px`,
              transform: gateStates[0] === "pass" ? "rotate(-58deg)" : "rotate(0deg)",
            }}
          >
            <IsoBox x={175} y={134} z={32} w={6} d={32} h={5} color={gateStates[0] === "pass" ? PASS : BRASS} edge={PAPER} />
          </g>
          {/* Monospace Gate Plaque */}
          <IsoBox x={169} y={134} z={42} w={16} d={1} h={14} color={NAVY} edge={BRASS} />
        </g>

        {/* GATE 1: Per-Payment Cap */}
        <g>
          {/* Base & Column */}
          <IsoBox x={248} y={118} z={0} w={18} d={16} h={62} color={STEEL} edge={NAVY_RAISED} />
          <IsoBox x={246} y={116} z={62} w={22} d={20} h={5} color={NAVY_RAISED} edge={STEEL} />
          {/* Indicator Lamp */}
          <IsoCylinder
            x={257}
            y={126}
            z={67}
            r={5}
            h={8}
            color={gateLampColor(gateStates[1])}
          />
          {/* Lamp glow */}
          {(() => {
            const [lampSx, lampSy] = isoProject([257, 126, 75]);
            const glowId =
              gateStates[1] === "pass"
                ? "lamp-pass-glow"
                : gateStates[1] === "reject"
                  ? "lamp-reject-glow"
                  : "lamp-idle-glow";
            return (
              <circle
                cx={lampSx}
                cy={lampSy}
                r={16}
                fill={`url(#${glowId})`}
                className={styles.lampGlow}
              />
            );
          })()}
          {/* Barrier Arm: pivots up on pass */}
          <g
            className={reducedMotion ? styles.barrierInstant : styles.barrierArm}
            style={{
              transformOrigin: `${isoProject([257, 134, 34])[0]}px ${isoProject([257, 134, 34])[1]}px`,
              transform: gateStates[1] === "pass" ? "rotate(-58deg)" : "rotate(0deg)",
            }}
          >
            <IsoBox x={255} y={134} z={32} w={6} d={32} h={5} color={gateStates[1] === "pass" ? PASS : BRASS} edge={PAPER} />
          </g>
          {/* Monospace Gate Plaque */}
          <IsoBox x={249} y={134} z={42} w={16} d={1} h={14} color={NAVY} edge={BRASS} />
        </g>

        {/* GATE 2: Budget */}
        <g>
          {/* Base & Column */}
          <IsoBox x={328} y={118} z={0} w={18} d={16} h={62} color={STEEL} edge={NAVY_RAISED} />
          <IsoBox x={326} y={116} z={62} w={22} d={20} h={5} color={NAVY_RAISED} edge={STEEL} />
          {/* Indicator Lamp */}
          <IsoCylinder
            x={337}
            y={126}
            z={67}
            r={5}
            h={8}
            color={gateLampColor(gateStates[2])}
          />
          {/* Lamp glow */}
          {(() => {
            const [lampSx, lampSy] = isoProject([337, 126, 75]);
            const glowId =
              gateStates[2] === "pass"
                ? "lamp-pass-glow"
                : gateStates[2] === "reject"
                  ? "lamp-reject-glow"
                  : "lamp-idle-glow";
            return (
              <circle
                cx={lampSx}
                cy={lampSy}
                r={16}
                fill={`url(#${glowId})`}
                className={styles.lampGlow}
              />
            );
          })()}
          {/* Barrier Arm: pivots up on pass */}
          <g
            className={reducedMotion ? styles.barrierInstant : styles.barrierArm}
            style={{
              transformOrigin: `${isoProject([337, 134, 34])[0]}px ${isoProject([337, 134, 34])[1]}px`,
              transform: gateStates[2] === "pass" ? "rotate(-58deg)" : "rotate(0deg)",
            }}
          >
            <IsoBox x={335} y={134} z={32} w={6} d={32} h={5} color={gateStates[2] === "pass" ? PASS : BRASS} edge={PAPER} />
          </g>
          {/* Monospace Gate Plaque */}
          <IsoBox x={329} y={134} z={42} w={16} d={1} h={14} color={NAVY} edge={BRASS} />
        </g>

        {/* Spark burst on rejecting gate */}
        {sparkGate !== null && (
          <g aria-hidden="true">
            <circle cx={sparkSx} cy={sparkSy} r={20} fill={REJECT} opacity={0.65} className={styles.spark} />
            <line x1={sparkSx - 12} y1={sparkSy - 12} x2={sparkSx + 12} y2={sparkSy + 12} stroke={PAPER} strokeWidth={2} />
            <line x1={sparkSx + 12} y1={sparkSy - 12} x2={sparkSx - 12} y2={sparkSy + 12} stroke={PAPER} strokeWidth={2} />
          </g>
        )}

        {/* ============================================================== */}
        {/* 5. MACHINE DISPENSER & PHYSICAL CONTROLS                       */}
        {/* ============================================================== */}
        {/* Machine Housing */}
        <IsoBox x={35} y={110} z={0} w={62} d={75} h={55} color={NAVY_RAISED} edge={STEEL} />
        {/* Top Chamfer Bezel */}
        <IsoBox x={38} y={113} z={55} w={56} d={69} h={4} color={STEEL} edge={PAPER} />

        {/* Machine Front Console: Digital Display Screen */}
        <IsoBox x={40} y={185} z={16} w={48} d={2} h={26} color="#060c18" edge={BRASS} />
        <IsoText
          x={64}
          y={186}
          z={33}
          text={`${amountUsdc.toFixed(2)} USDC`}
          size={7.5}
          fill="var(--bp-pass)"
          weight={700}
        />
        <IsoText
          x={64}
          y={186}
          z={21}
          text={`NONCE #${nonce}`}
          size={6.5}
          fill="var(--bp-ink)"
          weight={600}
        />

        {/* Machine Output Mouth Slot */}
        <IsoBox x={85} y={142} z={16} w={12} d={16} h={8} color="#000" edge={STEEL} />

        {/* 5A. PHYSICAL CONTROL: DIAL KNOB (ROLE="SLIDER") */}
        <g
          role="slider"
          tabIndex={0}
          aria-label="Payment amount dial knob (click or use arrow keys to adjust in 0.05 USDC steps)"
          aria-valuemin={0.05}
          aria-valuemax={1.2}
          aria-valuenow={amountUsdc}
          aria-valuetext={`${amountUsdc.toFixed(2)} USDC`}
          onClick={handleDialClick}
          onKeyDown={handleDialKeyDown}
          className={styles.control}
        >
          {/* Dial Base Plate */}
          <IsoBox x={45} y={128} z={59} w={20} d={20} h={2} color={NAVY} edge={BRASS} />
          {/* Dial Beveled Body */}
          <IsoCylinder x={54} y={138} z={61} r={8} h={6} color={BRASS} />
          {/* Needle / Indicator Line */}
          <line
            x1={dialSx}
            y1={dialSy}
            x2={needleTipSx}
            y2={needleTipSy}
            stroke={PAPER}
            strokeWidth={2.2}
            strokeLinecap="round"
            className={reducedMotion ? undefined : styles.dialNeedle}
          />
          {/* Dial tick marks around edge */}
          <circle cx={dialSx} cy={dialSy} r={14} fill="none" stroke={PAPER} strokeWidth={0.8} strokeDasharray="2 3" opacity={0.65} />
          {/* Focus Ring */}
          <circle
            cx={dialSx}
            cy={dialSy}
            r={18}
            fill="none"
            stroke={PASS}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
          />
        </g>

        {/* 5B. PHYSICAL CONTROL: THE LEVER (ROLE="BUTTON") */}
        <g
          role="button"
          tabIndex={0}
          aria-label="Pull lever to dispatch payment"
          onClick={onPullLever}
          onKeyDown={activateOnKey(onPullLever)}
          className={styles.control}
        >
          {/* Lever Socket */}
          <IsoBox x={72} y={114} z={59} w={14} d={12} h={4} color={STEEL} edge={BRASS} />
          <IsoCylinder x={78} y={118} z={63} r={4} h={3} color={NAVY} />

          {/* Lever Shaft & Grip */}
          <g className={reducedMotion ? styles.leverInstant : styles.leverArm}>
            <line
              x1={leverBaseSx}
              y1={leverBaseSy}
              x2={leverTipSx}
              y2={leverTipSy}
              stroke={BRASS}
              strokeWidth={3.8}
              strokeLinecap="round"
            />
            {/* Red / Brass Ball Handle on top */}
            <circle cx={leverTipSx} cy={leverTipSy} r={6.5} fill={leverDown ? PASS : REJECT} stroke={PAPER} strokeWidth={1} />
          </g>
          <IsoText x={78} y={118} z={95 - leverHandleOffset} text="PULL" size={8} fill={PAPER} weight={700} />
          {/* Focus Ring */}
          <circle
            cx={leverBaseSx}
            cy={leverBaseSy - 14}
            r={24}
            fill="none"
            stroke={PASS}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
          />
        </g>

        {/* 5C. PHYSICAL CONTROL: RESET BUTTON (ROLE="BUTTON") */}
        <g
          role="button"
          tabIndex={0}
          aria-label="Reset mandate budget and counters"
          onClick={onReset}
          onKeyDown={activateOnKey(onReset)}
          className={styles.control}
        >
          {/* Button housing */}
          <IsoBox x={42} y={116} z={59} w={10} d={10} h={3} color={NAVY_RAISED} edge={STEEL} />
          {/* Cap */}
          <g className={styles.resetCap}>
            <IsoBox x={43} y={117} z={62} w={8} d={8} h={4} color={REJECT} edge={PAPER} />
          </g>
          {/* Focus Ring */}
          <circle
            cx={resetFocusSx}
            cy={resetFocusSy}
            r={14}
            fill="none"
            stroke={PASS}
            strokeWidth={1.8}
            vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
          />
        </g>

        {/* ============================================================== */}
        {/* 6. DESTINATIONS & TARGETS                                      */}
        {/* ============================================================== */}

        {/* 6A. MERCHANT CRATE (ALLOWLISTED DESTINATION) */}
        <g
          role="button"
          tabIndex={0}
          aria-pressed={recipient === MERCHANT_ACCOUNT}
          aria-label={`Select Merchant destination (${MERCHANT_SHORT}) - allowlisted on-chain`}
          onClick={() => onSelectRecipient(MERCHANT_ACCOUNT)}
          onKeyDown={activateOnKey(() => onSelectRecipient(MERCHANT_ACCOUNT))}
          className={styles.control}
        >
          {/* Wooden / Steel Crate */}
          <IsoBox
            x={422}
            y={132}
            z={0}
            w={46}
            d={38}
            h={36}
            color={recipient === MERCHANT_ACCOUNT ? "#1e3a5f" : NAVY_RAISED}
            edge={recipient === MERCHANT_ACCOUNT ? PASS : STEEL}
          />
          {/* Brass reinforcement bands */}
          <IsoBox x={421} y={131} z={10} w={48} d={40} h={4} color={BRASS} />
          <IsoBox x={421} y={131} z={24} w={48} d={40} h={4} color={BRASS} />
          {/* Merchant Plaque */}
          <IsoBox x={423} y={170} z={8} w={44} d={1} h={18} color={NAVY} edge={BRASS} />
          <IsoText x={445} y={196} z={0} text="MERCHANT" size={10} fill={PASS} weight={700} />
          <IsoText x={445} y={196} z={-9} text={MERCHANT_SHORT} size={7.5} fill={PAPER} weight={500} />

          {/* Active Target Beacon indicator */}
          {recipient === MERCHANT_ACCOUNT && (
            <g aria-hidden="true">
              <circle
                cx={merchantFocusSx}
                cy={merchantFocusSy - 48}
                r={24}
                fill="url(#beacon-glow)"
                className={styles.targetBeacon}
              />
              <circle cx={merchantFocusSx} cy={merchantFocusSy - 48} r={4} fill={PASS} />
              <IsoText x={445} y={150} z={58} text="● ACTIVE TARGET" size={8} fill={PASS} weight={700} />
            </g>
          )}

          {/* Focus Ring */}
          <ellipse
            cx={merchantFocusSx}
            cy={merchantFocusSy + 4}
            rx={32}
            ry={18}
            fill="none"
            stroke={PASS}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
          />
        </g>

        {/* 6B. ATTACKER TERMINAL FIGURE (UNLISTED DESTINATION) */}
        <g
          role="button"
          tabIndex={0}
          aria-pressed={recipient === ATTACKER_ACCOUNT}
          aria-label={`Select Attacker destination (${ATTACKER_SHORT}) - unlisted external actor`}
          onClick={() => onSelectRecipient(ATTACKER_ACCOUNT)}
          onKeyDown={activateOnKey(() => onSelectRecipient(ATTACKER_ACCOUNT))}
          className={styles.control}
        >
          {/* Small ominous chassis */}
          <IsoBox
            x={126}
            y={242}
            z={0}
            w={40}
            d={34}
            h={26}
            color={recipient === ATTACKER_ACCOUNT ? "#3b1116" : NAVY_RAISED}
            edge={recipient === ATTACKER_ACCOUNT ? REJECT : STEEL}
          />
          {/* Yellow/Black caution stripes */}
          <IsoBox x={128} y={244} z={26} w={36} d={30} h={3} color={BRASS} edge="#000" />
          {/* Antenna */}
          <line
            x1={isoProject([132, 246, 29])[0]}
            y1={isoProject([132, 246, 29])[1]}
            x2={isoProject([132, 246, 48])[0]}
            y2={isoProject([132, 246, 48])[1]}
            stroke={REJECT}
            strokeWidth={2}
          />
          {/* Attacker Monospace Plaque */}
          <IsoBox x={127} y={276} z={6} w={38} d={1} h={16} color={NAVY} edge={REJECT} />
          <IsoText x={146} y={306} z={0} text="ATTACKER" size={9} fill={REJECT} weight={700} />
          <IsoText x={146} y={306} z={-9} text={ATTACKER_SHORT} size={7} fill={PAPER} weight={500} />

          {/* Active Target Beacon indicator */}
          {recipient === ATTACKER_ACCOUNT && (
            <g aria-hidden="true">
              <circle
                cx={attackerFocusSx}
                cy={attackerFocusSy - 42}
                r={24}
                fill="url(#attacker-beacon-glow)"
                className={styles.targetBeacon}
              />
              <circle cx={attackerFocusSx} cy={attackerFocusSy - 42} r={4} fill={REJECT} />
              <IsoText x={146} y={258} z={54} text="● ACTIVE TARGET" size={8} fill={REJECT} weight={700} />
            </g>
          )}

          {/* Focus Ring */}
          <ellipse
            cx={attackerFocusSx}
            cy={attackerFocusSy + 4}
            rx={28}
            ry={16}
            fill="none"
            stroke={REJECT}
            strokeWidth={2}
            vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
          />
        </g>

        {/* 6C. REJECTED WASTE BIN */}
        <g>
          <IsoBox x={262} y={212} z={0} w={50} d={38} h={26} color="#5a1818" edge={REJECT} />
          {/* Steel bin rim */}
          <IsoBox x={260} y={210} z={26} w={54} d={42} h={4} color="#8a2020" edge={PAPER} />
          {/* Bin plaque */}
          <IsoBox x={263} y={250} z={6} w={48} d={1} h={14} color={NAVY} edge={REJECT} />
          <IsoText x={287} y={282} z={0} text="REJECTED BIN" size={9} fill={REJECT} weight={700} />
          {activeCode && (
            <IsoText x={287} y={282} z={-9} text={activeCode} size={7.5} fill={PAPER} weight={600} />
          )}
        </g>

        {/* ============================================================== */}
        {/* 7. TRAVELING PAYMENT PACKET                                    */}
        {/* ============================================================== */}
        {isPacketVisible && (
          <g
            className={reducedMotion ? styles.packetInstant : styles.packet}
            style={{
              transform: `translate(${packetSx.toFixed(2)}px, ${packetSy.toFixed(2)}px)`,
            }}
          >
            {/* Packet Box relative to projected center */}
            <g transform="translate(-14, -14)">
              <rect
                x={0}
                y={0}
                width={28}
                height={20}
                rx={3}
                fill={packetTone === "pass" ? "var(--bp-canvas)" : "#421319"}
                stroke={packetTone === "pass" ? PASS : REJECT}
                strokeWidth={1.8}
              />
              <text
                x={14}
                y={13}
                textAnchor="middle"
                fontSize={9}
                fontFamily="var(--font-geist-mono), monospace"
                fontWeight={700}
                fill={packetTone === "pass" ? PASS : REJECT}
              >
                {packetLabel || `${amountUsdc.toFixed(2)} USDC`}
              </text>
            </g>
          </g>
        )}
      </g>
    </svg>
  );
});
