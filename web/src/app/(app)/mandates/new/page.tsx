import type { Metadata } from "next";
import Link from "next/link";
import { NewMandateForm } from "@/components/NewMandateForm";
import { OwnerConsole } from "@/components/OwnerConsole";

export const metadata: Metadata = {
  title: "Create a mandate | Scrip",
  description: "Connect a NEAR testnet wallet, create an agent with a key that can only request payments, set its budget and rules, fund it, and try it.",
};

export default function NewMandatePage() {
  return (
    <div className="bp-app-stack">
      <header className="bp-app-head">
        <div>
          <div className="bp-chapter-label bp-app-crumbs">
            <Link href="/mandates" className="bp-app-inline">Mandates</Link>
            <span aria-hidden="true">/</span>
            <span className="text-bp-ink">New</span>
          </div>
          <h1 className="bp-app-title">Give your agent a budget.</h1>
          <p className="bp-app-lede">
            Connect a testnet wallet and create your own mandate on the live contract: an agent account whose only key can
            request payments, a guardian, and the rules the contract will enforce. Then fund it and pay as your agent.
          </p>
        </div>
      </header>

      <OwnerConsole />

      <section aria-labelledby="simulate-heading" className="nl-owner-sim">
        <span className="bp-chapter-label">No wallet?</span>
        <h2 id="simulate-heading" className="bp-app-section-title">Simulate the rules in your browser first</h2>
        <NewMandateForm />
      </section>
    </div>
  );
}
