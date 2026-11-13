"use client";

// The playground: you hold the agent's key, try to get money out that the rules do not allow.
// Every button sends a real transaction on NEAR testnet (or is refused by NEAR before it becomes one).
import { useCallback, useEffect, useId, useRef, useState } from "react";
import { EXPLORER_ACCOUNT_BASE, EXPLORER_TX_BASE, RPC_URL } from "@/lib/network";
import { LIVE, RELAY_EXPLAIN, isValidAccountId, parsePaymentOutcome, relayOutcome, remaining, type LiveStats, type PaymentOutcome, type RelayReply } from "@/lib/live";
import { fromUnits, toUnits } from "@/lib/owner-flow";

const GAS = "80000000000000"; // 80 Tgas; the contract requires at least 60
const ATTACKER = "attacker.testnet";
const COOLDOWN_MS = 2500;
const now = () => Date.now(); // called from event handlers only
// What NEAR answers when a function-call key is used for anything it was not issued for.
const PROTOCOL_REFUSAL = /permission|MethodNameMismatch|ReceiverMismatch|NotEnoughAllowance|DepositWithFunctionCall|InvalidAccessKey|access key/i;

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

type Verdict = "paid" | "blocked" | "unclear" | "error";
type Attempt = {
  id: number;
  at: string;
  title: string;
  state: "pending" | "done";
  verdict?: Verdict;
  text?: string;
  code?: string;
  txHash?: string;
  how: string;
};
type Stats = LiveStats & { open_requests?: number };
type Payer = "relayer" | "agent";

async function nearLib() {
  return import("near-api-js");
}

const toBase64 = (bytes: Uint8Array) => {
  let s = "";
  for (const b of bytes) s += String.fromCharCode(b);
  return btoa(s);
};
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const shortAcct = (a: string) => (a.length > 28 ? `${a.slice(0, 14)}…${a.slice(-12)}` : a);
const letter = (i: number) => String.fromCharCode(65 + i);

export function LiveTry({ target = DEMO_TARGET }: { target?: TryTarget }) {
  const t = target;
  const rid = useId();
  const sym = t.symbol;
  const name = (acct: string) => {
    const i = t.recipients.indexOf(acct);
    return i >= 0 ? (t.publicDemo ? `Shop ${letter(i)}` : shortAcct(acct)) : acct;
  };
  const amt = (units: string) => `${fromUnits(units, t.decimals)} ${sym}`;
  const cap = amt(t.perPaymentCap);
  const threshold = amt(t.approvalThreshold);
  const needsApprovalBand = BigInt(t.approvalThreshold) < BigInt(t.perPaymentCap);
  const smallUnits = (BigInt(t.perPaymentCap) / BigInt(10) || BigInt(1)).toString();
  const firstAmount = t.publicDemo ? (toUnits("0.01", t.decimals) ?? smallUnits) : smallUnits;

  const [stats, setStats] = useState<Stats | null>(null);
  const [statsError, setStatsError] = useState<string | null>(null);
  const [log, setLog] = useState<Attempt[]>([]);
  const [busy, setBusy] = useState(false);
  const [relayerUp, setRelayerUp] = useState<boolean | null>(null);
  const [payer, setPayer] = useState<Payer>("relayer");
  const [copied, setCopied] = useState(false);
  const [recipient, setRecipient] = useState(t.recipients[0]);
  const [custom, setCustom] = useState("");
  const [amount, setAmount] = useState(fromUnits(firstAmount, t.decimals));
  const lastSend = useRef(0);
  const seq = useRef(0);
  const via: Payer = relayerUp ? payer : "agent";

  const why = (code: string, to: string): string => {
    switch (code) {
      case "RECIPIENT_NOT_ALLOWED": return `Blocked. ${to} is not on the list of accounts this agent may pay. No money moved.`;
      case "OVER_PER_PAYMENT_CAP": return `Blocked. One payment can be at most ${cap}. No money moved.`;
      case "NEEDS_APPROVAL": return `Blocked. Payments above ${threshold} need the guardian's OK, and there was none. No money moved.`;
      case "OVER_BUDGET": return "Blocked. There is not enough budget left for this payment.";
      case "EXPIRED": return "Blocked. This mandate has expired.";
      case "NOT_ACTIVE": return "Blocked. The owner has switched this mandate off.";
      case "TOO_MANY_OPEN": return "Too many payments are still settling. Try again in a few seconds.";
      default: return "Blocked by the contract. No money moved.";
    }
  };

  const explain = (o: PaymentOutcome, to: string, u: string): Pick<Attempt, "verdict" | "text" | "code"> => {
    switch (o.kind) {
      case "settled": return { verdict: "paid", text: `Paid. ${amt(u)} went to ${name(to)}, because it was inside every rule.` };
      case "rejected": return { verdict: "blocked", code: o.code, text: why(o.code, name(to)) };
      case "refunded": return { verdict: "unclear", code: "REFUNDED", text: "The contract approved it, but the token transfer failed (the recipient is probably not registered with the token), so the money went back into the budget." };
      case "failed": return { verdict: "error", text: `The transaction failed: ${o.detail.slice(0, 160)}` };
      default: return { verdict: "unclear", text: "Sent. Open the transaction to read the result." };
    }
  };

  const refresh = useCallback(async () => {
    try {
      const { JsonRpcProvider } = await nearLib();
      const p = new JsonRpcProvider({ url: RPC_URL });
      setStats((await p.callFunction({ contractId: t.contractId, method: "get_stats", args: { id: t.mandateId } })) as Stats);
      setStatsError(null);
    } catch (e) {
      setStatsError(e instanceof Error ? e.message.slice(0, 160) : "Could not read the mandate.");
    }
  }, [t.contractId, t.mandateId]);

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

  /** Runs one attempt: shows it as pending, then fills in what happened. */
  const attempt = async (title: string, how: string, run: () => Promise<Pick<Attempt, "verdict" | "text" | "code" | "txHash">>) => {
    if (busy || now() - lastSend.current < COOLDOWN_MS) return;
    lastSend.current = now();
    setBusy(true);
    const id = ++seq.current;
    setLog((l) => [{ id, at: new Date().toISOString(), title, how, state: "pending" as const }, ...l].slice(0, 12));
    let patch: Partial<Attempt>;
    try {
      patch = await run();
    } catch (e) {
      patch = { verdict: "error", text: e instanceof Error ? e.message.slice(0, 220) : String(e) };
    }
    setLog((l) => l.map((a) => (a.id === id ? { ...a, ...patch, state: "done" } : a)));
    setBusy(false);
    refresh();
  };

  const agentKit = async () => {
    const lib = await nearLib();
    const provider = new lib.JsonRpcProvider({ url: RPC_URL });
    const keyPair = lib.KeyPair.fromString(t.agentKey as `ed25519:${string}`);
    const signer = new lib.KeyPairSigner(keyPair);
    return { lib, provider, keyPair, signer, agent: new lib.Account(t.agentId, provider, signer) };
  };

  /** Signs a request_payment delegate (NEP-366) for the relayer. */
  const signPayment = async (to: string, u: string) => {
    const { lib, provider, keyPair, signer } = await agentKit();
    const [key, block] = await Promise.all([
      provider.viewAccessKey({ accountId: t.agentId, publicKey: t.agentPublicKey }),
      provider.viewBlock({ finality: "final" }),
    ]);
    const delegate = lib.buildDelegateAction({
      senderId: t.agentId,
      receiverId: t.contractId,
      actions: [lib.actions.functionCall("request_payment", { mandate_id: t.mandateId, recipient: to, amount: u, nonce: now() }, BigInt(GAS), BigInt(0))],
      nonce: BigInt(key.nonce) + BigInt(1),
      maxBlockHeight: BigInt(block.header.height) + BigInt(100),
      publicKey: keyPair.getPublicKey(),
    });
    const { signedDelegate } = await signer.signDelegateAction(delegate);
    return toBase64(lib.encodeSignedDelegate(signedDelegate));
  };
  const postRelay = async (b64: string): Promise<RelayReply> => {
    const res = await fetch("/api/relay", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ signed_delegate: b64 }) });
    return (await res.json()) as RelayReply;
  };

  /** One payment request, through the relayer (gasless) or paid by the agent key. */
  const payOnce = async (to: string, u: string) => {
    if (via === "relayer") {
      let reply = await postRelay(await signPayment(to, u));
      if (!reply.ok && reply.code === "NONCE_TOO_LOW") reply = await postRelay(await signPayment(to, u));
      if (!reply.ok) return { verdict: "error" as const, code: reply.code, txHash: reply.tx_hash, text: `The relayer refused it: ${RELAY_EXPLAIN[reply.code ?? ""] ?? reply.code}` };
      return { ...explain(relayOutcome(reply), to, u), txHash: reply.tx_hash };
    }
    const { agent } = await agentKit();
    const call = () => agent.callFunctionRaw({ contractId: t.contractId, methodName: "request_payment", args: { mandate_id: t.mandateId, recipient: to, amount: u, nonce: now() }, gas: BigInt(GAS), deposit: BigInt(0) });
    let outcome;
    try {
      outcome = await call();
    } catch (e) {
      // Two visitors can race for the same access-key nonce: retry once with a fresh one.
      if (e instanceof Error && /nonce/i.test(e.message)) outcome = await call();
      else throw e;
    }
    return { ...explain(parsePaymentOutcome(outcome), to, u), txHash: (outcome as { transaction?: { hash?: string } }).transaction?.hash };
  };

  const howPay = () => (via === "relayer" ? "gasless, through the Scrip relayer" : "the agent key paid the gas");
  const pay = (title: string, to: string, u: string) => attempt(title, howPay(), () => payOnce(to, u));

  /** Uses the stolen key for something other than asking for a payment. NEAR itself refuses it. */
  const misuseKey = (title: string, kind: "transfer" | "withdraw") =>
    attempt(title, "signed with the agent key, sent straight to NEAR", async () => {
      const { agent } = await agentKit();
      try {
        const o = kind === "transfer"
          ? await agent.transfer({ receiverId: ATTACKER, amount: BigInt(1) })
          : await agent.callFunctionRaw({ contractId: t.contractId, methodName: "withdraw", args: { mandate_id: t.mandateId, amount: "1" }, gas: BigInt("100000000000000"), deposit: BigInt(0) });
        return { verdict: "unclear", text: "NEAR accepted the transaction. Open it to see what the contract did.", txHash: (o as { transaction?: { hash?: string } }).transaction?.hash };
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        if (PROTOCOL_REFUSAL.test(msg)) {
          return {
            verdict: "blocked",
            code: "KEY_NOT_ALLOWED",
            text: kind === "transfer"
              ? "Blocked by NEAR itself. This key can only ask the contract for payments, so it cannot send NEAR. The transaction was never accepted."
              : "Blocked by NEAR itself. This key may call one method, request_payment. Withdrawing is the owner's job, so NEAR refused before the contract even saw it.",
          };
        }
        throw e;
      }
    });

  /** Sends the exact same signed payment twice. */
  const replay = () =>
    attempt(`Replay a signed payment to ${name(t.recipients[0])}`, "the same signed bytes, sent to the relayer twice", async () => {
      const b64 = await signPayment(t.recipients[0], firstAmount);
      const first = await postRelay(b64);
      const second = await postRelay(b64);
      const firstText = first.ok ? explain(relayOutcome(first), t.recipients[0], firstAmount).text : `The first copy was refused (${first.code}).`;
      const secondPaid = second.ok && relayOutcome(second).kind === "settled";
      return {
        verdict: secondPaid ? "unclear" : "blocked",
        code: second.ok ? second.inner_code : second.code,
        txHash: first.tx_hash,
        text: secondPaid
          ? `${firstText} The copy also went through: please report this.`
          : `${firstText} The identical copy was refused: a signed payment can be used once.`,
      };
    });

  const big = (BigInt(t.perPaymentCap) * BigInt(2)).toString();
  const lastShop = t.recipients[t.recipients.length - 1];
  type AttackKey = "ok" | "stranger" | "big" | "guardian" | "near" | "withdraw" | "replay";
  const attacks: { key: AttackKey; title: string; hint: string; allowed?: boolean }[] = [
    { key: "ok", title: `Pay ${name(t.recipients[0])} ${amt(firstAmount)}`, hint: "Allowed. This one should go through.", allowed: true },
    { key: "stranger", title: "Send money to a stranger", hint: `${ATTACKER} is not on the list.` },
    { key: "big", title: `Pay too much (${amt(big)})`, hint: `The limit is ${cap} per payment.` },
    ...(needsApprovalBand ? [{ key: "guardian" as const, title: `Skip the guardian (${cap})`, hint: `Above ${threshold} needs the guardian's OK.` }] : []),
    { key: "near", title: "Use the key to send NEAR", hint: "Try to empty the agent's own account." },
    { key: "withdraw", title: "Use the key to withdraw the budget", hint: "Call the owner's withdraw method." },
    ...(relayerUp ? [{ key: "replay" as const, title: "Replay a signed payment", hint: "Send the same signed payment twice." }] : []),
  ];
  const runAttack = (key: AttackKey) => {
    switch (key) {
      case "ok": return pay(`Pay ${name(t.recipients[0])} ${amt(firstAmount)}`, t.recipients[0], firstAmount);
      case "stranger": return pay(`Send ${amt(firstAmount)} to ${ATTACKER}`, ATTACKER, firstAmount);
      case "big": return pay(`Pay ${name(lastShop)} ${amt(big)}`, lastShop, big);
      case "guardian": return pay(`Pay ${name(lastShop)} ${cap} without approval`, lastShop, t.perPaymentCap);
      case "near": return misuseKey("Send 1 yoctoNEAR to attacker.testnet with the agent key", "transfer");
      case "withdraw": return misuseKey("Call withdraw on the mandate with the agent key", "withdraw");
      case "replay": return replay();
    }
  };

  const target_ = recipient === "custom" ? custom.trim() : recipient;
  const units = toUnits(amount, t.decimals);
  const inputError = !isValidAccountId(target_)
    ? "Enter a valid NEAR account id (lowercase, for example someone.testnet)."
    : units === null
      ? `Amount must be a positive number with up to ${t.decimals} decimals.`
      : null;

  const left = stats ? fromUnits(remaining(stats), t.decimals) : null;
  const spentPct = stats ? Math.min(100, Number((BigInt(stats.spent) * BigInt(10000)) / BigInt(stats.budget || "1")) / 100) : 0;
  const blocked = log.filter((a) => a.verdict === "blocked").length;

  const copyKey = () => {
    navigator.clipboard?.writeText(t.agentKey).then(() => { setCopied(true); setTimeout(() => setCopied(false), 1800); }).catch(() => {});
  };

  return (
    <div className="nl-play">
      <section className="nl-play-wallet" aria-labelledby={`${rid}-w`}>
        <h2 id={`${rid}-w`} className="nl-play-h">The agent&apos;s wallet</h2>
        <p className="nl-play-left"><b>{left ?? "…"}</b> {sym} left</p>
        <div className="nl-live-meter" role="img" aria-label={`Budget used: ${spentPct.toFixed(1)} percent`}><span style={{ width: `${spentPct}%` }} /></div>
        <p className="nl-play-sub">of a {amt(t.budget)} budget{stats ? `, ${amt(stats.spent)} spent so far` : ""}</p>

        <h3 className="nl-play-h3">Its rules</h3>
        <ul className="nl-play-rules">
          <li>May pay only {t.recipients.map((r, i) => (
            <span key={r}>{i > 0 ? (i === t.recipients.length - 1 ? " and " : ", ") : ""}<a className="bp-app-inline" href={`${EXPLORER_ACCOUNT_BASE}/${r}`} target="_blank" rel="noopener noreferrer">{name(r)}</a></span>
          ))}</li>
          <li>At most {cap} per payment</li>
          {needsApprovalBand ? <li>Above {threshold} needs the guardian&apos;s OK</li> : null}
        </ul>

        <h3 className="nl-play-h3">Its key: you have it</h3>
        {t.publicDemo ? (
          <>
            <p className="nl-play-key font-mono">{t.agentKey.slice(0, 18)}…{t.agentKey.slice(-6)}</p>
            <div className="nl-play-keyrow">
              <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" onClick={copyKey}>{copied ? "Copied" : "Copy the full key"}</button>
              <span className="nl-play-note">Published on purpose. Use it anywhere you like.</span>
            </div>
          </>
        ) : (
          <p className="nl-play-key font-mono">{shortAcct(t.agentPublicKey)}</p>
        )}
        <p className="nl-play-note">
          NEAR only lets this key ask <a className="bp-app-inline" href={`${EXPLORER_ACCOUNT_BASE}/${t.contractId}`} target="_blank" rel="noopener noreferrer">the contract</a> for
          a payment. The contract checks the rules above every time.
        </p>
        {statsError ? <p className="text-bp-reject text-xs" role="alert">Could not read the wallet right now: {statsError}</p> : null}
      </section>

      <section className="nl-play-main" aria-labelledby={`${rid}-a`}>
        <h2 id={`${rid}-a`} className="nl-play-h">Try to steal from it</h2>
        <ul className="nl-play-attacks" role="list">
          {attacks.map((a) => (
            <li key={a.key}>
              <button type="button" className={`nl-play-attack${a.allowed ? " is-allowed" : ""}`} onClick={() => runAttack(a.key)} disabled={busy}>
                <span className="nl-play-attack-t">{a.title}</span>
                <span className="nl-play-attack-h">{a.hint}</span>
              </button>
            </li>
          ))}
        </ul>

        <details className="nl-fold nl-play-custom">
          <summary>Write your own attempt</summary>
          <div className="nl-live-form">
            <div>
              <label htmlFor={`${rid}-to`} className="bp-app-label">Pay to</label>
              <select id={`${rid}-to`} className="bp-app-input" value={recipient} onChange={(e) => setRecipient(e.target.value)}>
                {t.recipients.map((r) => <option key={r} value={r}>{name(r)} (allowed)</option>)}
                <option value={ATTACKER}>{ATTACKER} (not allowed)</option>
                <option value="custom">Another account…</option>
              </select>
              {recipient === "custom" ? <input aria-label="Account id" className="bp-app-input" value={custom} placeholder="someone.testnet" onChange={(e) => setCustom(e.target.value)} autoComplete="off" spellCheck={false} /> : null}
            </div>
            <div>
              <label htmlFor={`${rid}-amt`} className="bp-app-label">Amount ({sym})</label>
              <input id={`${rid}-amt`} className="bp-app-input" inputMode="decimal" value={amount} onChange={(e) => setAmount(e.target.value)} />
            </div>
          </div>
          {relayerUp ? (
            <fieldset className="nl-live-payer">
              <legend className="bp-app-label">Who pays the gas</legend>
              <label><input type="radio" name={`${rid}-payer`} checked={payer === "relayer"} onChange={() => setPayer("relayer")} /> The Scrip relayer (the agent needs no NEAR)</label>
              <label><input type="radio" name={`${rid}-payer`} checked={payer === "agent"} onChange={() => setPayer("agent")} /> The agent key&apos;s own gas allowance</label>
            </fieldset>
          ) : null}
          {inputError ? <p className="text-bp-reject text-xs" style={{ marginTop: 10 }}>{inputError}</p> : null}
          <div className="bp-app-try-actions">
            <button type="button" className="bp-btn bp-btn-primary" disabled={busy || !!inputError} onClick={() => { if (!inputError && units) pay(`Pay ${name(target_)} ${amount.trim()} ${sym}`, target_, units); }}>
              {busy ? "Sending…" : "Send it"}
            </button>
          </div>
        </details>

        <h3 className="nl-play-h3" style={{ marginTop: 32 }}>
          What happened {blocked > 0 ? <span className="bp-kicker">{blocked} blocked so far</span> : null}
        </h3>
        <ol className="nl-play-log" aria-live="polite">
          {log.length === 0 ? <li className="nl-play-empty">Nothing yet. Press a button above: each one is a real attempt on NEAR testnet.</li> : null}
          {log.map((a) => (
            <li key={a.id} data-verdict={a.verdict ?? "pending"}>
              <div className="nl-play-row">
                <span className="nl-play-title">{a.title}</span>
                <Badge a={a} />
              </div>
              {a.state === "done" && a.text ? <p className="nl-play-text">{a.text}</p> : null}
              <p className="nl-play-meta">
                <time dateTime={a.at}>{a.at.slice(11, 19)} UTC</time> · {a.how}
                {a.code ? <> · <span className="font-mono">{a.code}</span></> : null}
                {a.txHash ? <> · <a className="bp-app-inline font-mono" href={`${EXPLORER_TX_BASE}/${a.txHash}`} target="_blank" rel="noopener noreferrer">transaction {short(a.txHash)} ↗</a></> : null}
              </p>
            </li>
          ))}
        </ol>
      </section>
    </div>
  );
}

function Badge({ a }: { a: Attempt }) {
  if (a.state === "pending") return <span className="bp-app-checking" role="status">Sending to testnet…</span>;
  if (a.verdict === "paid") return <span className="bp-app-chip bp-app-chip-pass">PAID</span>;
  if (a.verdict === "blocked") return <span className="bp-app-chip bp-app-chip-reject">BLOCKED</span>;
  if (a.verdict === "error") return <span className="bp-app-chip">ERROR</span>;
  return <span className="bp-app-chip">SENT</span>;
}
