import Link from "next/link";

export function DashFooter() {
  return (
    <footer className="nl-dash-footer" aria-label="Site footer">
      <div className="nl-dash-footer-in">
        <p>Scrip runs on NEAR testnet with test USDC only. It has not been audited. Nothing here is financial advice.</p>
        <nav aria-label="Footer" className="nl-dash-footer-links">
          <Link href="/" className="nl-link">Landing page</Link>
          <Link href="/verify" className="nl-link">Verify transactions</Link>
          <a className="nl-link" href="https://github.com/theodhorex/scrip" target="_blank" rel="noopener noreferrer" aria-label="GitHub repository (opens in a new tab)">GitHub</a>
        </nav>
      </div>
    </footer>
  );
}
