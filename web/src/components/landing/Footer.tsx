import { EXPLORER_TX_BASE } from "@/lib/network";
import { HERO_DEMO_DATA } from "@/lib/landing-data";
import styles from "./Closing.module.css";

export function Footer() {
  return (
    <footer className={styles.footer}>
      <div className="bp-container">
        <div className={styles.fRow}>
          <span>
            <span className={styles.fName}>Amanat</span> · NEAR testnet
          </span>
          <a
            className={styles.fLink}
            href={`${EXPLORER_TX_BASE}/${HERO_DEMO_DATA.injected.txHash}`}
            target="_blank"
            rel="noreferrer"
          >
            Rejected payment on the explorer
            <span className="sr-only"> (opens in new tab)</span>
          </a>
        </div>
        <p className={styles.fNote}>
          Testnet only, no real funds. {HERO_DEMO_DATA.note}
        </p>
      </div>
    </footer>
  );
}
