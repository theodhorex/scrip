import { IS_SAMPLE_DATA } from "@/lib/amanat";

export function SampleDataBanner() {
  if (!IS_SAMPLE_DATA) return null;

  return (
    <aside
      role="status"
      aria-label="Data source notice"
      className="bp-plate bp-app-notice bp-app-sample"
    >
      <span className="bp-app-chip" aria-hidden="true">SAMPLE</span>
      <div>
        <p className="bp-app-notice-title">Sample data — not read from a chain</p>
        <p className="bp-app-notice-body">
          Everything on this page comes from bundled sample records, not from NEAR testnet.
        </p>
      </div>
    </aside>
  );
}
