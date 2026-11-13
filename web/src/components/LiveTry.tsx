"use client";

import { useCallback, useEffect, useId, useRef, useState } from "react";
import { EXPLORER_ACCOUNT_BASE, EXPLORER_TX_BASE, RPC_URL } from "@/lib/network";
import { LIVE, RELAY_EXPLAIN, isValidAccountId, parsePaymentOutcome, relayOutcome, remaining, type LiveStats, type PaymentOutcome, type RelayReply } from "@/lib/live";
import { fromUnits, toUnits } from "@/lib/owner-flow";

const GAS = "80000000000000"; // 80 Tgas; the contract requires at least 60
const ATTACKER = "attacker.testnet";
const COOLDOWN_MS = 2500;
const now = () => Date.now(); // called from event handlers only

const EXPLAIN: Record<string, string> = {
  RECIPIENT_NOT_ALLOWED: "Not on the allowlist. The contract refused before any token moved.",
  OVER_PER_PAYMENT_CAP: "Above the per-payment cap (or zero). Refused on-chain.",
  OVER_BUDGET: "Would go past what is left of the budget. Refused on-chain.",
  NEEDS_APPROVAL: "Above the approval threshold. The guardian has not approved this exact payment, so it was refused.",
  EXPIRED: "The mandate has expired.",
  NOT_ACTIVE: "The mandate is no longer active.",
  TOO_MANY_OPEN: "Too many payments are still settling. Try again in a few seconds.",
};

/** Which mandate this panel spends from, and with which agent key. */
export type TryTarget = {
  contractId: string;
  mandateId: number;
  agentId: string;
  agentKey: string;
  agentPublicKey: string;
  recipients: string[];
  budget: string;
  perPaymentCap: string;
  approvalThreshold: string;
  symbol: string;
  decimals: number;
  /** The shared demo: the key is in the page source on purpose. */
  publicDemo: boolean;
};

export const DEMO_TARGET: TryTarget = {
  contractId: LIVE.contractId,
  mandateId: LIVE.mandateId,
  agentId: LIVE.agentId,
  agentKey: LIVE.agentKey,
  agentPublicKey: LIVE.agentPublicKey,
  recipients: LIVE.recipients,
  budget: LIVE.budget,
  perPaymentCap: LIVE.perPaymentCap,
  approvalThreshold: LIVE.approvalThreshold,
  symbol: "USDC",
  decimals: 6,
  publicDemo: true,
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
  via: "relayer" | "agent";
};

type Stats = LiveStats & { open_requests?: number };
type Payer = "relayer" | "agent";

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};

async function nearLib() {
  return import("near-api-js");
}

const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const shortAcct = (a: string) => (a.length > 28 ? `${a.slice(0, 14)}…${a.slice(-12)}` : a);
const label = (i: number) => String.fromCharCode(65 + i);

export function LiveTry({ target = DEMO_TARGET }: { target?: TryTarget }) {
  const t = target;
  const rid = useId();
  const aid = useId();
  const [recipient, setRecipient] = useState(t.recipients[0]);
  const smallUnits = (BigInt(t.perPaymentCap) / BigInt(10) || BigInt(1)).toString();
  const [amount, setAmount] = useState(t.publicDemo ? "0.01" : fromUnits(smallUnits, t.decimals));
  const [custom, setCustom] = useState("");
  const [stats, setStats] = useState<Stats | null>(null);
  const [allowance, setAllowance] = useState<string | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [log, setLog] = useState<Attempt[]>([]);
  const [busy, setBusy] = useState(false);
  const lastSend = useRef(0);
  const [relayerUp, setRelayerUp] = useState<boolean | null>(null);
  const [payer, setPayer] = useState<Payer>("relayer");
  const via: Payer = relayerUp ? payer : "agent";
  const seq = useRef(0);

  const target_ = recipient === "custom" ? custom.trim() : recipient;
  const units = toUnits(amount, t.decimals);
  const inputError = !isValidAccountId(target_)
    ? "Enter a valid NEAR account id (lowercase, for example someone.testnet)."
    : units === null
      ? `Amount must be a positive number with up to ${t.decimals} decimals.`
      : null;

  const refresh = useCallback(async () => {
    try {
      const { JsonRpcProvider } = await nearLib();
      const p = new JsonRpcProvider({ url: RPC_URL });
      const s = (await p.callFunction({ contractId: t.contractId, method: "get_stats", args: { id: t.mandateId } })) as Stats;
      setStats(s);
      const key = (await p.viewAccessKey({ accountId: t.agentId, publicKey: t.agentPublicKey })) as unknown as { permission?: { FunctionCall?: { allowance?: string | null } } };
      const al = key.permission?.FunctionCall?.allowance;
      setAllowance(al ? (Number(BigInt(al) / BigInt("1000000000000000000000")) / 1000).toFixed(3) : null);
      setStatsError(null);
    } catch (e) {
      setStatsError(e instanceof Error ? e.message.slice(0, 160) : "Could not read the mandate.");
    }
  }, [t.contractId, t.mandateId, t.agentId, t.agentPublicKey]);

  useEffect(() => {
    let alive = true;
    fetch("/api/relay", { cache: "no-store" })
      .then((r) => r.json())
      .then((h: { ok?: boolean }) => { if (alive) setRelayerUp(h.ok === true); })
      .catch(() => { if (alive) setRelayerUp(false); });
    return () => { alive = false; };
  }, []);

  useEffect(() => {
    const first = setTimeout(refresh, 0);
    const timer = setInterval(refresh, 15000);
    return () => { clearTimeout(first); clearInterval(timer); };
  }, [refresh]);

  const send = async (to: string, u: string, shown: string) => {
    if (busy || now() - lastSend.current < COOLDOWN_MS) return;
    lastSend.current = now();
    setBusy(true);
    const id = ++seq.current;
    setLog((l) => [{ id, at: new Date().toISOString(), recipient: to, amount: shown, state: "pending" as const, via }, ...l].slice(0, 12));
    const update = (patch: Partial<Attempt>) => setLog((l) => l.map((a) => (a.id === id ? { ...a, ...patch } : a)));
    try {
      const { Account, JsonRpcProvider, KeyPair, KeyPairSigner, actions, buildDelegateAction, encodeSignedDelegate } = await nearLib();
      const provider = new JsonRpcProvider({ url: RPC_URL });
      const keyPair = KeyPair.fromString(t.agentKey as `ed25519:${string}`);
      const signer = new KeyPairSigner(keyPair);
      if (via === "relayer") {
        // Gasless: sign a NEP-366 delegate with the agent key and let the Scrip relayer pay for the transaction.
        const relayOnce = async (): Promise<RelayReply> => {
          const [key, block] = await Promise.all([
            provider.viewAccessKey({ accountId: t.agentId, publicKey: t.agentPublicKey }),
            provider.viewBlock({ finality: "final" }),
          ]);
          const delegate = buildDelegateAction({
            senderId: t.agentId,
            receiverId: t.contractId,
            actions: [actions.functionCall("request_payment", { mandate_id: t.mandateId, recipient: to, amount: u, nonce: now() }, BigInt(GAS), BigInt(0))],
            nonce: BigInt(key.nonce) + BigInt(1),
            maxBlockHeight: BigInt(block.header.height) + BigInt(100),
            publicKey: keyPair.getPublicKey(),
          });
          const { signedDelegate } = await signer.signDelegateAction(delegate);
          const res = await fetch("/api/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed_delegate: toBase64(encodeSignedDelegate(signedDelegate)) }) });
          return (await res.json()) as RelayReply;
        };
        let reply = await relayOnce();
        if (!reply.ok && reply.code === "NONCE_TOO_LOW") reply = await relayOnce();
        if (!reply.ok) {
          update({ state: "error", txHash: reply.tx_hash, error: `${reply.code}: ${RELAY_EXPLAIN[reply.code ?? ""] ?? "The relayer refused this payment."}` });
          return;
        }
        update({ state: "done", outcome: relayOutcome(reply), txHash: reply.tx_hash });
        return;
      }
      const agent = new Account(t.agentId, provider, signer);
      const call = () => agent.callFunctionRaw({
        contractId: t.contractId,
        methodName: "request_payment",
        args: { mandate_id: t.mandateId, recipient: to, amount: u, nonce: now() },
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

  const sendForm = () => { if (!inputError && units) send(target_, units, amount.trim()); };
  const presetUnits = (to: string, u: string) => send(to, u, fromUnits(u, t.decimals));

  const left = stats ? fromUnits(remaining(stats), t.decimals) : null;
  const spentPct = stats ? Math.min(100, Number((BigInt(stats.spent) * BigInt(10000)) / BigInt(stats.budget || "1")) / 100) : 0;
  const cap = fromUnits(t.perPaymentCap, t.decimals);
  const threshold = fromUnits(t.approvalThreshold, t.decimals);
  const needsApprovalBand = BigInt(t.approvalThreshold) < BigInt(t.perPaymentCap);
  const firstAmount = t.publicDemo ? (toUnits("0.01", t.decimals) ?? smallUnits) : smallUnits;
  const sym = t.symbol;

  return (
    <div className="bp-app-grid2 nl-live">
      <section className="bp-plate bp-app-plate bp-app-enter" aria-labelledby={`${rid}-state`}>
        <h2 id={`${rid}-state`} className="bp-app-section-title">The mandate, read live</h2>
        <dl className="nl-live-facts">
          <div><dt>Left to spend</dt><dd><b>{left ?? "…"}</b> {sym}</dd></div>
          <div><dt>Spent</dt><dd>{stats ? fromUnits(stats.spent, t.decimals) : "…"} of {fromUnits(t.budget, t.decimals)} {sym}</dd></div>
          <div><dt>Per payment</dt><dd>up to {cap} {sym}</dd></div>
          <div><dt>Guardian approval</dt><dd>{needsApprovalBand ? `above ${threshold} ${sym}` : "not needed up to the cap"}</dd></div>
        </dl>
        <div className="nl-live-meter" role="img" aria-label={`Budget used: ${spentPct.toFixed(1)} percent`}>
          <span style={{ width: `${spentPct}%` }} />
        </div>
        <h3 className="nl-live-h">Allowed recipients</h3>
        <ul className="nl-live-list">
          {t.recipients.map((r) => <li key={r}><a className="bp-app-inline font-mono" href={`${EXPLORER_ACCOUNT_BASE}/${r}`} target="_blank" rel="noopener noreferrer">{shortAcct(r)}</a></li>)}
        </ul>
        {t.publicDemo ? (
          <>
            <h3 className="nl-live-h">The agent key, public on purpose</h3>
            <p className="bp-app-hint">This page signs with the agent&apos;s key, and the key is in the page source. It is a function-call key: it can only call <code>request_payment</code> on <a className="bp-app-inline" href={`${EXPLORER_ACCOUNT_BASE}/${t.contractId}`} target="_blank" rel="noopener noreferrer">the contract</a>. Stealing it gets you exactly what you can do here.</p>
          </>
        ) : (
          <>
            <h3 className="nl-live-h">Your agent&apos;s key</h3>
            <p className="bp-app-hint">Created in this browser for <span className="font-mono">{shortAcct(t.agentId)}</span>. It is a function-call key: it can only call <code>request_payment</code> on the contract, inside the mandate you set.</p>
          </>
        )}
        <p className="bp-app-hint font-mono" style={{ overflowWrap: "anywhere" }}>{t.agentPublicKey}</p>
        {allowance ? <p className="bp-app-hint">Gas allowance left on the key: {allowance} NEAR (testnet).</p> : null}
        {statsError ? <p className="text-bp-reject text-xs" role="alert">Could not read the mandate right now: {statsError}</p> : null}
      </section>

      <section className="bp-plate bp-app-plate bp-app-enter" style={{ "--bp-app-delay": "90ms" } as React.CSSProperties} aria-labelledby={`${rid}-pay`}>
        <h2 id={`${rid}-pay`} className="bp-app-section-title">Send a payment as the agent</h2>
        <div className="nl-live-form">
          <div>
            <label htmlFor={rid} className="bp-app-label">Pay to</label>
            <select id={rid} className="bp-app-input" value={recipient} onChange={(e) => setRecipient(e.target.value)}>
              {t.recipients.map((r, i) => <option key={r} value={r}>{t.publicDemo ? `Shop ${label(i)}` : shortAcct(r)} (allowed)</option>)}
              <option value={ATTACKER}>{ATTACKER} (not allowed)</option>
              <option value="custom">Another account…</option>
            </select>
            {recipient === "custom" ? <input aria-label="Account id" className="bp-app-input" value={custom} placeholder="someone.testnet" onChange={(e) => setCustom(e.target.value)} autoComplete="off" spellCheck={false} /> : null}
          </div>
          <div>
            <label htmlFor={aid} className="bp-app-label">Amount ({sym})</label>
            <input id={aid} className="bp-app-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
          </div>
        </div>
        {relayerUp ? (
          <fieldset className="nl-live-payer">
            <legend className="bp-app-label">Who pays the gas</legend>
            <label><input type="radio" name={`${rid}-payer`} checked={payer === "relayer"} onChange={() => setPayer("relayer")} /> Scrip relayer (gasless for the agent)</label>
            <label><input type="radio" name={`${rid}-payer`} checked={payer === "agent"} onChange={() => setPayer("agent")} /> The agent key&apos;s own allowance</label>
            <p className="bp-app-hint">{payer === "relayer" ? "The agent signs a delegate (NEP-366) and the hosted relayer submits it and pays the gas. The relayer checks the signature, the key and that the sender is this mandate's agent. The contract still decides." : "The agent key sends the transaction itself; gas comes out of its allowance."}</p>
          </fieldset>
        ) : null}
        {inputError ? <p className="text-bp-reject text-xs" style={{ marginTop: 10 }}>{inputError}</p> : null}
        <div className="bp-app-try-actions">
          <button type="button" className="bp-btn bp-btn-primary" onClick={sendForm} disabled={busy || !!inputError} aria-disabled={busy || !!inputError}>
            {busy ? "Sending to testnet…" : "Send on testnet"}
          </button>
        </div>
        <p className="bp-app-hint" style={{ marginTop: 22 }}>Or try one of these:</p>
        <div className="bp-app-try-actions" style={{ marginTop: 8 }}>
          <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" disabled={busy} onClick={() => presetUnits(t.recipients[0], firstAmount)}>
            {t.publicDemo ? "Pay shop A 0.01" : `Pay ${fromUnits(firstAmount, t.decimals)} to the first recipient`}
          </button>
          <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" disabled={busy} onClick={() => presetUnits(ATTACKER, firstAmount)}>Pay the attacker</button>
          <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" disabled={busy} onClick={() => presetUnits(t.recipients[t.recipients.length - 1], (BigInt(t.perPaymentCap) * BigInt(2)).toString())}>Over the cap</button>
          {needsApprovalBand ? (
            <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" disabled={busy} onClick={() => presetUnits(t.recipients[t.recipients.length - 1], t.perPaymentCap)}>Without approval</button>
          ) : null}
        </div>

        <h3 className="nl-live-h" style={{ marginTop: 28 }}>Your attempts</h3>
        <ol className="nl-live-log" aria-live="polite">
          {log.length === 0 ? <li className="bp-app-hint">Nothing sent yet. Each attempt is a real transaction on NEAR testnet.</li> : null}
          {log.map((a) => (
            <li key={a.id} data-state={a.state}>
              <div className="nl-live-row">
                <span className="font-mono text-xs">{a.amount} {sym} to {shortAcct(a.recipient)}</span>
                <Verdict a={a} />
              </div>
              <div className="nl-live-sub">
                <time dateTime={a.at}>{a.at.slice(11, 19)} UTC</time>
                {a.via === "relayer" ? " · gasless via relayer" : " · agent paid gas"}
                {a.txHash ? <> · <a className="bp-app-inline font-mono" href={`${EXPLORER_TX_BASE}/${a.txHash}`} target="_blank" rel="noopener noreferrer">{short(a.txHash)} ↗</a></> : null}
              </div>
              {a.state === "done" && a.outcome?.kind === "rejected" ? <p className="nl-live-why">{EXPLAIN[a.outcome.code] ?? "Refused by the contract."}</p> : null}
              {a.state === "done" && a.outcome?.kind === "settled" ? <p className="nl-live-why">Inside every rule, so the contract paid it. The tokens moved on testnet.</p> : null}
              {a.state === "done" && a.outcome?.kind === "unknown" ? <p className="nl-live-why">Submitted. Open the transaction to read the result.</p> : null}
              {a.state === "done" && a.outcome?.kind === "refunded" ? <p className="nl-live-why">The token transfer failed (for example the recipient is not registered with the token), so the reservation was released.</p> : null}
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
