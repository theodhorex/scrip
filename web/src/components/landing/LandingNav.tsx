import Link from "next/link";
import { IsoBox, isoProject } from "./iso/Iso";

const LINKS = [
  { href: "#rules", label: "Rule machine" },
  { href: "#the-race", label: "The race" },
  { href: "#guardian", label: "Guardian" },
  { href: "#proof", label: "Proof" },
] as const;

function Mark() {
  const [, top] = isoProject([0, 0, 22]);
  return (
    <svg viewBox="-20 -22 40 40" width="26" height="26" aria-hidden="true">
      <g transform={`translate(0 ${-top / 2 + 2})`}>
        <IsoBox x={-10} y={-10} z={0} w={20} d={20} h={22} color="#1f4fd8" scale={0.85} />
      </g>
    </svg>
  );
}

export function LandingNav() {
  return (
    <header className="bp-nav-wrap">
      <div className="bp-nav-pill flex h-12 items-center justify-between gap-4">
        <Link href="#top" className="flex items-center gap-2.5 text-bp-ink" aria-label="Scrip, top of page">
          <Mark />
          <span className="font-serif text-xl tracking-tight">Scrip</span>
        </Link>
        <nav aria-label="Sections" className="hidden md:flex items-center gap-6">
          {LINKS.map((l) => (
            <a key={l.href} href={l.href} className="text-[13px] font-mono text-bp-muted hover:text-bp-ink focus-visible:text-bp-ink transition-colors">
              {l.label}
            </a>
          ))}
        </nav>
        <div className="flex items-center gap-3">
          <span className="hidden sm:inline text-[11px] font-mono uppercase tracking-wider text-bp-pass border border-bp-pass/40 rounded-xs px-2 py-0.5">testnet</span>
          <Link href="/overview" className="bp-btn bp-btn-primary bp-btn-sm">
            Open the dashboard
          </Link>
        </div>
      </div>
    </header>
  );
}
