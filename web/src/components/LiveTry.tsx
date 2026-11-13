"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { EXPLORER_ACCOUNT_BASE, EXPLORER_TX_BASE, RPC_URL } from "@/lib/network";
import { LIVE, isValidAccountId, parsePaymentOutcome, remaining, unitsToUsdc, usdcToUnits, type LiveStats, type PaymentOutcome } from "@/lib/live";

const GAS = "80000000000000"; // 80 Tgas; the contract requires at least 60
const ATTACKER = "attacker.testnet";
const COOLDOWN_MS = 2500;

const EXPLAIN: Record<string, string> = {
  RECIPIENT_NOT_ALLOWED: "Not on the allowlist. The contract refused before any token moved.",
  OVER_PER_PAYMENT_CAP: "Above the per-payment cap (or zero). Refused on-chain.",
  OVER_BUDGET: "Would go past what is left of the budget. Refused on-chain.",
  NEEDS_APPROVAL: "Above the approval threshold. The guardian has not approved this exact payment, so it was refused.",
  EXPIRED: "The mandate has expired.",
  NOT_ACTIVE: "The mandate is no longer active.",
  TOO_MANY_OPEN: "Too many payments are still settling. Try again in a few seconds.",
};

type Attempt = {
  id: number;
  at: string;
  recipient: string;
  amount: string;
  state: "pending" | "done" | "error";
  outcome?: PaymentOutcome;
  txHash?: string;
  error?: string;
};

type Stats = LiveStats & { open_requests?: number };

async function nearLib() {
  return import("near-api-js");
}

const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const shortAcct = (a: string) => (a.length > 28 ? `${a.slice(0, 14)}…${a.slice(-12)}` : a);

export function LiveTry() {
  const rid = useId();
  const aid = useId();
  const [recipient, setRecipient] = useState(LIVE.recipients[0]);
  const [custom, setCustom] = useState("");
  const [amount, setAmount] = useState("0.01");
  const [stats, setStats] = useState<Stats | null>(null);
  const [allowance, setAllowance] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [log, setLog] = useState<Attempt[]>([]);
  const [busy, setBusy] = useState(false);
  const lastSend = useRef(0);
  const seq = useRef(0);

  const target = recipient === "custom" ? custom.trim() : recipient;
  const units = usdcToUnits(amount);
  const inputError = !isValidAccountId(target)
    ? "Enter a valid NEAR account id (lowercase, for example someone.testnet)."
    : units === null
      ? "Amount must be a number with up to 6 decimals."
      : null;

  const refresh = useCallback(async () => {
    try {
      const { JsonRpcProvider } = await nearLib();
      const p = new JsonRpcProvider({ url: RPC_URL });
      const s = (await p.callFunction({ contractId: LIVE.contractId, method: "get_stats", args: { id: LIVE.mandateId } })) as Stats;
      setStats(s);
      const key = (await p.viewAccessKey({ accountId: LIVE.agentId, publicKey: LIVE.agentPublicKey })) as unknown as { permission?: { FunctionCall?: { allowance?: string | null } } };
      const al = key.permission?.FunctionCall?.allowance;
      setAllowance(al ? (Number(BigInt(al) / BigInt("1000000000000000000000")) / 1000).toFixed(3) : null);
      setStatsError(null);
    } catch (e) {
      setStatsError(e instanceof Error ? e.message.slice(0, 160) : "Could not read the mandate.");
    }
  }, []);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const t = setInterval(refresh, 15000);
    return () => { clearTimeout(first); clearInterval(t); };
  }, [refresh]);

  const send = async (to: string, units: string, label: string) => {
    if (busy || Date.now() - lastSend.current < COOLDOWN_MS) return;
    lastSend.current = Date.now();
    setBusy(true);
    const id = ++seq.current;
    setLog((l) => [{ id, at: new Date().toISOString(), recipient: to, amount: label, state: "pending" as const }, ...l].slice(0, 12));
    const update = (patch: Partial<Attempt>) => setLog((l) => l.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    try {
      const { Account, JsonRpcProvider, KeyPair, KeyPairSigner } = await nearLib();
      const provider = new JsonRpcProvider({ url: RPC_URL });
      const signer = new KeyPairSigner(KeyPair.fromString(LIVE.agentKey as `ed25519:${string}`));
      const agent = new Account(LIVE.agentId, provider, signer);
      const call = () => agent.callFunctionRaw({
        contractId: LIVE.contractId,
        methodName: "request_payment",
        args: { mandate_id: LIVE.mandateId, recipient: to, amount: units, nonce: Date.now() },
        gas: BigInt(GAS),
        deposit: BigInt(0),
      });
      let outcome;
      try {
        outcome = await call();
      } catch (e) {
        // Two visitors can race for the same access-key nonce: retry once with a fresh one.
        if (e instanceof Error && /nonce/i.test(e.message)) outcome = await call();
        else throw e;
      }
      update({ state: "done", outcome: parsePaymentOutcome(outcome), txHash: (outcome as { transaction?: { hash?: string } }).transaction?.hash });
    } catch (e) {
      update({ state: "error", error: e instanceof Error ? e.message.slice(0, 220) : String(e) });
    } finally {
      setBusy(false);
      refresh();
    }
  };

  const sendForm = () => { if (!inputError && units) send(target, units, amount.trim()); };
  const preset = (to: string, usdc: string) => { const u = usdcToUnits(usdc); if (u) send(to, u, usdc); };

  const left = stats ? unitsToUsdc(remaining(stats)) : null;
  const spentPct = stats ? Math.min(100, Number((BigInt(stats.spent) * BigInt(10000)) / BigInt(stats.budget || "1")) / 100) : 0;
  const cap = unitsToUsdc(LIVE.perPaymentCap);
  const threshold = unitsToUsdc(LIVE.approvalThreshold);

  return (
    <div className="bp-app-grid2 nl-live">
      <section className="bp-plate bp-app-plate bp-app-enter" aria-labelledby={`${rid}-state`}>
        <h2 id={`${rid}-state`} className="bp-app-section-title">The mandate, read live</h2>
        <dl className="nl-live-facts">
          <div><dt>Left to spend</dt><dd><b>{left ?? "…"}</b> USDC</dd></div>
          <div><dt>Spent</dt><dd>{stats ? unitsToUsdc(stats.spent) : "…"} of {unitsToUsdc(LIVE.budget)} USDC</dd></div>
          <div><dt>Per payment</dt><dd>up to {cap} USDC</dd></div>
          <div><dt>Guardian approval</dt><dd>above {threshold} USDC</dd></div>
        </dl>
        <div className="nl-live-meter" role="img" aria-label={`Budget used: ${spentPct.toFixed(1)} percent`}>
          <span style={{ width: `${spentPct}%` }} />
        </div>
        <h3 className="nl-live-h">Allowed recipients</h3>
        <ul className="nl-live-list">
          {LIVE.recipients.map((r) => <li key={r}><a className="bp-app-inline font-mono" href={`${EXPLORER_ACCOUNT_BASE}/${r}`} target="_blank" rel="noopener noreferrer">{shortAcct(r)}</a></li>)}
        </ul>
        <h3 className="nl-live-h">The agent key, public on purpose</h3>
        <p className="bp-app-hint">This page signs with the agent&apos;s key, and the key is in the page source. It is a function-call key: it can only call <code>request_payment</code> on <a className="bp-app-inline" href={`${EXPLORER_ACCOUNT_BASE}/${LIVE.contractId}`} target="_blank" rel="noopener noreferrer">the contract</a>. Stealing it gets you exactly what you can do here.</p>
        <p className="bp-app-hint font-mono" style={{ overflowWrap: "anywhere" }}>{LIVE.agentPublicKey}</p>
        {allowance ? <p className="bp-app-hint">Gas allowance left on the key: {allowance} NEAR (testnet).</p> : null}
        {statsError ? <p className="text-bp-reject text-xs" role="alert">Could not read the mandate right now: {statsError}</p> : null}
      </section>

      <section className="bp-plate bp-app-plate bp-app-enter" style={{ "--bp-app-delay": "90ms" } as React.CSSProperties} aria-labelledby={`${rid}-pay`}>
        <h2 id={`${rid}-pay`} className="bp-app-section-title">Send a payment as the agent</h2>
        <div className="nl-live-form">
          <div>
            <label htmlFor={rid} className="bp-app-label">Pay to</label>
            <select id={rid} className="bp-app-input" value={recipient} onChange={(e) => setRecipient(e.target.value)}>
              {LIVE.recipients.map((r, i) => <option key={r} value={r}>Shop {i === 0 ? "A" : "B"} (allowed)</option>)}
              <option value={ATTACKER}>{ATTACKER} (not allowed)</option>
              <option value="custom">Another account…</option>
            </select>
            {recipient === "custom" ? <input aria-label="Account id" className="bp-app-input" value={custom} placeholder="someone.testnet" onChange={(e) => setCustom(e.target.value)} autoComplete="off" spellCheck={false} /> : null}
          </div>
          <div>
            <label htmlFor={aid} className="bp-app-label">Amount (USDC)</label>
            <input id={aid} className="bp-app-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        {inputError ? <p className="text-bp-reject text-xs" style={{ marginTop: 10 }}>{inputError}</p> : null}
        <div className="bp-app-try-actions">
          <button type="button" className="bp-btn bp-btn-primary" onClick={sendForm} disabled={busy || !!inputError} aria-disabled={busy || !!inputError}>
            {busy ? "Sending to testnet…" : "Send on testnet"}
          </button>
        </div>
        <p className="bp-app-hint" style={{ marginTop: 16 }}>Or try one of these:</p>
        <div className="bp-app-try-actions" style={{ marginTop: 8 }}>
          <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" disabled={busy} onClick={() => preset(LIVE.recipients[0], "0.01")}>Pay shop A 0.01</button>
          <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" disabled={busy} onClick={() => preset(ATTACKER, "0.01")}>Pay the attacker</button>
          <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" disabled={busy} onClick={() => preset(LIVE.recipients[1], String(Number(cap) * 2))}>Over the cap</button>
          <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" disabled={busy} onClick={() => preset(LIVE.recipients[1], cap)}>Without approval</button>
        </div>

        <h3 className="nl-live-h" style={{ marginTop: 28 }}>Your attempts</h3>
        <ol className="nl-live-log" aria-live="polite">
          {log.length === 0 ? <li className="bp-app-hint">Nothing sent yet. Each attempt is a real transaction on NEAR testnet.</li> : null}
          {log.map((a) => (
            <li key={a.id} data-state={a.state}>
              <div className="nl-live-row">
                <span className="font-mono text-xs">{a.amount} USDC to {shortAcct(a.recipient)}</span>
                <Verdict a={a} />
              </div>
              <div className="nl-live-sub">
                <time dateTime={a.at}>{a.at.slice(11, 19)} UTC</time>
                {a.txHash ? <> · <a className="bp-app-inline font-mono" href={`${EXPLORER_TX_BASE}/${a.txHash}`} target="_blank" rel="noopener noreferrer">{short(a.txHash)} ↗</a></> : null}
              </div>
              {a.state === "done" && a.outcome?.kind === "rejected" ? <p className="nl-live-why">{EXPLAIN[a.outcome.code] ?? "Refused by the contract."}</p> : null}
              {a.state === "done" && a.outcome?.kind === "settled" ? <p className="nl-live-why">Inside every rule, so the contract paid it. The tokens moved on testnet.</p> : null}
              {a.state === "error" ? <p className="nl-live-why text-bp-reject">{a.error}</p> : null}
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Verdict({ a }: { a: Attempt }) {
  if (a.state === "pending") return <span className="bp-app-checking" role="status">Waiting for testnet…</span>;
  if (a.state === "error") return <span className="bp-app-chip bp-app-chip-reject">ERROR</span>;
  const o = a.outcome;
  if (o?.kind === "settled") return <span className="bp-app-chip bp-app-chip-pass">PAID</span>;
  if (o?.kind === "rejected") return <span className="bp-app-chip bp-app-chip-reject">REFUSED: {o.code}</span>;
  if (o?.kind === "refunded") return <span className="bp-app-chip">REFUNDED</span>;
  if (o?.kind === "failed") return <span className="bp-app-chip bp-app-chip-reject">FAILED</span>;
  return <span className="bp-app-chip">SENT</span>;
}
