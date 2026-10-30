import Link from "next/link";

export default function MandateNotFound() {
  return (
    <div className="bp-plate bp-app-empty">
      <div className="bp-app-empty-icon bp-app-mono" aria-hidden="true">?</div>
      <span className="bp-app-chip bp-app-chip-reject">NOT_FOUND</span>
      <h1 className="bp-app-title" style={{ fontSize: "2rem" }}>Mandate not found</h1>
      <p className="bp-app-notice-body mx-auto max-w-md">
        No spending mandate exists with the requested identifier.
      </p>
      <Link href="/mandates" className="bp-btn bp-btn-secondary mt-6">Back to all mandates</Link>
    </div>
  );
}
