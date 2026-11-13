import { Suspense, type ReactNode } from "react";
import { Manrope, JetBrains_Mono } from "next/font/google";
import { Nav } from "./Nav";
import { DashFooter } from "./DashFooter";
import "@/components/nextlayer/base.css";
import "@/app/dashboard.css";

// Same families as the landing page, self-hosted at build time. Both are OFL 1.1.
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"], display: "swap" });

/** Shared shell for every dashboard page: dark theme tokens, sticky header, footer. */
export function DashShell({ children, center = false }: { children: ReactNode; center?: boolean }) {
  return (
    <div className={`${manrope.variable} ${mono.variable} nl nl-app`}>
      <a className="nl-skip" href="#main">Skip to content</a>
      <Suspense fallback={<header className="nl-dash-nav" aria-hidden="true" />}>
        <Nav />
      </Suspense>
      <main id="main" tabIndex={-1} className={center ? "nl-dash-main nl-dash-center" : "nl-dash-main"}>{children}</main>
      <DashFooter />
    </div>
  );
}
