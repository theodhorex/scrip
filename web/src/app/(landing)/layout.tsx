import type { Metadata, Viewport } from "next";
import { Manrope, JetBrains_Mono } from "next/font/google";

// next/font self-hosts both families at build time (no request to Google at runtime).
// Source: node_modules/next/dist/docs/01-app/03-api-reference/02-components/font.md
// Manrope is a variable font (200-800), so no `weight` is needed. Both are OFL 1.1.
const manrope = Manrope({ variable: "--font-manrope", subsets: ["latin"], display: "swap" });
const mono = JetBrains_Mono({ variable: "--font-mono", subsets: ["latin"], display: "swap" });

export const metadata: Metadata = {
  title: "Scrip: give agents a budget, not your keys",
  description:
    "Scrip is a NEAR testnet contract that caps what an AI agent can spend: a budget, allowed recipients and a guardian. Tested against 4 small real AI models and a 1,999-case attack catalog, with transactions you can verify. Testnet only, not audited.",
};

export const viewport: Viewport = { colorScheme: "dark", themeColor: "#050505" };

export default function LandingLayout({ children }: { children: React.ReactNode }) {
  return <div className={`${manrope.variable} ${mono.variable}`}>{children}</div>;
}
