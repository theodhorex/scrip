import type { MandateStatus } from "@/lib/types";

// Status is carried by an icon shape and the text, never by colour alone.
export function StatusBadge({ status }: { status: MandateStatus }) {
  const isActive = status === "Active";

  return (
    <span className={`bp-app-chip ${isActive ? "bp-app-chip-pass" : "bp-app-chip-reject"}`}>
      <svg width="10" height="10" viewBox="0 0 10 10" fill="none" stroke="currentColor" strokeWidth="1.8" aria-hidden="true">
        {isActive ? <path d="M1.5 5.2 4 7.5l4.5-5" /> : <path d="M2 2l6 6M8 2 2 8" />}
      </svg>
      {status}
    </span>
  );
}
