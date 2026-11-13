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
          <NavLink href="/overview">How it works</NavLink>
          <NavLink href="/try">Try to steal</NavLink>
          <NavLink href="/mandates/new">Make your own</NavLink>
          <NavLink href="/attack">Attack results</NavLink>
          <NavLink href="/verify">Verify</NavLink>
        </nav>
        <Link href="/" className="nl-dash-home">Home</Link>
      </div>
    </header>
  );
}
