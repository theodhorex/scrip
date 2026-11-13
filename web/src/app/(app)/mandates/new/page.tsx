import type { Metadata } from "next";
import Link from "next/link";
import { NewMandateForm } from "@/components/NewMandateForm";
import { OwnerConsole } from "@/components/OwnerConsole";

export const metadata: Metadata = {
  title: "Make your own | Scrip",
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
            <span className="text-bp-ink">Make your own</span>
          </div>
          <h1 className="bp-app-title">Make your own agent wallet.</h1>
          <p className="bp-app-lede">
            Connect a NEAR testnet wallet, give a new agent a budget and rules, fund it, then try to steal from it
            yourself. You sign every step; the agent only ever gets a key that can ask for payments.
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
