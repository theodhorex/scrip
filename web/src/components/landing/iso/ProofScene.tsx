"use client";

import type { KeyboardEvent } from "react";
import type { ProofLandingData } from "@/lib/proof-data";
import {
  IsoBox,
  IsoCylinder,
  IsoGround,
  IsoLine,
  IsoShadow,
  isoProject,
  tone,
} from "./Iso";
import styles from "./ProofScene.module.css";

export const DRAWER_BASE_Z = 14;
export const DRAWER_PITCH_Z = 28;
export const DRAWER_SLIDE_UNITS = 38;

const COS_30 = Math.cos(Math.PI / 6);
const SIN_30 = 0.5;

const STEEL = "#8fa3c4";
const VAULT = "#1f4fd8";
const NAVY = "#0c1527";
const NAVY_RAISED = "#14223d";
const PAPER = "#e8eef7";
const BRASS = "#c9a24a";
const PASS = "var(--bp-pass)";
const REJECT = "var(--bp-reject)";

/** Pure helper: returns world Z base of drawer `index` (0 = top drawer, N-1 = bottom). */
export function drawerWorldZ(
  index: number,
  totalDrawers = 7,
  baseZ = DRAWER_BASE_Z,
  pitchZ = DRAWER_PITCH_Z,
): number {
  return baseZ + Math.max(0, totalDrawers - 1 - index) * pitchZ;
}

/** Pure helper: returns 2D SVG screen [dx, dy] offset when a drawer slides along +x. */
export function drawerSlideScreenOffset(
  isOpen: boolean,
  slideUnits = DRAWER_SLIDE_UNITS,
): [number, number] {
  if (!isOpen) return [0, 0];
  return [slideUnits * COS_30, slideUnits * SIN_30];
}

/**
 * Pure helper: determines automatic initial open drawer index.
 * Under `prefers-reduced-motion`, all drawers stay closed until opened manually.
 */
export function initialOpenDrawer(
  prefersReducedMotion: boolean,
  hasEntered: boolean,
): number | null {
  if (prefersReducedMotion || !hasEntered) return null;
  return 0;
}

type Props = {
  data: ProofLandingData;
  openDrawerIndex: number | null;
  selectedAttackIndex: number | null;
  isVisible: boolean;
  prefersReducedMotion: boolean;
  receiptPanelId: string;
  onToggleDrawer: (index: number) => void;
  onSelectAttack: (index: number) => void;
};

function Rivets({ x, y, z, w, d }: { x: number; y: number; z: number; w: number; d: number }) {
  const spots: Array<[number, number]> = [
    [x + 5, y + 5],
    [x + w - 5, y + 5],
    [x + 5, y + d - 5],
    [x + w - 5, y + d - 5],
  ];
  return (
    <g aria-hidden="true">
      {spots.map(([px, py], i) => {
        const [cx, cy] = isoProject([px, py, z]);
        return <circle key={i} cx={cx} cy={cy} r={1.6} fill={BRASS} />;
      })}
    </g>
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

function quadPoints(pts: Array<[number, number, number]>): string {
  return pts
    .map((p) =>
      isoProject(p)
        .map((n) => n.toFixed(1))
        .join(","),
    )
    .join(" ");
}

export function ProofScene({
  data,
  openDrawerIndex,
  selectedAttackIndex,
  isVisible,
  prefersReducedMotion,
  receiptPanelId,
  onToggleDrawer,
  onSelectAttack,
}: Props) {
  const totalDrawers = data.steps.length;
  const cabinetTopZ = DRAWER_BASE_Z + totalDrawers * DRAWER_PITCH_Z + 4;

  const staggerClass = prefersReducedMotion
    ? styles.staggerInstant
    : isVisible
      ? styles.staggerShown
      : styles.staggerHidden;

  // Painter's order indices for 3D drawer meshes: bottom (N-1) up to top (0)
  const bottomUpIndices = Array.from({ length: totalDrawers }, (_, i) => totalDrawers - 1 - i);

  const [cabLampX, cabLampY] = isoProject([92, 190, cabinetTopZ + 18]);
  const [rackLampX, rackLampY] = isoProject([315, 28, 174]);
  const [exitLampX, exitLampY] = isoProject([276, 250, 48]);

  const cleanVerified = data.cleanup.funderBalanced && data.cleanup.contractDrained && data.cleanup.leftoverCount === 0;

  return (
    <svg
      viewBox="-398 -140 796 562"
      role="group"
      aria-label={`Isometric ${data.network} proof archive: ${data.steps.length}-drawer receipt cabinet on the left, ${data.attacks.length} refused attack cards on the right, and clean exit lockbox in front`}
      className="w-full h-auto block select-none"
      style={{ overflow: "visible" }}
    >
      <defs>
        <radialGradient id="proof-floor-glow" cx="48%" cy="50%" r="58%">
          <stop offset="0" stopColor="var(--bp-pass)" stopOpacity="0.10" />
          <stop offset="1" stopColor="var(--bp-pass)" stopOpacity="0" />
        </radialGradient>
      </defs>

      {/* 1. Isometric floor plate */}
      <IsoGround w={436} d={356} color="#091a3a" cell={40} />
      <ellipse
        cx={isoProject([218, 178, 0])[0]}
        cy={isoProject([218, 178, 0])[1]}
        rx={340}
        ry={165}
        fill="url(#proof-floor-glow)"
      />

      {/* 2. Contact shadows */}
      <IsoShadow x={34} y={136} w={118} d={112} />
      <IsoShadow x={230} y={20} w={172} d={118} />
      <IsoShadow x={252} y={226} w={142} d={98} />

      {/* 3. Armored audit conduit connecting Cabinet -> Clean Exit Lockbox */}
      <IsoLine
        points={[
          [148, 232, 8],
          [214, 232, 8],
          [214, 274, 8],
          [252, 274, 8],
        ]}
        stroke={PASS}
        strokeWidth={2}
        opacity={0.72}
      />

      {/* ===================================================================== */}
      {/* ASSEMBLY A (LEFT): 7-Drawer Isometric Archive Cabinet                 */}
      {/* ===================================================================== */}
      <g>
        {/* Outer cabinet shell */}
        <IsoBox
          x={34}
          y={136}
          z={0}
          w={112}
          d={112}
          h={cabinetTopZ}
          color={NAVY}
          edge="var(--bp-line-strong)"
        />
        {/* Plinth base */}
        <IsoBox x={32} y={134} z={0} w={118} d={116} h={10} color={STEEL} />

        {/* 7 sliding 3D drawer meshes rendered bottom-to-top for true isometric occlusion */}
        {bottomUpIndices.map((idx) => {
          const step = data.steps[idx];
          const dz = drawerWorldZ(idx, totalDrawers);
          const isOpen = openDrawerIndex === idx;
          const [dx, dy] = drawerSlideScreenOffset(isOpen);
          const [ledX, ledY] = isoProject([151, 154, dz + 12]);

          return (
            <g
              key={step.key}
              aria-hidden="true"
              className={prefersReducedMotion ? styles.drawerStill : styles.drawerSlide}
              style={{ transform: `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)` }}
            >
              {/* Drawer body */}
              <IsoBox
                x={40}
                y={141}
                z={dz}
                w={110}
                d={102}
                h={23}
                color={isOpen ? VAULT : NAVY_RAISED}
                edge={isOpen ? PASS : STEEL}
              />

              {/* Open drawer interior & emerging paper receipt card */}
              {isOpen && (
                <g>
                  <IsoBox x={56} y={147} z={dz + 19} w={88} d={90} h={4.5} color="#060e1d" />
                  <IsoBox
                    x={124}
                    y={153}
                    z={dz + 15}
                    w={18}
                    d={78}
                    h={17}
                    color={PAPER}
                    edge={PASS}
                  />
                  <IsoBox x={125} y={155} z={dz + 32} w={16} d={74} h={2} color={PASS} />
                </g>
              )}

              {/* Brass pull handle on +x drawer front */}
              <IsoBox x={150} y={177} z={dz + 9} w={4.5} d={30} h={4.5} color={BRASS} />
              <circle
                cx={ledX}
                cy={ledY}
                r={3}
                fill={isOpen ? PASS : STEEL}
                className={isOpen ? styles.lampGlow : undefined}
                style={{ color: PASS }}
              />
            </g>
          );
        })}

        {/* Overhanging chamfered cabinet roof cap + telemetry beacon */}
        <IsoBox
          x={32}
          y={134}
          z={cabinetTopZ}
          w={120}
          d={116}
          h={8}
          color={STEEL}
          edge="var(--bp-line-strong)"
        />
        <Rivets x={32} y={134} z={cabinetTopZ + 8} w={120} d={116} />
        <IsoCylinder x={92} y={190} z={cabinetTopZ + 8} r={7} h={8} color={NAVY_RAISED} />
        <g className={styles.lampGlow} style={{ color: PASS }}>
          <circle cx={cabLampX} cy={cabLampY} r={5.5} fill={PASS} />
        </g>
        {(() => {
          const label = `${data.network.toUpperCase()} ARCHIVE`;
          const w = label.length * 8.6 + 18;
          const [lx, ly] = isoProject([92, 190, cabinetTopZ + 70]);
          return (
            <g style={{ pointerEvents: "none" }}>
              <line x1={lx} y1={ly + 12} x2={cabLampX} y2={cabLampY - 6} stroke={BRASS} strokeWidth={1.2} />
              <rect x={lx - w / 2} y={ly - 12} width={w} height={24} rx={2} fill={NAVY} stroke={BRASS} strokeWidth={1.2} />
              <text
                x={lx}
                y={ly + 5}
                textAnchor="middle"
                fontFamily="var(--font-geist-mono), ui-monospace, monospace"
                fontSize={13}
                fontWeight={700}
                fill={PAPER}
                letterSpacing="0.04em"
              >
                {label}
              </text>
            </g>
          );
        })()}
      </g>

      {/* ===================================================================== */}
      {/* ASSEMBLY B (RIGHT): "Refused attacks" Rack with 5 coral-stamped cards */}
      {/* ===================================================================== */}
      <g>
        {/* Heavy steel rack base & angled side stanchions */}
        <IsoBox
          x={230}
          y={20}
          z={0}
          w={172}
          d={118}
          h={16}
          color={NAVY}
          edge="var(--bp-line-strong)"
        />
        <IsoBox x={236} y={24} z={16} w={160} d={12} h={138} color={NAVY_RAISED} edge={STEEL} />
        <IsoBox x={234} y={24} z={16} w={10} d={108} h={18} color={STEEL} />
        <IsoBox x={388} y={24} z={16} w={10} d={108} h={18} color={STEEL} />
        <Rivets x={230} y={20} z={16} w={172} d={118} />

        {/* Rack header beacon & title */}
        <IsoCylinder x={315} y={28} z={154} r={6} h={7} color={REJECT} />
        <g className={styles.lampGlow} style={{ color: REJECT }}>
          <circle cx={rackLampX} cy={rackLampY - 10} r={5.5} fill={REJECT} />
        </g>
        {(() => {
          const label = `REFUSED ATTACKS (${data.attacks.length})`;
          const w = label.length * 8.6 + 18;
          const [tx, ty] = isoProject([316, 28, 206]);
          return (
            <g style={{ pointerEvents: "none" }}>
              <rect x={tx - w / 2} y={ty - 12} width={w} height={24} rx={2} fill="#241016" stroke={REJECT} strokeWidth={1.2} />
              <text
                x={tx}
                y={ty + 5}
                textAnchor="middle"
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

        {/* 5 Tiered Dossier Cards with Coral Stamps (rendered back-to-front: 0..4) */}
        {data.attacks.map((attack, i) => {
          const slotY = 34 + i * 21;
          const slotZ = 128 - i * 24;
          const isSelected = selectedAttackIndex === i;
          const [stampAnchorX, stampAnchorY] = isoProject([316, slotY + 4, slotZ + 28]);
          const stampWidth = 216;
          const delayMs = prefersReducedMotion ? 0 : 180 + i * 55;

          return (
            <g
              key={attack.key}
              role="button"
              tabIndex={0}
              aria-pressed={isSelected}
              aria-label={`Refused attack ${i + 1}: ${attack.label}, code ${attack.rejectionCode}, HTTP ${attack.httpStatus}`}
              onClick={() => onSelectAttack(i)}
              onKeyDown={activateOnKey(() => onSelectAttack(i))}
              className={`${staggerClass} ${styles.interactiveControl}`}
              style={{ transitionDelay: `${delayMs}ms` }}
            >
              {/* Physical paper dossier card slotted into rack */}
              <IsoBox
                x={248}
                y={slotY}
                z={slotZ}
                w={136}
                d={8}
                h={26}
                color={isSelected ? PAPER : "#cad6ea"}
                edge={REJECT}
              />
              {/* Coral stamp strip on top of card */}
              <g transform={`translate(${(stampAnchorX - stampWidth / 2).toFixed(1)}, ${(stampAnchorY - 14).toFixed(1)})`}>
                <rect
                  x={0}
                  y={0}
                  width={stampWidth}
                  height={23}
                  rx={2}
                  fill={isSelected ? "#3a1419" : "#241016"}
                  stroke={REJECT}
                  strokeWidth={isSelected ? 1.8 : 1.2}
                />
                <text
                  x={8}
                  y={15.5}
                  fontFamily="var(--font-geist-mono), ui-monospace, monospace"
                  fontSize={13}
                  fontWeight={700}
                  fill={REJECT}
                >
                  {attack.rejectionCode}
                </text>
                <rect
                  x={-3}
                  y={-3}
                  width={stampWidth + 6}
                  height={29}
                  rx={3}
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
      </g>

      {/* ===================================================================== */}
      {/* ASSEMBLY C (FRONT-RIGHT): "Clean exit" Sealed Lockbox                 */}
      {/* ===================================================================== */}
      <g
        className={staggerClass}
        style={{ transitionDelay: prefersReducedMotion ? "0ms" : "460ms" }}
      >
        <IsoBox
          x={252}
          y={226}
          z={0}
          w={142}
          d={98}
          h={34}
          color={NAVY_RAISED}
          edge={cleanVerified ? PASS : STEEL}
        />
        <IsoBox
          x={258}
          y={232}
          z={34}
          w={130}
          d={86}
          h={6}
          color={tone(STEEL).left}
          edge={PASS}
        />
        {/* Brass seal clasp on front */}
        <IsoBox x={312} y={322} z={16} w={22} d={5} h={16} color={BRASS} />
        <Rivets x={258} y={232} z={40} w={130} d={86} />
        <IsoCylinder x={276} y={250} z={40} r={5} h={5} color={PASS} />
        <g className={styles.lampGlow} style={{ color: PASS }}>
          <circle cx={exitLampX} cy={exitLampY - 4} r={5} fill={PASS} />
        </g>

        {/* Clean exit plaque placed in the open floor area, tied to the lockbox by a short leader */}
        <line x1={-52} y1={316} x2={-60} y2={276} stroke={PASS} strokeWidth={1.2} />
        <circle cx={-60} cy={276} r={2.6} fill={PASS} />
        <g transform="translate(-284, 316)">
          <rect
            x={0}
            y={0}
            width={232}
            height={58}
            rx={2}
            fill={NAVY}
            stroke={PASS}
            strokeWidth={1.2}
          />
          <text
            x={10}
            y={17}
            fontFamily="var(--font-geist-mono), ui-monospace, monospace"
            fontSize={13}
            fontWeight={700}
            fill={PASS}
          >
            CLEAN EXIT · LEFTOVER {data.cleanup.leftoverCount}
          </text>
          <text
            x={10}
            y={35}
            fontFamily="var(--font-geist-mono), ui-monospace, monospace"
            fontSize={13}
            fill={PAPER}
          >
            Funder {data.cleanup.funderUsdcBefore} → {data.cleanup.funderUsdcAfter} USDC
          </text>
          <text
            x={10}
            y={51}
            fontFamily="var(--font-geist-mono), ui-monospace, monospace"
            fontSize={13}
            fill="var(--bp-muted)"
          >
            Vault left: {data.cleanup.contractUsdcLeft} USDC
          </text>
        </g>
      </g>

      {/* ===================================================================== */}
      {/* INTERACTIVE DRAWER CONTROLS (DOM order 0..6 for natural Tab order)    */}
      {/* ===================================================================== */}
      {data.steps.map((step, idx) => {
        const dz = drawerWorldZ(idx, totalDrawers);
        const isOpen = openDrawerIndex === idx;
        const [dx, dy] = drawerSlideScreenOffset(isOpen);
        const [leftEdgeX, leftEdgeY] = isoProject([34, 246, dz + 12]);
        const plateWidth = 198;
        const plateHeight = 24;
        const plateX = -392;
        const plateY = leftEdgeY - plateHeight / 2;
        const delayMs = prefersReducedMotion ? 0 : idx * 50;

        // Projected +x front face of drawer for direct 3D drawer clicking
        const frontFace = quadPoints([
          [150, 141, dz],
          [150, 243, dz],
          [150, 243, dz + 23],
          [150, 141, dz + 23],
        ]);

        return (
          <g
            key={step.key}
            role="button"
            tabIndex={0}
            aria-expanded={isOpen}
            aria-controls={receiptPanelId}
            aria-label={`Drawer ${idx + 1}: ${step.label} (${step.shortHash})`}
            onClick={() => onToggleDrawer(idx)}
            onKeyDown={activateOnKey(() => onToggleDrawer(idx))}
            className={`${staggerClass} ${styles.interactiveControl}`}
            style={{ transitionDelay: `${delayMs}ms` }}
          >
            {/* Leader tick linking nameplate to its physical drawer */}
            <line
              x1={plateX + plateWidth}
              y1={leftEdgeY}
              x2={leftEdgeX}
              y2={leftEdgeY}
              stroke={isOpen ? PASS : BRASS}
              strokeWidth={isOpen ? 1.6 : 1}
              opacity={isOpen ? 0.95 : 0.55}
            />

            {/* Engraved drawer nameplate */}
            <rect
              x={plateX}
              y={plateY}
              width={plateWidth}
              height={plateHeight}
              rx={2}
              fill={isOpen ? "#10283f" : NAVY}
              stroke={isOpen ? PASS : "var(--bp-line-strong)"}
              strokeWidth={isOpen ? 1.5 : 1}
            />
            <text
              x={plateX + 8}
              y={plateY + 16}
              fontFamily="var(--font-geist-mono), ui-monospace, monospace"
              fontSize={13}
              fontWeight={700}
              fill={PASS}
            >
              {String(idx + 1).padStart(2, "0")}
            </text>
            <text
              x={plateX + 32}
              y={plateY + 16}
              fontFamily="var(--font-geist-mono), ui-monospace, monospace"
              fontSize={13}
              fontWeight={isOpen ? 700 : 500}
              fill={isOpen ? PAPER : "var(--bp-muted)"}
            >
              {step.label}
            </text>

            {/* Transparent hit target over the 3D drawer front face */}
            <polygon
              points={frontFace}
              fill="transparent"
              style={{ transform: `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px)` }}
            />

            {/* Keyboard focus outline */}
            <rect
              x={plateX - 3}
              y={plateY - 3}
              width={plateWidth + 6}
              height={plateHeight + 6}
              rx={3}
              fill="none"
              stroke={PASS}
              strokeWidth={2}
              vectorEffect="non-scaling-stroke"
          className={styles.focusRing}
            />
          </g>
        );
      })}
    </svg>
  );
}
