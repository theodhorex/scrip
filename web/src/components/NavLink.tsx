"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import type { ReactNode } from "react";

type NavLinkProps = {
  href: string;
  children: ReactNode;
};

export function NavLink({ href, children }: NavLinkProps) {
  const pathname = usePathname();

  const isActive =
    href === "/"
      ? pathname === "/"
      : href === "/mandates/new"
      ? pathname === "/mandates/new"
      : pathname === href ||
        (pathname.startsWith(href + "/") && pathname !== "/mandates/new");

  return (
    <Link href={href} aria-current={isActive ? "page" : undefined} className="nl-dash-link">
      {children}
    </Link>
  );
}
