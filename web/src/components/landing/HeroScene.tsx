"use client";

import { useEffect, useRef, useState } from "react";
import type { LandingHeroDemoData } from "@/lib/landing-data";
import type { HeroStepDerived, GateVisualState } from "./hero-state";
import { IsoBox, IsoCylinder, IsoGround, IsoLine, IsoShadow, isoProject, tone } from "./iso/Iso";
import styles from "./HeroScene.module.css";

type Props = {
  data: LandingHeroDemoData;
  derived: HeroStepDerived;
  animate: boolean;
};

const STEEL = "#8fa3c4";
const VAULT = "#1f4fd8";
const NAVY = "#14223d";
const BRASS = "#c9a24a";
const PASS = "var(--bp-pass)";
const REJECT = "var(--bp-reject)";

// World layout: the lane runs along +x, the attacker branch along +y.
const LANE_Y = 70;
const AGENT_X = 150;
const GATE_X = [225, 295, 365] as const;
const MERCHANT_X = 455;
const ATTACKER_Y = 250;

function lamp(state: GateVisualState) {
  if (state === "pass") return PASS;
  if (state === "reject") return REJECT;
  return "#2a3a5c";
}

/** Where the coin sits in world space for each of the 8 story steps. */
function coinWorld(step: number): [number, number, number] {
  switch (step) {
    case 0: return [-30, 100, 46];
    case 1: return [75, 110, 96];
    case 2: return [GATE_X[0] - 6, LANE_Y + 40, 26];
    case 3: return [GATE_X[2] + 8, LANE_Y + 40, 26];
    case 4: return [MERCHANT_X + 22, LANE_Y + 30, 52];
    case 5: return [AGENT_X + 60, LANE_Y + 70, 24];
    default: return [GATE_X[0] - 24, LANE_Y + 40, 26];
  }
}


/** Route the coin follows when it arrives at a step (world points; last one equals coinWorld(step)). */
function coinRoute(step: number): { pts: Array<[number, number, number]>; fadeIn: boolean } {
  const L = LANE_Y + 40;
  switch (step) {
    case 0: return { pts: [coinWorld(0)], fadeIn: true };
    case 1: return { pts: [coinWorld(0), [20, 104, 88], coinWorld(1)], fadeIn: false };
    case 2: return { pts: [coinWorld(1), [AGENT_X + 18, LANE_Y + 30, 74], [AGENT_X + 40, L, 40], coinWorld(2)], fadeIn: false };
    case 3: return { pts: [coinWorld(2), [GATE_X[1], L, 26], coinWorld(3)], fadeIn: false };
    case 4: return { pts: [coinWorld(3), [MERCHANT_X - 14, LANE_Y + 36, 42], coinWorld(4)], fadeIn: false };
    case 5: return { pts: [coinWorld(5)], fadeIn: true };
    case 6: return { pts: [coinWorld(5), [GATE_X[0] - 40, L, 26], [GATE_X[0] - 10, L, 26], coinWorld(6)], fadeIn: false };
    default: return { pts: [coinWorld(6)], fadeIn: false };
  }
}

/** Eases a number toward its target over `ms` (requestAnimationFrame), so bars and totals slide instead of jumping. */
function useTween(target: number, ms: number, enabled: boolean) {
  const [value, setValue] = useState(target);
  const from = useRef(target);
  useEffect(() => {
    if (!enabled) {
      from.current = target;
      return;
    }
    const start = performance.now();
    const origin = from.current;
    let raf = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - start) / ms);
      const eased = t < 0.5 ? 2 * t * t : 1 - Math.pow(-2 * t + 2, 2) / 2;
      const v = origin + (target - origin) * eased;
      from.current = v;
      setValue(v);
      if (t < 1) raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
  }, [target, ms, enabled]);
  return enabled ? value : target;
}

function VaultGauge({ ratio, animate }: { ratio: number; animate: boolean }) {
  const r = useTween(Math.max(0.04, ratio), 1100, animate);
  return (
    <g>
      <IsoBox x={96} y={150} z={10} w={30} d={4} h={60} color="#06101f" edge="var(--bp-line-strong)" />
      <IsoBox x={98} y={152} z={12} w={26} d={4} h={Math.max(1, 56 * r)} color="var(--bp-pass)" />
    </g>
  );
}

function Coin({ step, animate, color, label }: { step: number; animate: boolean; color: string; label: string }) {
  const ref = useRef<SVGGElement>(null);
  const first = useRef(true);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const { pts, fadeIn } = coinRoute(step);
    const screen = pts.map((p) => isoProject(p));
    const end = screen[screen.length - 1];
    const place = () => {
      el.style.transform = `translate(${end[0]}px, ${end[1]}px)`;
      el.style.opacity = "1";
    };
    if (!animate || first.current || typeof el.animate !== "function") {
      first.current = false;
      place();
      return;
    }
    if (screen.length === 1 && !fadeIn) {
      place();
      return;
    }
    const n = Math.max(1, screen.length - 1);
    const ease = "cubic-bezier(0.45, 0, 0.2, 1)";
    const frames: Keyframe[] = fadeIn
      ? [
          { transform: `translate(${end[0]}px, ${end[1] - 14}px)`, opacity: 0, offset: 0, easing: ease },
          { transform: `translate(${end[0]}px, ${end[1]}px)`, opacity: 1, offset: 1 },
        ]
      : screen.map((p, i) => ({ transform: `translate(${p[0]}px, ${p[1]}px)`, opacity: 1, offset: i / n, easing: ease }));
    const anim = el.animate(frames, { duration: fadeIn ? 700 : 1500, fill: "both" });
    anim.onfinish = () => {
      place();
      anim.cancel();
    };
    return () => anim.cancel();
  }, [step, animate]);
  return (
    <g ref={ref} style={{ opacity: 0 }}>
      <ellipse cx={0} cy={9} rx={11} ry={5} fill="#000" opacity={0.3} />
      <IsoCylinder x={0} y={0} z={0} r={9} h={6} color={color === PASS ? "#2dd4bf" : "#ff6b4a"} />
      <text x={0} y={-12} textAnchor="middle" fontFamily="var(--font-geist-mono), monospace" fontSize={12} fill={color}>
        {label}
      </text>
    </g>
  );
}

function Label({ x, y, z = 0, text, anchor = "middle", size = 13, fill = "var(--bp-muted)" }: { x: number; y: number; z?: number; text: string; anchor?: "start" | "middle" | "end"; size?: number; fill?: string }) {
  const [sx, sy] = isoProject([x, y, z]);
  return (
    <text x={sx} y={sy} textAnchor={anchor} fontFamily="var(--font-geist-mono), monospace" fontSize={size} fill={fill} letterSpacing="0.06em">
      {text}
    </text>
  );
}

function Rivets({ x, y, z, w, d }: { x: number; y: number; z: number; w: number; d: number }) {
  const spots: Array<[number, number]> = [[x + 4, y + 4], [x + w - 4, y + 4], [x + 4, y + d - 4], [x + w - 4, y + d - 4]];
  return (
    <g>
      {spots.map(([px, py], i) => {
        const [cx, cy] = isoProject([px, py, z]);
        return <circle key={i} cx={cx} cy={cy} r={1.6} fill={BRASS} />;
      })}
    </g>
  );
}

function Gate({ gx, state, label, index }: { gx: number; state: GateVisualState; label: string; index: number }) {
  const color = lamp(state);
  const y0 = LANE_Y - 40;
  return (
    <g>
      <IsoShadow x={gx} y={y0} w={12} d={90} />
      <IsoBox x={gx} y={y0} z={0} w={12} d={12} h={62} color={STEEL} />
      <IsoBox x={gx} y={y0 + 78} z={0} w={12} d={12} h={62} color={STEEL} />
      <IsoBox x={gx - 1} y={y0} z={62} w={14} d={90} h={12} color={NAVY} edge="var(--bp-line-strong)" />
      <IsoBox x={gx + 2} y={y0 + 40} z={74} w={8} d={10} h={7} color={color} />
      <g className={state === "idle" ? undefined : styles.lampGlow} style={{ color }} opacity={state === "idle" ? 0.35 : 0.9}>
        <circle cx={isoProject([gx + 6, y0 + 45, 86])[0]} cy={isoProject([gx + 6, y0 + 45, 86])[1]} r={6} fill={color} />
      </g>
      <Rivets x={gx - 1} y={y0} z={74} w={14} d={90} />
      <Label x={gx + 6} y={y0 + 45} z={104} text={`0${index + 1}`} size={15} fill={state === "reject" ? REJECT : state === "pass" ? PASS : "var(--bp-muted)"} />
      <title>{label}</title>
    </g>
  );
}

export function HeroScene({ data, derived, animate }: Props) {
  const coinColor = derived.packet.tone === "reject" ? REJECT : PASS;
  const hijacked = derived.agentHijacked;
  const eye = hijacked ? REJECT : PASS;
  const fill = Math.max(0.04, derived.vaultFilledRatio);
  const [sparkX, sparkY] = isoProject([GATE_X[0] + 6, LANE_Y + 5, 44]);
  const [bx, by] = isoProject([GATE_X[0] - 20, LANE_Y - 70, 100]);
  const [px, py] = isoProject([AGENT_X - 10, LANE_Y - 60, 120]);

  return (
    <svg viewBox="-300 -170 800 640" role="img" aria-label="Isometric scene: owner funds the vault, an agent pays through three policy gates; an injected payment is stopped at the recipient gate" className="w-full h-auto block" style={{ overflow: "visible" }}>
      <defs>
        <radialGradient id="hero-floor-glow" cx="50%" cy="50%" r="60%">
          <stop offset="0" stopColor="var(--bp-pass)" stopOpacity="0.10" />
          <stop offset="1" stopColor="var(--bp-pass)" stopOpacity="0" />
        </radialGradient>
      </defs>

      <g transform="translate(-20,0)" className={styles.scene}>
        <IsoGround w={560} d={330} color="#08224f" cell={40} />
        <ellipse cx={isoProject([260, 145, 0])[0]} cy={isoProject([260, 145, 0])[1]} rx={360} ry={170} fill="url(#hero-floor-glow)" className={animate ? styles.breathe : undefined} />

        {/* Conveyor lane */}
        <IsoBox x={105} y={LANE_Y + 18} z={0} w={360} d={44} h={4} color="#1a2b4d" edge="var(--bp-line-strong)" />
        <IsoLine points={[[110, LANE_Y + 40, 4.5], [460, LANE_Y + 40, 4.5]]} stroke="var(--bp-line-strong)" strokeWidth={1.2} strokeDasharray="6 7" />

        {/* Attacker branch (dashed coral cable) */}
        <IsoLine points={[[AGENT_X + 20, LANE_Y + 62, 4.5], [AGENT_X + 20, ATTACKER_Y + 28, 4.5], [MERCHANT_X - 6, ATTACKER_Y + 28, 4.5]]} stroke={REJECT} strokeWidth={1.4} strokeDasharray="4 6" opacity={hijacked ? 0.9 : 0.25} />

        {/* Owner console + cable to vault */}
        <IsoShadow x={-50} y={80} w={52} d={52} />
        <IsoBox x={-50} y={80} z={0} w={52} d={52} h={30} color={NAVY} edge="var(--bp-line-strong)" />
        <IsoBox x={-44} y={86} z={30} w={40} d={40} h={6} color={STEEL} />
        <IsoCylinder x={-24} y={106} z={36} r={9} h={8} color={BRASS} />
        <Rivets x={-50} y={80} z={30} w={52} d={52} />
        <Label x={-24} y={164} text="OWNER" size={13} />
        <IsoLine points={[[2, 106, 6], [46, 106, 6]]} stroke={PASS} strokeWidth={1.6} opacity={0.7} />

        {/* Vault */}
        <IsoShadow x={46} y={50} w={96} d={96} />
        <IsoBox x={46} y={50} z={0} w={96} d={96} h={84} color={VAULT} />
        <IsoBox x={52} y={56} z={84} w={84} d={84} h={7} color={tone(VAULT).top} edge="var(--bp-line-strong)" />
        <IsoBox x={74} y={78} z={91} w={40} d={40} h={2} color="#06101f" glow={0.0} />
        <Rivets x={46} y={50} z={84} w={96} d={96} />
        {/* Reserve gauge on the vault's front-left face */}
        <VaultGauge ratio={fill} animate={animate} />
        <Label x={94} y={98} z={150} text="VAULT" size={13} />
        <Label x={94} y={98} z={132} text={`${derived.vaultBalanceUsdc} USDC`} size={15} fill="var(--bp-ink)" />

        {/* Agent robot */}
        <IsoShadow x={AGENT_X} y={LANE_Y + 6} w={36} d={36} />
        <g className={animate ? styles.bob : undefined}>
          <IsoBox x={AGENT_X} y={LANE_Y + 6} z={0} w={36} d={36} h={36} color={STEEL} />
          <IsoBox x={AGENT_X + 5} y={LANE_Y + 11} z={36} w={26} d={26} h={20} color={tone(STEEL).top} />
          <IsoCylinder x={AGENT_X + 18} y={LANE_Y + 24} z={56} r={2.4} h={18} color={BRASS} />
          <circle cx={isoProject([AGENT_X + 18, LANE_Y + 38, 48])[0]} cy={isoProject([AGENT_X + 18, LANE_Y + 38, 48])[1]} r={4} fill={eye} className={animate ? styles.pulse : undefined} />
        </g>
        <Label x={AGENT_X + 18} y={LANE_Y + 60} z={-6} text={hijacked ? "AGENT (HIJACKED)" : "AGENT"} size={13} fill={hijacked ? REJECT : "var(--bp-muted)"} />

        {/* Gates */}
        <Gate gx={GATE_X[0]} state={derived.gates[0]} label="RECIPIENT" index={0} />
        <Gate gx={GATE_X[1]} state={derived.gates[1]} label="CAP" index={1} />
        <Gate gx={GATE_X[2]} state={derived.gates[2]} label="BUDGET" index={2} />

        {/* Merchant */}
        <IsoShadow x={MERCHANT_X} y={LANE_Y + 10} w={62} d={62} />
        <IsoBox x={MERCHANT_X} y={LANE_Y + 10} z={0} w={62} d={62} h={34} color={STEEL} />
        <IsoBox x={MERCHANT_X + 4} y={LANE_Y + 14} z={34} w={54} d={54} h={5} color={PASS} />
        <Rivets x={MERCHANT_X} y={LANE_Y + 10} z={34} w={62} d={62} />
        <Label x={MERCHANT_X + 50} y={LANE_Y + 112} z={-6} text={`MERCHANT ${data.merchantShort}`} size={12} />
        <Label x={MERCHANT_X + 50} y={LANE_Y + 112} z={-24} text={`+${derived.merchantReceivedUsdc} USDC`} size={14} fill={PASS} />

        {/* Attacker */}
        <IsoShadow x={MERCHANT_X} y={ATTACKER_Y} w={56} d={56} />
        <IsoBox x={MERCHANT_X} y={ATTACKER_Y} z={0} w={56} d={56} h={26} color="#3a2230" edge="#6b3a40" />
        <IsoBox x={MERCHANT_X + 6} y={ATTACKER_Y + 6} z={26} w={44} d={44} h={5} color={REJECT} />
        <Label x={MERCHANT_X + 28} y={ATTACKER_Y + 70} z={-6} text={`ATTACKER ${data.attackerShort}`} size={12} />
        <Label x={MERCHANT_X + 28} y={ATTACKER_Y + 70} z={-24} text={`+${derived.attackerReceivedUsdc} USDC`} size={14} fill={derived.attackerReceivedUsdc === "0.00" ? "var(--bp-muted)" : REJECT} />

        {/* Spark when the recipient gate refuses */}
        {derived.showSpark && (
          <g transform={`translate(${sparkX} ${sparkY})`} stroke={REJECT} strokeWidth={2} strokeLinecap="round" className={animate ? styles.spark : styles.sparkStill}>
            {[0, 45, 90, 135, 180, 225, 270, 315].map((a) => (
              <line key={a} x1={Math.cos((a * Math.PI) / 180) * 10} y1={Math.sin((a * Math.PI) / 180) * 10} x2={Math.cos((a * Math.PI) / 180) * 22} y2={Math.sin((a * Math.PI) / 180) * 22} />
            ))}
          </g>
        )}

        {/* Payment coin: follows a route along the lane with WAAPI */}
        {derived.packet.visible && <Coin step={derived.step} animate={animate} color={coinColor} label={derived.packet.label} />}

        {/* Injection prompt bubble */}
        {derived.showInjectionPrompt && (
          <g transform={`translate(${px} ${py})`}><g key={derived.injectionText} className={animate ? styles.pop : undefined}>
            <rect x={-6} y={-24} width={248} height={34} rx={3} fill="#2a1418" stroke={REJECT} strokeWidth={1} />
            <text x={4} y={-3} fontFamily="var(--font-geist-mono), monospace" fontSize={13} fill={REJECT}>
              {derived.injectionText}
            </text>
          </g></g>
        )}

        {/* Rejection badge */}
        {derived.rejectionBadge && (
          <g transform={`translate(${bx} ${by})`}><g key={derived.rejectionBadge} className={animate ? styles.pop : undefined}>
            <rect x={-8} y={-22} width={derived.rejectionBadge.length * 9.2 + 20} height={32} rx={3} fill="#2a1418" stroke={REJECT} strokeWidth={1.4} />
            <text x={2} y={0} fontFamily="var(--font-geist-mono), monospace" fontSize={15} fontWeight={700} fill={REJECT}>
              {derived.rejectionBadge}
            </text>
          </g></g>
        )}
      </g>
    </svg>
  );
}
