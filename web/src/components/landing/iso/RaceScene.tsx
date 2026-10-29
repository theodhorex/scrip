"use client";

import { memo, type CSSProperties, type KeyboardEvent } from "react";
import { formatUsdcFixed, type LandingRaceData } from "@/lib/landing-data";
import {
  IsoBox,
  IsoCylinder,
  IsoGround,
  IsoLine,
  IsoShadow,
  isoProject,
  tone,
} from "./Iso";
import styles from "./RaceScene.module.css";

export type RaceSpeed = 1 | 0.5;

export type RaceSceneProps = {
  data: LandingRaceData;
  tick: number;
  maxTick: number;
  stepMs: number;
  isRunning: boolean;
  isViewportActive: boolean;
  speed: RaceSpeed;
  onFire: () => void;
  onRunAgain: () => void;
  onToggleSpeed: () => void;
};

// Palette tokens per DESIGN_V2.md
const STEEL = "#8fa3c4";
const VAULT = "#1f4fd8";
const NAVY = "#0c1527";
const NAVY_RAISED = "#152442";
const PAPER = "#e8eef7";
const BRASS = "#c9a24a";
const PASS = "var(--bp-pass)";
const REJECT = "var(--bp-reject)";

// World geometry (all projected via isoProject from Iso.tsx)
const FLOOR_W = 500;
const FLOOR_D = 344;
const NAIVE_Y = 48;
const AMANAT_Y = 224;
const BELT_X0 = 96;
const BELT_X1 = 396;
const PORTAL_X = 244;
const VAULT_X = 396;

export const PACKET_PORTAL_TICKS = 3;
export const PACKET_END_TICKS = 6;

export function deriveBudgetPackets(data: LandingRaceData): number {
  const payment = BigInt(data.paymentUnits);
  const budget = BigInt(data.budgetUnits);
  return payment > BigInt(0)
    ? Number(budget / payment)
    : data.amanat.paymentsPaid;
}

type PacketVisual = {
  sx: number;
  sy: number;
  opacity: number;
  isCoral: boolean;
};

function computeNaivePacket(
  index: number,
  tick: number,
  budgetPackets: number,
  naivePaidMax: number,
): PacketVisual {
  const age = tick - (index + 1);
  if (age < 0) {
    const [sx, sy] = isoProject([100, NAIVE_Y, 13]);
    return { sx, sy, opacity: 0, isCoral: false };
  }

  // Packets within budget (1..budgetPackets) pass open portal into Naive Vault
  if (index < budgetPackets) {
    const clamped = Math.min(PACKET_END_TICKS, age);
    const u = clamped / PACKET_END_TICKS;
    const x = 100 + u * (VAULT_X - 2 - 100);
    const [sx, sy] = isoProject([x, NAIVE_Y, 13]);
    return {
      sx,
      sy,
      opacity: age >= PACKET_END_TICKS ? 0 : 1,
      isCoral: false,
    };
  }

  // Leaked packets (budgetPackets+1 .. naivePaidMax) cross open portal, turn coral, pile in Leaked bin
  if (index < naivePaidMax) {
    const leakedTotal = Math.max(1, naivePaidMax - budgetPackets);
    const k = index - budgetPackets;
    const cols = Math.max(2, Math.ceil(Math.sqrt(leakedTotal)));
    const col = k % cols;
    const row = Math.floor(k / cols) % 2;
    const layer = Math.floor(k / (cols * 2));
    const restX = 282 + col * 20;
    const restY = 96 + row * 12;
    const restZ = 18 + layer * 4.5 + (k % 2) * 1.5;

    if (age <= PACKET_PORTAL_TICKS) {
      const u = age / PACKET_PORTAL_TICKS;
      const x = 100 + u * (PORTAL_X + 8 - 100);
      const [sx, sy] = isoProject([x, NAIVE_Y, 13]);
      return { sx, sy, opacity: 1, isCoral: false };
    }
    if (age === PACKET_PORTAL_TICKS + 1) {
      const [sx, sy] = isoProject([286, NAIVE_Y + 6, 14]);
      return { sx, sy, opacity: 1, isCoral: true };
    }
    if (age === PACKET_PORTAL_TICKS + 2) {
      const [sx, sy] = isoProject([
        (286 + restX) / 2,
        (NAIVE_Y + 22 + restY) / 2,
        24,
      ]);
      return { sx, sy, opacity: 1, isCoral: true };
    }
    const [sx, sy] = isoProject([restX, restY, restZ]);
    return { sx, sy, opacity: 1, isCoral: true };
  }

  // Remaining Naive attempts after async callbacks settle: halt and fade before portal
  if (age <= 2) {
    const x = 100 + (age / 3) * (PORTAL_X - 28 - 100);
    const [sx, sy] = isoProject([x, NAIVE_Y, 13]);
    return { sx, sy, opacity: 1, isCoral: false };
  }
  if (age === 3) {
    const [sx, sy] = isoProject([214, NAIVE_Y, 13]);
    return { sx, sy, opacity: 0.42, isCoral: true };
  }
  const [sx, sy] = isoProject([224, NAIVE_Y, 9]);
  return { sx, sy, opacity: 0, isCoral: true };
}

function CoinPacket({
  visual,
  instant,
}: {
  visual: PacketVisual;
  instant: boolean;
}) {
  return (
    <g
      className={instant ? styles.packetInstant : styles.packet}
      style={{
        transform: `translate3d(${visual.sx.toFixed(1)}px, ${visual.sy.toFixed(1)}px, 0)`,
        opacity: visual.opacity,
      }}
    >
      <ellipse cx={0} cy={3.5} rx={7.8} ry={3.8} fill="#000" opacity={0.28} />
      {/* Base teal 0.10 USDC coin */}
      <path
        d="M -7.2 -3.6 L -7.2 0.4 A 7.2 3.6 0 0 0 7.2 0.4 L 7.2 -3.6 Z"
        fill="url(#coin-teal-side)"
        stroke="#99f6e4"
        strokeWidth={0.45}
      />
      <ellipse
        cx={0}
        cy={-3.6}
        rx={7.2}
        ry={3.6}
        fill="#5eead4"
        stroke="#ccfbf1"
        strokeWidth={0.5}
      />
      {/* Coral overlay crossfaded purely via GPU opacity */}
      <g
        className={styles.coralOverlay}
        style={{ opacity: visual.isCoral ? 1 : 0 }}
      >
        <path
          d="M -7.2 -3.6 L -7.2 0.4 A 7.2 3.6 0 0 0 7.2 0.4 L 7.2 -3.6 Z"
          fill="url(#coin-coral-side)"
          stroke="#ffb4a1"
          strokeWidth={0.45}
        />
        <ellipse
          cx={0}
          cy={-3.6}
          rx={7.2}
          ry={3.6}
          fill="#ff8569"
          stroke="#ffd5cb"
          strokeWidth={0.5}
        />
      </g>
    </g>
  );
}

function Rivets({
  x,
  y,
  z,
  w,
  d,
  inset = 4,
}: {
  x: number;
  y: number;
  z: number;
  w: number;
  d: number;
  inset?: number;
}) {
  const spots: Array<[number, number]> = [
    [x + inset, y + inset],
    [x + w - inset, y + inset],
    [x + inset, y + d - inset],
    [x + w - inset, y + d - inset],
  ];
  return (
    <g>
      {spots.map(([px, py], idx) => {
        const [cx, cy] = isoProject([px, py, z]);
        return <circle key={idx} cx={cx} cy={cy} r={1.6} fill={BRASS} />;
      })}
    </g>
  );
}

function EngravedPlaque({
  x,
  y,
  z = 0,
  width,
  text,
  accent = BRASS,
  textFill = PAPER,
}: {
  x: number;
  y: number;
  z?: number;
  width: number;
  text: string;
  accent?: string;
  textFill?: string;
}) {
  const [sx, sy] = isoProject([x, y, z]);
  return (
    <g transform={`translate(${sx.toFixed(1)} ${sy.toFixed(1)})`}>
      <rect
        x={-width / 2}
        y={-11}
        width={width}
        height={22}
        rx={2}
        fill={NAVY}
        stroke={accent}
        strokeWidth={1.1}
      />
      <circle cx={-width / 2 + 5} cy={0} r={1.3} fill={BRASS} />
      <circle cx={width / 2 - 5} cy={0} r={1.3} fill={BRASS} />
      <text
        x={0}
        y={4}
        textAnchor="middle"
        fontFamily="var(--font-geist-mono), ui-monospace, monospace"
        fontSize={12}
        fontWeight={600}
        fill={textFill}
      >
        {text}
      </text>
    </g>
  );
}

function ShooterMachine({
  laneY,
  dispatched,
  totalAttempts,
  paymentUsdc,
  firing,
}: {
  laneY: number;
  dispatched: number;
  totalAttempts: number;
  paymentUsdc: string;
  firing: boolean;
}) {
  const y0 = laneY - 26;
  const [lampX, lampY] = isoProject([46, laneY - 14, 48]);
  const [counterX, counterY] = isoProject([64, laneY, 68]);

  return (
    <g>
      <IsoShadow x={34} y={y0} w={62} d={52} />
      {/* Main steel housing + chamfered navy top cap */}
      <IsoBox x={34} y={y0} z={0} w={60} d={52} h={38} color={STEEL} />
      <IsoBox
        x={39}
        y={y0 + 5}
        z={38}
        w={50}
        d={42}
        h={6}
        color={NAVY_RAISED}
        edge="var(--bp-line-strong)"
      />
      <Rivets x={34} y={y0} z={38} w={60} d={52} />
      {/* Coin magazine hopper */}
      <IsoCylinder x={64} y={laneY} z={44} r={11} h={16} color={BRASS} />
      {/* Barrel muzzle projecting onto the belt */}
      <IsoBox
        x={92}
        y={laneY - 10}
        z={8}
        w={12}
        d={20}
        h={16}
        color={NAVY}
        edge={STEEL}
      />
      {/* Firing lamp */}
      <circle
        cx={lampX}
        cy={lampY}
        r={4}
        fill={firing ? PASS : "#2c3e63"}
        className={styles.lampGlow}
      />
      {/* Monospace shot counter mounted above hopper */}
      <g transform={`translate(${counterX.toFixed(1)} ${counterY.toFixed(1)})`}>
        <rect
          x={-42}
          y={-18}
          width={84}
          height={22}
          rx={2}
          fill="#06101f"
          stroke="var(--bp-line-strong)"
          strokeWidth={1}
        />
        <text
          x={0}
          y={-3}
          textAnchor="middle"
          fontFamily="var(--font-geist-mono), ui-monospace, monospace"
          fontSize={11.5}
          fontWeight={700}
          fill={PAPER}
        >
          {dispatched}/{totalAttempts} · {paymentUsdc}
        </text>
      </g>
    </g>
  );
}

function VaultUnit({
  laneY,
  paidCount,
  budgetPackets,
  maxGaugeSlots,
  spentUsdc,
  overBudgetUsdc,
  totalAttempts,
  exceeded,
}: {
  laneY: number;
  paidCount: number;
  budgetPackets: number;
  maxGaugeSlots: number;
  spentUsdc: string;
  overBudgetUsdc: string;
  totalAttempts: number;
  exceeded: boolean;
}) {
  const y0 = laneY - 38;
  const accent = exceeded ? REJECT : PASS;
  const [lampX, lampY] = isoProject([VAULT_X + 38, laneY, 82]);
  const [readoutX, readoutY] = isoProject([VAULT_X + 46, laneY, 86]);
  const slotStep = 52 / Math.max(1, maxGaugeSlots);

  return (
    <g>
      <IsoShadow x={VAULT_X} y={y0} w={78} d={76} />
      {/* Heavy blue vault body */}
      <IsoBox x={VAULT_X} y={y0} z={0} w={78} d={76} h={70} color={VAULT} />
      {/* Chamfered top armour plate */}
      <IsoBox
        x={VAULT_X + 6}
        y={y0 + 6}
        z={70}
        w={66}
        d={64}
        h={7}
        color={tone(VAULT).top}
        edge="var(--bp-line-strong)"
      />
      <Rivets x={VAULT_X} y={y0} z={70} w={78} d={76} inset={5} />
      {/* Intake slot facing conveyor */}
      <IsoBox
        x={VAULT_X - 2}
        y={laneY - 12}
        z={8}
        w={3}
        d={24}
        h={18}
        color="#050b16"
        edge="var(--bp-line-strong)"
      />
      {/* Top vault status beacon */}
      <IsoCylinder x={VAULT_X + 38} y={laneY} z={77} r={7} h={4} color={NAVY} />
      <circle cx={lampX} cy={lampY} r={4.5} fill={accent} />

      {/* Rising segmented fill bar on front-left (+y) face (pure opacity transitions) */}
      <IsoBox
        x={VAULT_X + 22}
        y={y0 + 75}
        z={7}
        w={34}
        d={4}
        h={56}
        color="#050b16"
        edge="var(--bp-line-strong)"
      />
      {Array.from({ length: maxGaugeSlots }).map((_, idx) => {
        const isOverflowSlot = idx >= budgetPackets;
        const lit = idx < paidCount;
        const segZ = 9 + idx * slotStep;
        return (
          <g
            key={idx}
            className={styles.gaugeSegment}
            style={{ opacity: lit ? 1 : 0.12 }}
          >
            <IsoBox
              x={VAULT_X + 25}
              y={y0 + 77}
              z={segZ}
              w={28}
              d={3.5}
              h={Math.max(1.8, slotStep - 1.1)}
              color={isOverflowSlot ? "#ff6b4a" : "#2dd4bf"}
            />
          </g>
        );
      })}
      {/* Engraved brass 1.00 budget mark across the vault gauge */}
      <IsoLine
        points={[
          [VAULT_X + 19, y0 + 81, 9 + budgetPackets * slotStep],
          [VAULT_X + 59, y0 + 81, 9 + budgetPackets * slotStep],
        ]}
        stroke={BRASS}
        strokeWidth={1.8}
      />

      {/* Big monospace total plaque above vault */}
      <g transform={`translate(${readoutX.toFixed(1)} ${readoutY.toFixed(1)})`}>
        <rect
          x={-70}
          y={-28}
          width={140}
          height={42}
          rx={3}
          fill="rgba(7, 13, 26, 0.94)"
          stroke={accent}
          strokeWidth={1.4}
        />
        <text
          x={0}
          y={-7}
          textAnchor="middle"
          fontFamily="var(--font-geist-mono), ui-monospace, monospace"
          fontSize={17}
          fontWeight={700}
          fill={accent}
        >
          {spentUsdc} USDC
        </text>
        <text
          x={0}
          y={8}
          textAnchor="middle"
          fontFamily="var(--font-geist-mono), ui-monospace, monospace"
          fontSize={10.5}
          fill="var(--bp-muted)"
        >
          {paidCount}/{totalAttempts} paid · +{overBudgetUsdc}
        </text>
      </g>
    </g>
  );
}

/** Static floor, belts, rails, and plaques memoized so animation ticks skip them. */
const StaticFloorAndBelts = memo(function StaticFloorAndBelts() {
  const [floorGlowX, floorGlowY] = isoProject([250, 172, 0]);

  return (
    <g>
      <IsoGround w={FLOOR_W} d={FLOOR_D} color={NAVY} cell={40} />
      <ellipse
        cx={floorGlowX}
        cy={floorGlowY}
        rx={330}
        ry={155}
        fill="url(#race-floor-glow)"
      />
      {/* Corner anchor bolts on steel floor */}
      <Rivets x={0} y={0} z={0} w={FLOOR_W} d={FLOOR_D} inset={12} />

      {/* Painted budget threshold line across the deck tying both portals together */}
      <IsoLine
        points={[
          [PORTAL_X, 14, 0.5],
          [PORTAL_X, 254, 0.5],
        ]}
        stroke={BRASS}
        strokeWidth={1.5}
        strokeDasharray="5 5"
        opacity={0.75}
      />

      {/* LANE 1: Naive diagonal conveyor belt + notched front spill rail */}
      <IsoBox
        x={BELT_X0}
        y={NAIVE_Y - 18}
        z={0}
        w={BELT_X1 - BELT_X0}
        d={36}
        h={8}
        color="#162645"
        edge="var(--bp-line-strong)"
      />
      <IsoBox
        x={BELT_X0}
        y={NAIVE_Y - 21}
        z={0}
        w={BELT_X1 - BELT_X0}
        d={3}
        h={11}
        color={STEEL}
      />
      {/* Front rail split around spill chute (x=276..316) into Leaked bin */}
      <IsoBox x={BELT_X0} y={NAIVE_Y + 18} z={0} w={180} d={3} h={11} color={STEEL} />
      <IsoBox x={316} y={NAIVE_Y + 18} z={0} w={80} d={3} h={11} color={STEEL} />
      <IsoLine
        points={[
          [BELT_X0 + 8, NAIVE_Y, 8.5],
          [BELT_X1 - 6, NAIVE_Y, 8.5],
        ]}
        stroke="var(--bp-line-strong)"
        strokeWidth={1.3}
        strokeDasharray="6 7"
      />

      {/* LANE 2: Amanat diagonal conveyor belt + deflect notch into OVER_BUDGET bin */}
      <IsoBox
        x={BELT_X0}
        y={AMANAT_Y - 18}
        z={0}
        w={BELT_X1 - BELT_X0}
        d={36}
        h={8}
        color="#162645"
        edge="var(--bp-line-strong)"
      />
      <IsoBox
        x={BELT_X0}
        y={AMANAT_Y - 21}
        z={0}
        w={BELT_X1 - BELT_X0}
        d={3}
        h={11}
        color={STEEL}
      />
      {/* Front rail split at x=196..238 so bounced coins deflect into OVER_BUDGET bin */}
      <IsoBox x={BELT_X0} y={AMANAT_Y + 18} z={0} w={100} d={3} h={11} color={STEEL} />
      <IsoBox x={238} y={AMANAT_Y + 18} z={0} w={158} d={3} h={11} color={STEEL} />
      <IsoLine
        points={[
          [BELT_X0 + 8, AMANAT_Y, 8.5],
          [BELT_X1 - 6, AMANAT_Y, 8.5],
        ]}
        stroke="var(--bp-line-strong)"
        strokeWidth={1.3}
        strokeDasharray="6 7"
      />

      {/* Trigger conduits connecting Master Firing Console to both Shooters */}
      <IsoLine
        points={[
          [64, 260, 4],
          [64, 250, 4],
        ]}
        stroke={PASS}
        strokeWidth={2}
        opacity={0.75}
      />
      <IsoLine
        points={[
          [24, 274, 3],
          [16, 274, 3],
          [16, NAIVE_Y, 3],
          [34, NAIVE_Y, 3],
        ]}
        stroke={PASS}
        strokeWidth={1.8}
        opacity={0.65}
      />
    </g>
  );
});

/** Plaques and the deck legend are drawn last so belts and portals never cover them. */
function StaticLabels({
  total,
  speed,
}: {
  total: number;
  speed: 1 | 0.5;
}) {
  const [legendX, legendY] = isoProject([20, 356, 0]);
  const legendFont = {
    fontFamily: "var(--font-geist-mono), ui-monospace, monospace",
    fontSize: 11,
    fontWeight: 600,
    letterSpacing: "0.04em",
  } as const;
  return (
    <g>
      <EngravedPlaque x={112} y={12} z={2} width={122} text="Naive contract" />
      <EngravedPlaque
        x={126}
        y={190}
        z={2}
        width={116}
        text="Amanat vault"
        accent={PASS}
      />
      <g aria-hidden="true" {...legendFont} textAnchor="start">
        <text x={legendX} y={legendY} fill={PASS}>
          FIRE {total}
        </text>
        <text x={legendX} y={legendY + 15} fill="var(--bp-muted)">
          RUN AGAIN
        </text>
        <text x={legendX} y={legendY + 30} fill="var(--bp-muted)">
          SPEED{" "}
          <tspan fill={speed === 1 ? PASS : "var(--bp-muted)"}>1x</tspan>
          {" / "}
          <tspan fill={speed === 0.5 ? BRASS : "var(--bp-muted)"}>0.5x</tspan>
        </text>
      </g>
    </g>
  );
}

export function RaceScene({
  data,
  tick,
  stepMs,
  isRunning,
  isViewportActive,
  speed,
  onFire,
  onRunAgain,
  onToggleSpeed,
}: RaceSceneProps) {
  const total = data.totalAttempts;
  const paymentUnits = BigInt(data.paymentUnits);
  const budgetPackets = deriveBudgetPackets(data);
  const naivePaidMax = data.naive.paymentsPaid;
  const amanatPaidMax = data.amanat.paymentsPaid;
  const maxGaugeSlots = Math.max(naivePaidMax, amanatPaidMax, budgetPackets);

  const dispatched = Math.min(total, Math.max(0, tick));

  // Derive live paid/leaked/bounced counts strictly from tick + data
  let naivePaidCount = 0;
  let naiveLeakedCount = 0;
  for (let i = 0; i < naivePaidMax; i += 1) {
    const age = tick - (i + 1);
    if (i < budgetPackets) {
      if (age >= PACKET_END_TICKS) naivePaidCount += 1;
    } else if (age >= PACKET_PORTAL_TICKS + 1) {
      naivePaidCount += 1;
      naiveLeakedCount += 1;
    }
  }

  let amanatPaidCount = 0;
  for (let i = 0; i < amanatPaidMax; i += 1) {
    const age = tick - (i + 1);
    if (age >= PACKET_PORTAL_TICKS) amanatPaidCount += 1;
  }

  let amanatBouncedCount = 0;
  for (let i = amanatPaidMax; i < total; i += 1) {
    const age = tick - (i + 1);
    if (age >= PACKET_PORTAL_TICKS) amanatBouncedCount += 1;
  }

  const gateClosed =
    amanatPaidMax > 0 && tick >= amanatPaidMax + PACKET_PORTAL_TICKS;
  const naiveExceeded = naivePaidCount > budgetPackets;

  const naiveSpentUsdc =
    naivePaidCount === naivePaidMax
      ? data.naive.spentUsdc
      : formatUsdcFixed(BigInt(naivePaidCount) * paymentUnits);
  const naiveOverUsdc =
    naivePaidCount === naivePaidMax
      ? data.naive.overBudgetUsdc
      : formatUsdcFixed(BigInt(naiveLeakedCount) * paymentUnits);
  const amanatSpentUsdc =
    amanatPaidCount === amanatPaidMax
      ? data.amanat.spentUsdc
      : formatUsdcFixed(BigInt(amanatPaidCount) * paymentUnits);
  const amanatOverUsdc =
    amanatPaidCount === amanatPaidMax ? data.amanat.overBudgetUsdc : "0.00";

  // Keyboard activation per W3C WAI-ARIA APG Button & Switch patterns:
  // Source: https://www.w3.org/WAI/ARIA/apg/patterns/button/
  // Source: https://www.w3.org/WAI/ARIA/apg/patterns/switch/
  const handleKeyActivate =
    (action: () => void) => (event: KeyboardEvent<SVGGElement>) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        action();
      }
    };

  const [naivePortalLampX, naivePortalLampY] = isoProject([
    PORTAL_X + 6,
    NAIVE_Y,
    74,
  ]);
  const [naivePortalBadgeX, naivePortalBadgeY] = isoProject([
    PORTAL_X + 6,
    NAIVE_Y,
    92,
  ]);
  const [amanatPortalLampX, amanatPortalLampY] = isoProject([
    PORTAL_X + 6,
    AMANAT_Y,
    80,
  ]);
  const [amanatPortalBadgeX, amanatPortalBadgeY] = isoProject([
    PORTAL_X + 6,
    AMANAT_Y,
    98,
  ]);
  const [binCoralLampX, binCoralLampY] = isoProject([230, 302, 26]);

  // Speed switch thumb isometric offset when toggled to 0.5x (+34 along world x)
  const [sw0x, sw0y] = isoProject([0, 0, 0]);
  const [sw1x, sw1y] = isoProject([34, 0, 0]);
  const switchDx = speed === 0.5 ? sw1x - sw0x : 0;
  const switchDy = speed === 0.5 ? sw1y - sw0y : 0;

  const [fireFocusX, fireFocusY] = isoProject([52, 282, 28]);
  const [againFocusX, againFocusY] = isoProject([98, 276, 25]);
  const [speedFocusX, speedFocusY] = isoProject([72, 316, 23]);

  const sceneVars = {
    "--step-ms": `${stepMs}ms`,
  } as CSSProperties;

  return (
    <svg
      viewBox="-310 -26 766 474"
      role="group"
      aria-label={`Isometric race rig comparing Naive contract and Amanat vault across ${total} payments of ${data.paymentUsdc} USDC against a ${data.budgetUsdc} USDC budget`}
      className={styles.sceneSvg}
      style={sceneVars}
    >
      <defs>
        <radialGradient id="race-floor-glow" cx="50%" cy="50%" r="58%">
          <stop offset="0" stopColor="var(--bp-pass)" stopOpacity="0.11" />
          <stop offset="1" stopColor="var(--bp-pass)" stopOpacity="0" />
        </radialGradient>
        <linearGradient id="coin-teal-side" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#99f6e4" />
          <stop offset="0.48" stopColor="#2dd4bf" />
          <stop offset="1" stopColor="#0f766e" />
        </linearGradient>
        <linearGradient id="coin-coral-side" x1="0" x2="1" y1="0" y2="0">
          <stop offset="0" stopColor="#ffb4a1" />
          <stop offset="0.48" stopColor="#ff6b4a" />
          <stop offset="1" stopColor="#9a2c15" />
        </linearGradient>
      </defs>

      {/* 1. Static steel deck, parallel diagonal conveyor belts, plaques, conduits */}
      <StaticFloorAndBelts />

      {/* 2. Lagging async callback cable from Naive Vault to Naive Portal */}
      <IsoLine
        points={[
          [VAULT_X, NAIVE_Y - 26, 4],
          [PORTAL_X + 10, NAIVE_Y - 26, 4],
        ]}
        stroke={naiveExceeded ? REJECT : "var(--bp-line-strong)"}
        strokeWidth={1.6}
        strokeDasharray="4 5"
        opacity={naiveExceeded ? 0.9 : 0.55}
      />

      {/* 3. Naive Shooter + Naive Portal back pillar + Naive Vault + Leaked bin basin */}
      <ShooterMachine
        laneY={NAIVE_Y}
        dispatched={dispatched}
        totalAttempts={total}
        paymentUsdc={data.paymentUsdc}
        firing={isRunning && dispatched < total}
      />

      {/* Naive Portal back pillar */}
      <IsoShadow x={PORTAL_X} y={NAIVE_Y - 30} w={12} d={60} />
      <IsoBox
        x={PORTAL_X}
        y={NAIVE_Y - 30}
        z={0}
        w={12}
        d={10}
        h={56}
        color={STEEL}
      />

      {/* Naive Vault */}
      <VaultUnit
        laneY={NAIVE_Y}
        paidCount={naivePaidCount}
        budgetPackets={budgetPackets}
        maxGaugeSlots={maxGaugeSlots}
        spentUsdc={naiveSpentUsdc}
        overBudgetUsdc={naiveOverUsdc}
        totalAttempts={total}
        exceeded={naiveExceeded}
      />

      {/* Naive "Leaked 0.40" catch bin + spill chute (drawn before Naive coins so leaked pile rests inside basin) */}
      <IsoBox
        x={278}
        y={NAIVE_Y + 18}
        z={2}
        w={36}
        d={18}
        h={5}
        color="#2a1620"
        edge={REJECT}
      />
      <IsoShadow x={266} y={84} w={60} d={38} />
      <IsoBox
        x={266}
        y={84}
        z={0}
        w={60}
        d={38}
        h={16}
        color="#2b141a"
        edge={REJECT}
      />
      <IsoBox
        x={270}
        y={88}
        z={13}
        w={52}
        d={30}
        h={3.5}
        color="#11070a"
        edge="#5e252e"
      />

      {/* 3b. Naive 30-packet stream (passes under portal lintel; packets 11..14 turn coral and pile in Leaked bin) */}
      <g aria-hidden="true">
        {Array.from({ length: total }).map((_, idx) => (
          <CoinPacket
            key={`naive-${idx}`}
            instant={tick === 0}
            visual={computeNaivePacket(
              idx,
              tick,
              budgetPackets,
              naivePaidMax,
            )}
          />
        ))}
      </g>

      {/* Naive Portal front pillar + open lintel (no gate bar!) */}
      <IsoBox
        x={PORTAL_X}
        y={NAIVE_Y + 20}
        z={0}
        w={12}
        d={10}
        h={56}
        color={STEEL}
      />
      <IsoBox
        x={PORTAL_X - 1}
        y={NAIVE_Y - 30}
        z={56}
        w={14}
        d={60}
        h={11}
        color={NAVY_RAISED}
        edge="var(--bp-line-strong)"
      />
      <Rivets x={PORTAL_X - 1} y={NAIVE_Y - 30} z={67} w={14} d={60} inset={3} />
      <circle
        cx={naivePortalLampX}
        cy={naivePortalLampY}
        r={5}
        fill={naiveExceeded ? REJECT : BRASS}
      />
      <text
        x={naivePortalBadgeX + 28}
        y={naivePortalBadgeY}
        textAnchor="middle"
        fontFamily="var(--font-geist-mono), ui-monospace, monospace"
        fontSize={11}
        fontWeight={700}
        fill={naiveExceeded ? REJECT : "var(--bp-muted)"}
      >
        {data.budgetUsdc} · no lock
      </text>

      <EngravedPlaque
        x={296}
        y={128}
        z={8}
        width={108}
        text={`Leaked ${naiveOverUsdc}`}
        accent={REJECT}
        textFill={REJECT}
      />

      {/* 5. Synchronous reservation cable from Amanat Vault to Amanat Portal */}
      <IsoLine
        points={[
          [VAULT_X, AMANAT_Y - 26, 4.5],
          [PORTAL_X + 10, AMANAT_Y - 26, 4.5],
        ]}
        stroke={PASS}
        strokeWidth={2.2}
        opacity={gateClosed ? 1 : 0.72}
      />

      {/* 6. Amanat Shooter + Amanat Portal (with slamming blast bar) + Amanat Vault */}
      <ShooterMachine
        laneY={AMANAT_Y}
        dispatched={dispatched}
        totalAttempts={total}
        paymentUsdc={data.paymentUsdc}
        firing={isRunning && dispatched < total}
      />

      {/* Amanat Portal back pillar */}
      <IsoShadow x={PORTAL_X} y={AMANAT_Y - 30} w={14} d={60} />
      <IsoBox
        x={PORTAL_X}
        y={AMANAT_Y - 30}
        z={0}
        w={12}
        d={10}
        h={62}
        color={STEEL}
      />

      {/* Slamming physical blast gate bar (moves purely via GPU translate3d) */}
      <g
        className={`${styles.gateBar} ${
          gateClosed ? styles.gateBarClosed : styles.gateBarOpen
        }`}
      >
        <IsoBox
          x={PORTAL_X + 2}
          y={AMANAT_Y - 18}
          z={8}
          w={7}
          d={36}
          h={34}
          color="#2dd4bf"
          edge={PAPER}
        />
      </g>

      {/* Amanat Vault */}
      <VaultUnit
        laneY={AMANAT_Y}
        paidCount={amanatPaidCount}
        budgetPackets={budgetPackets}
        maxGaugeSlots={maxGaugeSlots}
        spentUsdc={amanatSpentUsdc}
        overBudgetUsdc={amanatOverUsdc}
        totalAttempts={total}
        exceeded={false}
      />

      {/* Amanat Portal front pillar + fortified lintel housing */}
      <IsoBox
        x={PORTAL_X}
        y={AMANAT_Y + 20}
        z={0}
        w={12}
        d={10}
        h={62}
        color={STEEL}
      />
      <IsoBox
        x={PORTAL_X - 2}
        y={AMANAT_Y - 30}
        z={62}
        w={16}
        d={60}
        h={13}
        color={NAVY_RAISED}
        edge={PASS}
      />
      <Rivets x={PORTAL_X - 2} y={AMANAT_Y - 30} z={75} w={16} d={60} inset={3} />
      <circle cx={amanatPortalLampX} cy={amanatPortalLampY} r={5.5} fill={PASS} />
      <text
        x={amanatPortalBadgeX}
        y={amanatPortalBadgeY}
        textAnchor="middle"
        fontFamily="var(--font-geist-mono), ui-monospace, monospace"
        fontSize={11}
        fontWeight={700}
        fill={PASS}
      >
        {gateClosed ? `${data.budgetUsdc} · LOCKED` : `${data.budgetUsdc} · reserve`}
      </text>

      {/* 7. Amanat "OVER_BUDGET x20" catch bin + small coral lamp */}
      <IsoShadow x={168} y={260} w={70} d={48} />
      <IsoBox
        x={168}
        y={260}
        z={0}
        w={70}
        d={48}
        h={17}
        color="#1e1726"
        edge={amanatBouncedCount > 0 ? REJECT : "var(--bp-line-strong)"}
      />
      <IsoBox
        x={173}
        y={265}
        z={14}
        w={60}
        d={38}
        h={3.5}
        color="#0c0710"
        edge="#4a2233"
      />
      {/* Small coral indicator lamp mounted on the bin corner */}
      <IsoCylinder x={230} y={302} z={17} r={3.2} h={6} color={STEEL} />
      <circle
        cx={binCoralLampX}
        cy={binCoralLampY}
        r={4.2}
        fill={amanatBouncedCount > 0 ? REJECT : "#3a232b"}
        className={
          amanatBouncedCount > 0
            ? `${styles.pulseLamp} ${!isViewportActive ? styles.paused : ""}`
            : undefined
        }
      />
      <EngravedPlaque
        x={203}
        y={316}
        z={4}
        width={142}
        text={`OVER_BUDGET x${amanatBouncedCount}`}
        accent={REJECT}
        textFill={amanatBouncedCount > 0 ? REJECT : "var(--bp-muted)"}
      />

      {/* 8. Foreground Master Firing Console (the physical object IS the control) */}
      <IsoShadow x={18} y={260} w={100} d={74} />
      <IsoBox
        x={18}
        y={260}
        z={0}
        w={100}
        d={74}
        h={18}
        color={NAVY_RAISED}
        edge="var(--bp-line-strong)"
      />
      <IsoBox
        x={22}
        y={264}
        z={18}
        w={92}
        d={66}
        h={3}
        color="#1a2d52"
        edge={STEEL}
      />
      <Rivets x={18} y={260} z={18} w={100} d={74} inset={4} />

      {/* Big Push-Button Plunger: "Fire 30" */}
      <g
        role="button"
        tabIndex={0}
        aria-label={`Fire ${total} payment requests`}
        onClick={onFire}
        onKeyDown={handleKeyActivate(onFire)}
        className={styles.controlGroup}
      >
        <circle
          cx={fireFocusX}
          cy={fireFocusY}
          r={27}
          fill="none"
          stroke={PASS}
          strokeWidth={2.2}
          vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
        />
        <IsoCylinder x={52} y={282} z={21} r={18} h={5} color={STEEL} />
        <g
          className={`${styles.plungerCap} ${
            isRunning ? styles.plungerPressed : ""
          }`}
        >
          <IsoCylinder x={52} y={282} z={26} r={14.5} h={10} color="#2dd4bf" />
        </g>
      </g>

      {/* Small Tactile Reset Button: "Run again" */}
      <g
        role="button"
        tabIndex={0}
        aria-label="Run again"
        onClick={onRunAgain}
        onKeyDown={handleKeyActivate(onRunAgain)}
        className={styles.controlGroup}
      >
        <ellipse
          cx={againFocusX}
          cy={againFocusY}
          rx={24}
          ry={15}
          fill="none"
          stroke={PASS}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
        />
        <g className={styles.smallKeyCap}>
          <IsoBox
            x={84}
            y={266}
            z={21}
            w={26}
            d={20}
            h={7}
            color={STEEL}
            edge={PAPER}
          />
        </g>
      </g>

      {/* Mechanical Speed Switch on Machine: 1x / 0.5x */}
      <g
        role="switch"
        tabIndex={0}
        aria-checked={speed === 0.5}
        aria-label="Half speed 0.5x slow motion"
        onClick={onToggleSpeed}
        onKeyDown={handleKeyActivate(onToggleSpeed)}
        className={styles.controlGroup}
      >
        <ellipse
          cx={speedFocusX}
          cy={speedFocusY}
          rx={38}
          ry={17}
          fill="none"
          stroke={PASS}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
        />
        <IsoBox
          x={34}
          y={308}
          z={21}
          w={72}
          d={14}
          h={2.5}
          color="#06101f"
          edge="var(--bp-line-strong)"
        />
        <g
          className={styles.switchThumb}
          style={{
            transform: `translate3d(${switchDx.toFixed(1)}px, ${switchDy.toFixed(1)}px, 0)`,
          }}
        >
          <IsoBox
            x={36}
            y={309}
            z={23}
            w={32}
            d={12}
            h={6.5}
            color={BRASS}
            edge={PAPER}
          />
        </g>
      </g>
      <StaticLabels total={total} speed={speed} />
    </svg>
  );
}
