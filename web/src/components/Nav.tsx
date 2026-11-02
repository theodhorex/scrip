import Link from "next/link";
import { NavLink } from "./NavLink";

export function Nav() {
  return (
    <header className="bp-app-nav">
      <div className="bp-app-nav-inner">
        <div className="flex flex-wrap items-center gap-x-6 gap-y-1">
          <Link href="/overview" className="bp-app-brand" aria-label="Scrip dashboard">
            <span className="bp-app-brand-dot" aria-hidden="true" />
            <span>Scrip</span>
          </Link>
          <nav aria-label="Main navigation" className="bp-app-links">
            <NavLink href="/overview">Overview</NavLink>
            <NavLink href="/mandates">Mandates</NavLink>
            <NavLink href="/attack">Attack demo</NavLink>
            <NavLink href="/mandates/new">+ New mandate</NavLink>
          </nav>
        </div>
        <Link href="/" className="bp-app-link bp-app-back">
          <span aria-hidden="true">&larr;&nbsp;</span>Landing page
        </Link>
      </div>
    </header>
  );
}
