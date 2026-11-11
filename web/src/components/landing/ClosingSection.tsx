import Link from "next/link";
import { HERO_DEMO_DATA } from "@/lib/landing-data";
import { EXPLORER_TX_BASE } from "@/lib/network";
import { ClosingCode, type ClosingLine } from "./ClosingCode";
import styles from "./Closing.module.css";

const d = HERO_DEMO_DATA;
const tx = (h: string) => `${EXPLORER_TX_BASE}/${h}`;
const call = (to: string, units: string) =>
  `request_payment({ recipient: "${to}", amount: "${units}" })`;

const LINES: ClosingLine[] = [
  {
    call: call(d.merchantAccount, d.honest.amountUnits),
    ok: d.honest.paid,
    result: `${d.honest.amountUsdc} USDC paid`,
    href: tx(d.honest.txHash),
  },
  {
    call: call(d.attackerAccount, d.injected.amountUnits),
    ok: d.injected.paidByScrip,
    result: d.injected.rejectionCode,
    href: tx(d.injected.txHash),
  },
  {
    call: call(d.merchantAccount, d.overcharge.amountUnits),
    ok: d.overcharge.paidByScrip,
    result: d.overcharge.rejectionCode,
    href: tx(d.overcharge.txHash),
  },
];

export function ClosingSection() {
  return (
    <section id="closing" className={`bp-section ${styles.closing}`}>
      <div className="bp-container">
        <h2 className={`bp-section-title font-serif text-5xl md:text-7xl tracking-tight text-bp-ink leading-[1.05] ${styles.title}`}>
          Keys can be stolen.
          <br /> Losses are capped.
        </h2>
        <p className={`text-bp-muted font-mono text-sm ${styles.sub}`} data-reveal-item>
          The agent holds a key that can call one method. The contract holds the rules.
        </p>
        <div className={styles.actions} data-reveal-item>
          <Link href="/overview" className="bp-btn bp-btn-primary">
            Open the dashboard
          </Link>
          <a href="#proof" className="bp-btn bp-btn-secondary">
            See the proof
          </a>
        </div>
        <ClosingCode lines={LINES} />
      </div>
    </section>
  );
}
