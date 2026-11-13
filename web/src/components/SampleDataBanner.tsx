import Link from "next/link";
import { IS_SAMPLE_DATA, CONTRACT } from "@/lib/scrip";
import { EXPLORER_ACCOUNT_BASE } from "@/lib/network";

export function SampleDataBanner() {
  if (!IS_SAMPLE_DATA) {
    return (
      <aside role="status" aria-label="Data source notice" className="bp-plate bp-app-notice">
        <span className="bp-app-chip bp-app-chip-pass" aria-hidden="true">LIVE</span>
        <div>
          <p className="bp-app-notice-title">Read from NEAR testnet just now</p>
          <p className="bp-app-notice-body">
            Contract{" "}
            <a className="bp-app-inline font-mono" href={`${EXPLORER_ACCOUNT_BASE}/${CONTRACT}`} target="_blank" rel="noopener noreferrer">{CONTRACT}</a>.
            Events come from the public FastNear indexer. Send a payment yourself on <Link className="bp-app-inline" href="/try">Try it live</Link>.
          </p>
        </div>
      </aside>
    );
  }

  return (
    <aside
      role="status"
      aria-label="Data source notice"
      className="bp-plate bp-app-notice bp-app-sample"
    >
      <span className="bp-app-chip" aria-hidden="true">SAMPLE</span>
      <div>
        <p className="bp-app-notice-title">Sample data, not read from a chain</p>
        <p className="bp-app-notice-body">
          Everything on this page comes from bundled sample records, not from NEAR testnet.
        </p>
      </div>
    </aside>
  );
}
