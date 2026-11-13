import type { Metadata } from "next";
import { LiveTry } from "@/components/LiveTry";
import Link from "next/link";

export const metadata: Metadata = {
  title: "Try to steal | Scrip",
  description: "You hold an AI agent's key. Try to steal its budget on NEAR testnet; the contract decides.",
};

export default function TryLivePage() {
  return (
    <div className="bp-app-stack">
      <header className="bp-app-head">
        <div>
          <span className="bp-chapter-label">Try to steal</span>
          <h1 className="bp-app-title">Steal from this agent.</h1>
          <p className="bp-app-lede">
            This AI agent has a budget, a few rules, and a key. We published the key, so you have it too. Try to get money
            out that the rules do not allow. Every button sends a real transaction on NEAR testnet. No wallet, no sign-up.
          </p>
        </div>
        <div className="nl-head-actions">
          <Link href="/overview" className="bp-btn bp-btn-secondary">How it works</Link>
        </div>
      </header>
      <LiveTry />
      <p className="nl-ov-note">
        Testnet only, with test USDC. Everyone shares this agent, so the budget goes down as people pay the shops. When it
        runs out, payments are refused with OVER_BUDGET, which is the point. The contract has no admin key, so nobody can
        change its rules.
      </p>
    </div>
  );
}
