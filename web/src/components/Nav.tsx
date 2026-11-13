import Link from "next/link";
import { NavLink } from "./NavLink";
import { BrandMark } from "./nextlayer/BrandMark";

export function Nav() {
  return (
    <header className="nl-dash-nav">
      <div className="nl-dash-nav-in">
        <Link href="/overview" className="nl-dash-brand" aria-label="Scrip dashboard">
          <span className="nl-dash-mark"><BrandMark /></span>
          <span>Scrip</span>
          <span className="nl-dash-tag">testnet</span>
        </Link>
        <nav aria-label="Main navigation" className="nl-dash-links">
          <NavLink href="/overview">Overview</NavLink>
          <NavLink href="/mandates">Mandates</NavLink>
          <NavLink href="/attack">Attack demo</NavLink>
          <NavLink href="/mandates/new">New mandate</NavLink>
          <NavLink href="/verify">Verify</NavLink>
        </nav>
        <Link href="/" className="nl-dash-home">Landing page</Link>
      </div>
    </header>
  );
}
