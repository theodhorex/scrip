import Link from "next/link";
import { NewMandateForm } from "@/components/NewMandateForm";

export default function NewMandatePage() {
  return (
    <div>
      <header className="bp-app-head">
        <div>
          <div className="bp-chapter-label bp-app-crumbs">
            <Link href="/mandates" className="bp-app-inline">Mandates</Link>
            <span aria-hidden="true">/</span>
            <span className="text-bp-ink">New</span>
          </div>
          <h1 className="bp-app-title">Create spending mandate</h1>
          <p className="bp-app-lede">
            Configure deterministic spending limits and allowed recipients for an autonomous AI agent.
          </p>
        </div>
      </header>

      <NewMandateForm />
    </div>
  );
}
