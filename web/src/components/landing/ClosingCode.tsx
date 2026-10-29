"use client";

import { useRef, useState } from "react";
import styles from "./Closing.module.css";

export type ClosingLine = {
  call: string;
  ok: boolean;
  result: string;
  href: string;
};

async function writeClipboard(text: string): Promise<boolean> {
  try {
    if (navigator.clipboard?.writeText) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
    /* fall through to legacy path */
  }
  try {
    const ta = document.createElement("textarea");
    ta.value = text;
    ta.setAttribute("readonly", "");
    ta.style.position = "fixed";
    ta.style.opacity = "0";
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand("copy");
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

export function ClosingCode({ lines }: { lines: ClosingLine[] }) {
  const [status, setStatus] = useState<"idle" | "copied" | "failed">("idle");
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const plain = lines
    .map((l) => `${l.call}\n  ${l.ok ? "OK" : "REJECTED"} ${l.result}`)
    .join("\n");

  async function copy() {
    const ok = await writeClipboard(plain);
    setStatus(ok ? "copied" : "failed");
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setStatus("idle"), 2200);
  }

  return (
    <figure className={styles.code} data-reveal-item>
      <figcaption className={styles.bar}>
        <span>Agent calls, NEAR testnet</span>
        <button type="button" className={styles.copy} onClick={copy}>
          {status === "copied" ? "Copied" : status === "failed" ? "Copy failed" : "Copy"}
        </button>
        <span className={styles.sr} role="status" aria-live="polite">
          {status === "copied" ? "Copied to clipboard" : status === "failed" ? "Copy failed" : ""}
        </span>
      </figcaption>
      <pre className={styles.pre}>
        {lines.map((l) => (
          <span key={l.call} className={styles.entry}>
            <code className={styles.call}>{l.call}</code>
            <span className={l.ok ? styles.ok : styles.no}>
              <span aria-hidden="true">{l.ok ? "✓ " : "✗ "}</span>
              <span className={styles.sr}>{l.ok ? "Paid: " : "Rejected: "}</span>
              {l.result}
            </span>
            <a href={l.href} target="_blank" rel="noreferrer" className={styles.tx}>
              view tx
              <span className={styles.sr}> on testnet explorer (opens in new tab)</span>
            </a>
          </span>
        ))}
      </pre>
    </figure>
  );
}
