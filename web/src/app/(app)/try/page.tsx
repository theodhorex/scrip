import type { Metadata } from "next";
import { LiveTry } from "@/components/LiveTry";
import { LIVE } from "@/lib/live";
import { EXPLORER_ACCOUNT_BASE } from "@/lib/network";

export const metadata: Metadata = {
  title: "Try it live | Scrip",
  description: "Send real payments on NEAR testnet as an AI agent holding a Scrip function-call key. The contract decides.",
};

export default function TryLivePage() {
  return (
    <div className="bp-app-stack">
      <header className="bp-app-head">
        <div>
          <span className="bp-chapter-label">Try it live</span>
          <h1 className="bp-app-title">You are the agent now.</h1>
          <p className="bp-app-lede">
            This page holds the agent&apos;s key for a real mandate on NEAR testnet. Pay a shop, pay an attacker,
            pay too much. Every click is a real transaction and the contract decides. No wallet and no gas needed: the Scrip relayer pays.
          </p>
        </div>
        <a className="bp-btn bp-btn-secondary" href={`${EXPLORER_ACCOUNT_BASE}/${LIVE.contractId}`} target="_blank" rel="noopener noreferrer">
          Contract on the explorer
        </a>
      </header>
      <LiveTry />
      <p className="max-w-[70ch] text-xs leading-relaxed text-bp-muted">
        Testnet only, with test USDC. The mandate is shared by every visitor, so the budget goes down as people
        pay the shops. When it runs out, payments are refused with OVER_BUDGET, which is the point. The contract
        has no full-access key, so nobody can change its code.
      </p>
    </div>
  );
}
