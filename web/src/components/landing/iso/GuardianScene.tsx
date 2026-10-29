"use client";

import { useRef, type KeyboardEvent, type PointerEvent } from "react";
import type { GuardianMandate, GuardianRejectCode } from "@/lib/guardian";
import { formatUsdc6 } from "@/lib/proof-data";
import {
  IsoBox,
  IsoCylinder,
  IsoGround,
  IsoLine,
  IsoShadow,
  isoProject,
  tone,
} from "./Iso";
import styles from "../GuardianSection.module.css";

export type LeverKey = "budget" | "perPaymentCap" | "approvalThreshold";

export type LeverSpec = {
  key: LeverKey;
  label: string;
  shortLabel: string;
  stepUnits: number;
  boundRule: string;
};

export const SCALE_MAX_UNITS = 1_500_000;
export const RAIL_START_X = 88;
export const RAIL_SPAN_X = 264;
const DESK_Z = 26;
const COS_30 = Math.cos(Math.PI / 6);
const SIN_30 = 0.5;

const STEEL = "#8fa3c4";
const VAULT = "#1f4fd8";
const NAVY = "#0c1527";
const NAVY_RAISED = "#14223d";
const PAPER = "#e8eef7";
const BRASS = "#c9a24a";
const ROSE_STEEL = "color-mix(in srgb, #8fa3c4 42%, #ff6b4a)";
const PASS = "var(--bp-pass)";
const REJECT = "var(--bp-reject)";

/** Pure helper: maps 6-decimal USDC base units into clamped [0, 1] rail ratio. */
export function unitsToRailRatio(
  units: string | bigint,
  maxUnits = SCALE_MAX_UNITS,
): number {
  if (maxUnits <= 0) return 0;
  const n = Number(typeof units === "bigint" ? units : BigInt(units));
  if (!Number.isFinite(n) || n <= 0) return 0;
  return Math.min(1, Math.max(0, n / maxUnits));
}

/** Pure helper: maps 6-decimal USDC base units to world X along the isometric lever rail. */
export function unitsToLeverWorldX(
  units: string | bigint,
  railStartX = RAIL_START_X,
  railSpanX = RAIL_SPAN_X,
  maxUnits = SCALE_MAX_UNITS,
): number {
  return railStartX + unitsToRailRatio(units, maxUnits) * railSpanX;
}

/**
 * Pure helper: projects 2D SVG pointer delta onto the isometric +x rail unit vector
 * (cos 30deg, sin 30deg) and snaps to stepUnits as a canonical integer string.
 */
export function screenDeltaToUnits(
  svgX: number,
  svgY: number,
  originSvgX: number,
  originSvgY: number,
  railSpanX = RAIL_SPAN_X,
  maxUnits = SCALE_MAX_UNITS,
  stepUnits = 50_000,
): string {
  const dxWorld = (svgX - originSvgX) * COS_30 + (svgY - originSvgY) * SIN_30;
  const clamped = Math.min(railSpanX, Math.max(0, dxWorld));
  const rawUnits = (clamped / railSpanX) * maxUnits;
  const snapped = Math.round(rawUnits / stepUnits) * stepUnits;
  return Math.max(0, Math.min(maxUnits, snapped)).toString();
}

type Props = {
  mandate: GuardianMandate;
  depositedUnits: string;
  levers: readonly LeverSpec[];
  rejections: Record<LeverKey, GuardianRejectCode | null>;
  shaking: Record<LeverKey, boolean>;
  animate: boolean;
  onStep: (key: LeverKey, mode: "tighten" | "loosen") => void;
  onSlideToUnits: (key: LeverKey, targetUnits: string) => void;
  onDemoViolation: () => void;
  onReset: () => void;
};

function Rivets({ x, y, z, w, d }: { x: number; y: number; z: number; w: number; d: number }) {
  const corners: Array<[number, number]> = [
    [x + 5, y + 5],
    [x + w - 5, y + 5],
    [x + 5, y + d - 5],
    [x + w - 5, y + d - 5],
  ];
  return (
    <g aria-hidden="true">
      {corners.map(([rx, ry], idx) => {
        const [cx, cy] = isoProject([rx, ry, z]);
        return <circle key={idx} cx={cx} cy={cy} r={1.7} fill={BRASS} />;
      })}
    </g>
  );
}

function IsoText({
  x,
  y,
  z = 0,
  text,
  size = 13,
  fill = "var(--bp-muted)",
  anchor = "middle",
  weight = 500,
  flat = false,
}: {
  x: number;
  y: number;
  z?: number;
  text: string;
  size?: number;
  fill?: string;
  anchor?: "start" | "middle" | "end";
  weight?: number;
  /** Lay the text on a horizontal surface, running along the world +x axis. */
  flat?: boolean;
}) {
  const [sx, sy] = isoProject([x, y, z]);
  return (
    <text
      x={flat ? 0 : sx}
      y={flat ? 0 : sy}
      transform={flat ? `matrix(${COS_30} ${SIN_30} ${-COS_30} ${SIN_30} ${sx} ${sy})` : undefined}
      textAnchor={anchor}
      fontFamily="var(--font-geist-mono), ui-monospace, monospace"
      fontSize={size}
      fontWeight={weight}
      fill={fill}
      letterSpacing="0.05em"
      style={{ pointerEvents: "none", userSelect: "none" }}
    >
      {text}
    </text>
  );
}

function activateOnKey(cb: () => void) {
  return (e: KeyboardEvent<SVGGElement>) => {
    if (e.key === "Enter" || e.key === " ") {
      e.preventDefault();
      cb();
    }
  };
}

export function GuardianScene({
  mandate,
  depositedUnits,
  levers,
  rejections,
  shaking,
  animate,
  onStep,
  onSlideToUnits,
  onDemoViolation,
  onReset,
}: Props) {
  const svgRef = useRef<SVGSVGElement | null>(null);
  const draggingKeyRef = useRef<LeverKey | null>(null);
  const lastDragUnitsRef = useRef<string | null>(null);

  const ceilingX = unitsToLeverWorldX(depositedUnits);
  const depositLabel = formatUsdc6(depositedUnits);
  const budgetRatio = unitsToRailRatio(String(mandate.budget));
  const depositRatio = unitsToRailRatio(depositedUnits);
  const ceilingFault = rejections.budget === "BUDGET_ABOVE_DEPOSITED";

  const rowYs = [148, 210, 272] as const;

  const clientToSvg = (clientX: number, clientY: number): [number, number] | null => {
    const svg = svgRef.current;
    if (!svg) return null;
    const ctm = svg.getScreenCTM();
    if (!ctm) return null;
    const pt = svg.createSVGPoint();
    pt.x = clientX;
    pt.y = clientY;
    const local = pt.matrixTransform(ctm.inverse());
    return [local.x, local.y];
  };

  // Pointer capture ensures smooth isometric rail dragging even when pointer leaves handle.
  // Source: https://developer.mozilla.org/en-US/docs/Web/API/Element/setPointerCapture
  const handleRailPointerDown = (
    key: LeverKey,
    rowY: number,
    stepUnits: number,
    e: PointerEvent<SVGGElement>,
  ) => {
    e.preventDefault();
    e.currentTarget.setPointerCapture(e.pointerId);
    draggingKeyRef.current = key;
    lastDragUnitsRef.current = String(mandate[key]);
    const svgPt = clientToSvg(e.clientX, e.clientY);
    if (!svgPt) return;
    const [ox, oy] = isoProject([RAIL_START_X, rowY + 12, DESK_Z + 8]);
    const nextUnits = screenDeltaToUnits(
      svgPt[0],
      svgPt[1],
      ox,
      oy,
      RAIL_SPAN_X,
      SCALE_MAX_UNITS,
      stepUnits,
    );
    if (nextUnits !== lastDragUnitsRef.current) {
      lastDragUnitsRef.current = nextUnits;
      onSlideToUnits(key, nextUnits);
    }
  };

  const handleRailPointerMove = (
    key: LeverKey,
    rowY: number,
    stepUnits: number,
    e: PointerEvent<SVGGElement>,
  ) => {
    if (draggingKeyRef.current !== key) return;
    const svgPt = clientToSvg(e.clientX, e.clientY);
    if (!svgPt) return;
    const [ox, oy] = isoProject([RAIL_START_X, rowY + 12, DESK_Z + 8]);
    const nextUnits = screenDeltaToUnits(
      svgPt[0],
      svgPt[1],
      ox,
      oy,
      RAIL_SPAN_X,
      SCALE_MAX_UNITS,
      stepUnits,
    );
    if (nextUnits !== lastDragUnitsRef.current) {
      lastDragUnitsRef.current = nextUnits;
      onSlideToUnits(key, nextUnits);
    }
  };

  const handleRailPointerEnd = (key: LeverKey) => {
    if (draggingKeyRef.current === key) {
      draggingKeyRef.current = null;
      lastDragUnitsRef.current = null;
    }
  };

  // WAI-ARIA APG Slider keyboard contract: Arrow keys step, PageUp/PageDown jump 2x, Home/End hit bounds.
  // Source: https://www.w3.org/WAI/ARIA/apg/patterns/slider/
  // Source: https://developer.mozilla.org/en-US/docs/Web/Accessibility/ARIA/Roles/slider_role
  const handleSliderKeyDown = (lever: LeverSpec, e: KeyboardEvent<SVGGElement>) => {
    const current = BigInt(String(mandate[lever.key]));
    const step = BigInt(lever.stepUnits);
    if (e.key === "ArrowLeft" || e.key === "ArrowDown") {
      e.preventDefault();
      onStep(lever.key, "tighten");
    } else if (e.key === "ArrowRight" || e.key === "ArrowUp") {
      e.preventDefault();
      onStep(lever.key, "loosen");
    } else if (e.key === "PageDown") {
      e.preventDefault();
      const target = current > step * BigInt(2) ? current - step * BigInt(2) : BigInt(0);
      onSlideToUnits(lever.key, target.toString());
    } else if (e.key === "PageUp") {
      e.preventDefault();
      const target = current + step * BigInt(2);
      onSlideToUnits(lever.key, target.toString());
    } else if (e.key === "Home") {
      e.preventDefault();
      onSlideToUnits(lever.key, "0");
    } else if (e.key === "End") {
      e.preventDefault();
      onSlideToUnits(lever.key, String(SCALE_MAX_UNITS));
    }
  };

  const [ceilLampX, ceilLampY] = isoProject([ceilingX, 122, DESK_Z + 28]);
  const [vaultLampX, vaultLampY] = isoProject([ceilingX, 92, 92]);
  const [vaultWheelX, vaultWheelY] = isoProject([236, 95, 54]);
  const [demoFocusX, demoFocusY] = isoProject([184, 338, DESK_Z + 8]);
  const [resetFocusX, resetFocusY] = isoProject([362, 338, DESK_Z + 7]);

  const budgetX = unitsToLeverWorldX(String(mandate.budget));
  const capX = unitsToLeverWorldX(String(mandate.perPaymentCap));

  return (
    <svg
      ref={svgRef}
      viewBox="-385 -48 795 492"
      role="group"
      aria-label="Isometric guardian control desk with three sliding policy levers in front of the escrow vault and its 1.25 USDC deposit ceiling bar"
      className="w-full h-auto block select-none"
      style={{ overflow: "visible", touchAction: "pan-y" }}
    >
      <defs>
        <radialGradient id="guardian-floor-glow" cx="52%" cy="48%" r="58%">
          <stop offset="0" stopColor="var(--bp-pass)" stopOpacity="0.11" />
          <stop offset="1" stopColor="var(--bp-pass)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 1. Isometric blueprint ground plate */}
      <IsoGround w={464} d={386} color="#091a3a" cell={40} />
      <ellipse
        cx={isoProject([232, 193, 0])[0]}
        cy={isoProject([232, 193, 0])[1]}
        rx={350}
        ry={168}
        fill="url(#guardian-floor-glow)"
      />

      {/* 2. Contact shadows */}
      <IsoShadow x={188} y={10} w={172} d={84} />
      <IsoShadow x={26} y={118} w={418} d={252} />

      {/* 3. Standing Escrow Vault behind the desk */}
      <g>
        <IsoBox x={188} y={10} z={0} w={172} d={84} h={108} color={VAULT} />
        <IsoBox
          x={196}
          y={18}
          z={108}
          w={156}
          d={68}
          h={8}
          color={STEEL}
          edge="var(--bp-line-strong)"
        />
        <Rivets x={196} y={18} z={116} w={156} d={68} />

        {/* Vault door plate & brass locking wheel */}
        <IsoBox x={208} y={91} z={16} w={56} d={4} h={74} color={NAVY_RAISED} edge={STEEL} />
        <circle cx={vaultWheelX} cy={vaultWheelY} r={12} fill="none" stroke={BRASS} strokeWidth={2} />
        <circle cx={vaultWheelX} cy={vaultWheelY} r={3.5} fill={BRASS} />
        {[0, 60, 120].map((deg) => {
          const rad = (deg * Math.PI) / 180;
          return (
            <line
              key={deg}
              x1={vaultWheelX - Math.cos(rad) * 11}
              y1={vaultWheelY - Math.sin(rad) * 7}
              x2={vaultWheelX + Math.cos(rad) * 11}
              y2={vaultWheelY + Math.sin(rad) * 7}
              stroke={BRASS}
              strokeWidth={1.5}
            />
          );
        })}

        {/* Vault reserve gauge tower (0 .. 1.50 scale, filled to 1.25 deposit) */}
        <IsoBox x={282} y={91} z={14} w={54} d={5} h={84} color="#060f1e" edge="var(--bp-line-strong)" />
        <IsoBox
          x={286}
          y={92}
          z={16}
          w={22}
          d={5}
          h={Math.max(4, 80 * depositRatio)}
          color={PASS}
        />
        <IsoBox
          x={310}
          y={92}
          z={16}
          w={22}
          d={5}
          h={Math.max(3, 80 * Math.min(budgetRatio, depositRatio))}
          color={STEEL}
        />

        {/* Thin rose-steel Deposit Ceiling Bar across the Vault at 1.25 USDC + Lamp */}
        <IsoBox
          x={192}
          y={90}
          z={16 + 80 * depositRatio}
          w={166}
          d={8}
          h={3.5}
          color={ROSE_STEEL}
          edge={REJECT}
        />
        <g
          className={`${styles.lampGlow} ${ceilingFault && animate ? styles.faultBeacon : ""}`}
          style={{ color: REJECT }}
          opacity={ceilingFault ? 1 : 0.85}
        >
          <circle cx={vaultLampX} cy={vaultLampY} r={5.5} fill={REJECT} />
          <circle cx={vaultLampX} cy={vaultLampY} r={2.2} fill={PAPER} />
        </g>

      </g>

      {/* Callout: deposit ceiling bar (short leader, clear of the vault lid) */}
      {(() => {
        const [bx, by] = isoProject([358, 94, 16 + 80 * depositRatio + 2]);
        const label = `CEILING ${depositLabel}`;
        const w = label.length * 8.6 + 16;
        const tx = bx + 52;
        const ty = by - 34;
        return (
          <g style={{ pointerEvents: "none" }}>
            <polyline
              points={`${bx},${by} ${tx - 2},${ty + 10} `}
              fill="none"
              stroke={REJECT}
              strokeWidth={1.3}
            />
            <circle cx={bx} cy={by} r={2.6} fill={REJECT} />
            <rect x={tx} y={ty - 6} width={w} height={22} rx={2} fill="#2b1216" stroke={REJECT} strokeWidth={1.2} />
            <text
              x={tx + 8}
              y={ty + 9.5}
              fontFamily="var(--font-geist-mono), ui-monospace, monospace"
              fontSize={13}
              fontWeight={700}
              fill={REJECT}
              letterSpacing="0.04em"
            >
              {label}
            </text>
          </g>
        );
      })()}

      {/* 4. Armored cables from Vault to Control Desk */}
      <IsoLine
        points={[
          [235, 94, 8],
          [235, 122, 8],
        ]}
        stroke={PASS}
        strokeWidth={2.2}
        opacity={0.75}
      />
      <IsoLine
        points={[
          [ceilingX, 94, 16 + 80 * depositRatio],
          [ceilingX, 122, DESK_Z + 18],
        ]}
        stroke={REJECT}
        strokeWidth={1.8}
        strokeDasharray="5 4"
        opacity={0.85}
      />

      {/* 5. Isometric Control Desk chassis + chamfered steel top console */}
      <g>
        <IsoBox x={26} y={118} z={0} w={418} d={252} h={DESK_Z - 4} color={NAVY} edge="var(--bp-line-strong)" />
        <IsoBox
          x={32}
          y={124}
          z={DESK_Z - 4}
          w={406}
          d={240}
          h={4}
          color={NAVY_RAISED}
          edge={STEEL}
        />
        <Rivets x={32} y={124} z={DESK_Z} w={406} d={240} />
      </g>

      {/* 6. Deposit Ceiling Limit Bar across the desk rails at 1.25 USDC + Beacon Lamp */}
      <g>
        <IsoBox
          x={ceilingX - 1.8}
          y={124}
          z={DESK_Z}
          w={3.6}
          d={180}
          h={4.5}
          color={ROSE_STEEL}
          edge={REJECT}
        />
        <IsoBox x={ceilingX - 5} y={120} z={DESK_Z} w={10} d={10} h={18} color={STEEL} />
        <IsoCylinder x={ceilingX} y={125} z={DESK_Z + 18} r={4.5} h={6} color={REJECT} />
        <g
          className={`${styles.lampGlow} ${ceilingFault && animate ? styles.faultBeacon : ""}`}
          style={{ color: REJECT }}
          opacity={ceilingFault ? 1 : 0.85}
        >
          <circle cx={ceilLampX} cy={ceilLampY} r={6} fill={REJECT} />
        </g>
      </g>

      {/* Mechanical interlock guide lines showing Cap <= Budget and Threshold <= Cap */}
      <IsoLine
        points={[
          [budgetX, rowYs[0] + 22, DESK_Z + 2],
          [budgetX, rowYs[1] + 2, DESK_Z + 2],
        ]}
        stroke={STEEL}
        strokeWidth={1.3}
        strokeDasharray="3 4"
        opacity={0.65}
      />
      <IsoLine
        points={[
          [capX, rowYs[1] + 22, DESK_Z + 2],
          [capX, rowYs[2] + 2, DESK_Z + 2],
        ]}
        stroke={STEEL}
        strokeWidth={1.3}
        strokeDasharray="3 4"
        opacity={0.65}
      />

      {/* 7. Three Lever Tracks: Tighten Key, Recessed Rail, Sliding 3D Lever, Loosen Key, and Plaque */}
      {levers.map((lever, idx) => {
        const rowY = rowYs[idx];
        const rawUnits = String(mandate[lever.key]);
        const usdcStr = formatUsdc6(rawUnits);
        const usdcNum = Number(usdcStr);
        const stepStr = formatUsdc6(String(lever.stepUnits));
        const leverX = unitsToLeverWorldX(rawUnits);
        const activeWidth = Math.max(3, leverX - RAIL_START_X);
        const rejectCode = rejections[lever.key];
        const isShaking = shaking[lever.key];

        // Screen offset for smooth CSS transform along isometric +x rail
        const [baseSx, baseSy] = isoProject([RAIL_START_X, rowY, DESK_Z]);
        const [curSx, curSy] = isoProject([leverX, rowY, DESK_Z]);
        const dxScreen = curSx - baseSx;
        const dyScreen = curSy - baseSy;

        const [tightFocusX, tightFocusY] = isoProject([57, rowY + 12, DESK_Z + 9]);
        const [looseFocusX, looseFocusY] = isoProject([384, rowY + 12, DESK_Z + 9]);
        const [leverFocusX, leverFocusY] = isoProject([RAIL_START_X, rowY + 12, DESK_Z + 22]);
        const [anchorX, anchorY] = isoProject([40, rowY + 12, DESK_Z + 5]);

        // Disjoint plaque coordinates to the upper-left of each rail
        const plaqueRight = anchorX - 56;
        const plaqueWidth = 196;
        const plaqueLeft = plaqueRight - plaqueWidth;
        const plaqueTop = 30 + idx * 54;

        return (
          <g key={lever.key}>
            {/* Engraved Plaque + Indicator Lamp + Real Rejection Code */}
            <line
              x1={plaqueRight}
              y1={plaqueTop + 15}
              x2={anchorX}
              y2={anchorY}
              stroke={rejectCode ? REJECT : BRASS}
              strokeWidth={1.3}
              opacity={0.75}
            />
            <g transform={`translate(${plaqueLeft}, ${plaqueTop})`}>
              <rect
                x={0}
                y={0}
                width={plaqueWidth}
                height={30}
                rx={2}
                fill={NAVY}
                stroke={rejectCode ? REJECT : BRASS}
                strokeWidth={rejectCode ? 1.5 : 1}
              />
              <circle cx={5} cy={5} r={1.3} fill={BRASS} />
              <circle cx={plaqueWidth - 5} cy={5} r={1.3} fill={BRASS} />
              <circle
                cx={14}
                cy={15}
                r={4.5}
                fill={rejectCode ? REJECT : PASS}
                className={styles.lampGlow}
                style={{ color: rejectCode ? REJECT : PASS }}
              />
              <text
                x={25}
                y={19}
                fontFamily="var(--font-geist-mono), ui-monospace, monospace"
                fontSize={13}
                fontWeight={600}
                fill={PAPER}
              >
                {lever.shortLabel}
              </text>
              <text
                x={plaqueWidth - 10}
                y={19}
                textAnchor="end"
                fontFamily="var(--font-geist-mono), ui-monospace, monospace"
                fontSize={13}
                fontWeight={700}
                fill={rejectCode ? REJECT : PASS}
              >
                {usdcStr}
              </text>
              {rejectCode && (
                <g transform={`translate(0, -21)`}>
                  <rect
                    x={0}
                    y={0}
                    width={Math.max(plaqueWidth, rejectCode.length * 8.2 + 16)}
                    height={19}
                    rx={2}
                    fill="#2b1216"
                    stroke={REJECT}
                    strokeWidth={1.2}
                  />
                  <text
                    x={7}
                    y={13.5}
                    fontFamily="var(--font-geist-mono), ui-monospace, monospace"
                    fontSize={13}
                    fontWeight={700}
                    fill={REJECT}
                  >
                    {rejectCode}
                  </text>
                </g>
              )}
            </g>

            {/* Physical Tighten Arrow Button on Desk (-step) */}
            <g
              role="button"
              tabIndex={0}
              aria-label={`Tighten ${lever.label} by ${stepStr} USDC`}
              onClick={() => onStep(lever.key, "tighten")}
              onKeyDown={activateOnKey(() => onStep(lever.key, "tighten"))}
              className={`${styles.deskButton} ${styles.focusTarget}`}
            >
              <IsoBox x={40} y={rowY - 2} z={DESK_Z} w={34} d={28} h={9} color={STEEL} />
              <IsoBox
                x={43}
                y={rowY + 1}
                z={DESK_Z + 9}
                w={28}
                d={22}
                h={2}
                color={tone(STEEL).top}
              />
              <IsoText x={57} y={rowY + 13} z={DESK_Z + 13} text="◀" size={13} fill={NAVY} weight={700} />
              <circle
                cx={tightFocusX}
                cy={tightFocusY}
                r={22}
                fill="none"
                stroke={PASS}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
              />
            </g>

            {/* Recessed Lever Rail Slot + Active Fill + Forbidden Unbacked Tail */}
            <g
              onPointerDown={(e) => handleRailPointerDown(lever.key, rowY, lever.stepUnits, e)}
              onPointerMove={(e) => handleRailPointerMove(lever.key, rowY, lever.stepUnits, e)}
              onPointerUp={() => handleRailPointerEnd(lever.key)}
              onPointerCancel={() => handleRailPointerEnd(lever.key)}
              style={{ cursor: "pointer" }}
            >
              <IsoBox
                x={RAIL_START_X}
                y={rowY + 3}
                z={DESK_Z}
                w={RAIL_SPAN_X}
                d={18}
                h={3}
                color="#060e1d"
                edge="var(--bp-line-strong)"
              />
              {/* Unbacked forbidden zone past 1.25 USDC */}
              <IsoBox
                x={ceilingX}
                y={rowY + 4}
                z={DESK_Z + 3}
                w={RAIL_START_X + RAIL_SPAN_X - ceilingX}
                d={16}
                h={1.2}
                color="#3b1720"
                edge={REJECT}
              />
              {/* Active policy fill bar */}
              <IsoBox
                x={RAIL_START_X}
                y={rowY + 5}
                z={DESK_Z + 3}
                w={activeWidth}
                d={14}
                h={2.4}
                color={rejectCode ? REJECT : PASS}
              />
            </g>

            {/* Sliding 3D Physical Lever Handle (role="slider") */}
            <g
              role="slider"
              tabIndex={0}
              aria-label={`${lever.label} lever`}
              aria-valuemin={0}
              aria-valuemax={Number(formatUsdc6(String(SCALE_MAX_UNITS)))}
              aria-valuenow={usdcNum}
              aria-valuetext={`${usdcStr} USDC (${lever.boundRule})${rejectCode ? `, rejected with ${rejectCode}` : ""}`}
              onKeyDown={(e) => handleSliderKeyDown(lever, e)}
              onPointerDown={(e) => handleRailPointerDown(lever.key, rowY, lever.stepUnits, e)}
              onPointerMove={(e) => handleRailPointerMove(lever.key, rowY, lever.stepUnits, e)}
              onPointerUp={() => handleRailPointerEnd(lever.key)}
              onPointerCancel={() => handleRailPointerEnd(lever.key)}
              className={`${animate ? styles.leverCarriage : styles.leverStill} ${styles.focusTarget}`}
              style={{ transform: `translate(${dxScreen.toFixed(2)}px, ${dyScreen.toFixed(2)}px)` }}
            >
              <g className={isShaking && animate ? styles.slam : undefined}>
                {/* Carriage block */}
                <IsoBox
                  x={RAIL_START_X - 11}
                  y={rowY}
                  z={DESK_Z + 4}
                  w={22}
                  d={24}
                  h={9}
                  color={rejectCode ? REJECT : STEEL}
                  edge={BRASS}
                />
                {/* Vertical lever stalk */}
                <IsoBox
                  x={RAIL_START_X - 4}
                  y={rowY + 7}
                  z={DESK_Z + 13}
                  w={8}
                  d={10}
                  h={13}
                  color={NAVY_RAISED}
                  edge={STEEL}
                />
                {/* Wide T-bar grip */}
                <IsoBox
                  x={RAIL_START_X - 9}
                  y={rowY - 2}
                  z={DESK_Z + 26}
                  w={18}
                  d={28}
                  h={7}
                  color={rejectCode ? REJECT : BRASS}
                  edge={PAPER}
                />
                <circle
                  cx={leverFocusX}
                  cy={leverFocusY}
                  r={26}
                  fill="none"
                  stroke={PASS}
                  strokeWidth={2.2}
                  vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
                />
              </g>
            </g>

            {/* Physical Loosen Arrow Button on Desk (+step) */}
            <g
              role="button"
              tabIndex={0}
              aria-label={`Loosen ${lever.label} by ${stepStr} USDC`}
              onClick={() => onStep(lever.key, "loosen")}
              onKeyDown={activateOnKey(() => onStep(lever.key, "loosen"))}
              className={`${styles.deskButton} ${styles.focusTarget}`}
            >
              <IsoBox x={367} y={rowY - 2} z={DESK_Z} w={34} d={28} h={9} color={STEEL} />
              <IsoBox
                x={370}
                y={rowY + 1}
                z={DESK_Z + 9}
                w={28}
                d={22}
                h={2}
                color={tone(STEEL).top}
              />
              <IsoText x={384} y={rowY + 13} z={DESK_Z + 13} text="▶" size={13} fill={NAVY} weight={700} />
              <circle
                cx={looseFocusX}
                cy={looseFocusY}
                r={22}
                fill="none"
                stroke={PASS}
                strokeWidth={2}
                vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
              />
            </g>
          </g>
        );
      })}

      {/* 8. Big Red Actuator Button on the Desk: "Try to loosen past the deposit" */}
      <g
        role="button"
        tabIndex={0}
        aria-label="Try to loosen past the deposit"
        onClick={onDemoViolation}
        onKeyDown={activateOnKey(onDemoViolation)}
        className={`${styles.deskButton} ${styles.focusTarget}`}
      >
        {/* Brass warning bezel */}
        <IsoBox x={58} y={320} z={DESK_Z} w={252} d={36} h={4} color={BRASS} />
        {/* Raised coral-red physical push bar */}
        <IsoBox x={64} y={324} z={DESK_Z + 4} w={240} d={28} h={10} color="#ff6b4a" edge={PAPER} />
        <IsoText
          x={184}
          y={341}
          z={DESK_Z + 15}
          flat
          text="LOOSEN PAST DEPOSIT"
          size={14}
          fill="#070d1a"
          weight={700}
        />
        <ellipse
          cx={demoFocusX}
          cy={demoFocusY}
          rx={118}
          ry={34}
          fill="none"
          stroke={PAPER}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
        />
      </g>

      {/* 9. Steel Reset Push-Button on the Desk */}
      <g
        role="button"
        tabIndex={0}
        aria-label="Reset mandate levers to initial values"
        onClick={onReset}
        onKeyDown={activateOnKey(onReset)}
        className={`${styles.deskButton} ${styles.focusTarget}`}
      >
        <IsoBox x={324} y={322} z={DESK_Z} w={78} d={32} h={8} color={STEEL} edge={PAPER} />
        <IsoText
          x={363}
          y={341}
          z={DESK_Z + 9}
          flat
          text="RESET"
          size={13}
          fill={NAVY}
          weight={700}
        />
        <ellipse
          cx={resetFocusX}
          cy={resetFocusY}
          rx={44}
          ry={22}
          fill="none"
          stroke={PASS}
          strokeWidth={2}
          vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
        />
      </g>
    </svg>
  );
}
