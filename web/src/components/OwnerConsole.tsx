"use client";

import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Link from "next/link";
import { LiveTry, type TryTarget } from "@/components/LiveTry";
import { useWallet } from "@/lib/wallet";
import { LIVE, isValidAccountId } from "@/lib/live";
import { EXPLORER_ACCOUNT_BASE, EXPLORER_TX_BASE, RPC_URL } from "@/lib/network";
import {
  TOKENS, buildCreateMandateTx, buildFundTx, buildRevokeTx, buildSetupTxs, buildWithdrawTx, canCreateSubaccounts,
  checkMandate, freeRemainder, fromUnits, mandateIdFromOutcome, outcomeFailed, parseOwned, partyIds, suffixFrom,
  type OwnedMandate, type TokenInfo,
} from "@/lib/owner-flow";

const STORE = "scrip.owned.v1";
const AGENT_NEAR = "0.3";
const ALLOWANCE_NEAR = "0.25";
const GUARDIAN_NEAR = "0.05";

type MandateView = { owner: string; status: string; deposited: string; spent: string; reserved: string; withdrawn: string; budget: string };

function loadOwned(): OwnedMandate[] {
  try { return parseOwned(window.localStorage.getItem(STORE)); } catch { return []; }
}
function saveOwned(list: OwnedMandate[]) {
  try { window.localStorage.setItem(STORE, JSON.stringify(list)); } catch { /* storage blocked: keys live only in memory */ }
}
const txHashOf = (o: unknown) => (o as { transaction?: { hash?: string } } | null)?.transaction?.hash ?? "";
const short = (h: string) => `${h.slice(0, 6)}…${h.slice(-4)}`;
const errText = (e: unknown) => (e instanceof Error ? e.message : String(e)).slice(0, 280);

async function viewMandate(contractId: string, id: number): Promise<MandateView | null> {
  const { JsonRpcProvider } = await import("near-api-js");
  const p = new JsonRpcProvider({ url: RPC_URL });
  return (await p.callFunction({ contractId, method: "get_mandate", args: { id } })) as MandateView | null;
}

export function OwnerConsole() {
  const w = useWallet();
  const ids = { token: useId(), budget: useId(), cap: useId(), thr: useId(), rec: useId(), days: useId() };
  const [tokenKey, setTokenKey] = useState<"wnear" | "usdc">("wnear");
  const token: TokenInfo = TOKENS[tokenKey];
  const [budget, setBudget] = useState("0.5");
  const [cap, setCap] = useState("0.1");
  const [threshold, setThreshold] = useState("0.1");
  const [recipientsText, setRecipientsText] = useState(LIVE.recipients.join("\n"));
  const [days, setDays] = useState("7");
  const [owned, setOwned] = useState<OwnedMandate[]>([]);
  const [activeAgent, setActiveAgent] = useState<string | null>(null);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [view, setView] = useState<MandateView | null>(null);

  useEffect(() => {
    const t = setTimeout(() => setOwned(loadOwned()), 0);
    return () => clearTimeout(t);
  }, []);

  const mine = useMemo(() => owned.filter((m) => m.ownerId === w.accountId), [owned, w.accountId]);
  const active = mine.find((m) => m.agentId === activeAgent) ?? mine[mine.length - 1] ?? null;

  const persist = useCallback((next: OwnedMandate) => {
    setOwned((prev) => {
      const list = [...prev.filter((m) => m.agentId !== next.agentId), next];
      saveOwned(list);
      return list;
    });
  }, []);

  const activeContract = active?.contractId ?? null;
  const activeId = active?.mandateId ?? null;
  const refreshView = async () => {
    if (activeContract === null || activeId === null) { setView(null); return; }
    try { setView(await viewMandate(activeContract, activeId)); } catch { /* keep last */ }
  };

  useEffect(() => {
    let alive = true;
    const t = setTimeout(async () => {
      if (activeContract === null || activeId === null) { if (alive) setView(null); return; }
      try { const m = await viewMandate(activeContract, activeId); if (alive) setView(m); } catch { /* keep last */ }
    }, 0);
    return () => { alive = false; clearTimeout(t); };
  }, [activeContract, activeId]);

  const recipients = recipientsText.split(/[\s,]+/).map((s) => s.trim()).filter(Boolean);
  const badRecipient = recipients.find((r) => !isValidAccountId(r));
  const owner = w.accountId ?? "";
  const lifetimeMs = Math.max(1, Math.min(90, Number(days) || 7)) * 86_400_000;
  const draftIds = partyIds(owner || "you.testnet", "xxxxxx");
  const check = owner
    ? checkMandate(owner, { contractId: LIVE.contractId, agentId: draftIds.agentId, guardianId: draftIds.guardianId, token, budget, perPaymentCap: cap, approvalThreshold: threshold, recipients, expiresAtMs: lifetimeMs }, 0)
    : null;
  const formError = badRecipient ? `Not a valid account id: ${badRecipient}` : check && !check.ok ? check.error : null;
  const nearNeeded = (Number(AGENT_NEAR) + Number(GUARDIAN_NEAR) + 0.05 + 0.00125 * (recipients.length + 2) + (token.wrapsNear ? Number(budget) || 0 : 0)).toFixed(3);

  const create = async () => {
    if (!owner || !check || !check.ok || badRecipient) return;
    setError(null);
    setBusy("Waiting for your wallet…");
    try {
      const { KeyPair } = await import("near-api-js");
      const expiresAtMs = Date.now() + lifetimeMs;
      const agentKp = KeyPair.fromRandom("ed25519");
      const guardKp = KeyPair.fromRandom("ed25519");
      const { agentId, guardianId } = partyIds(owner, suffixFrom(crypto.getRandomValues(new Uint8Array(6))));
      const record: OwnedMandate = {
        v: 1, ownerId: owner, contractId: LIVE.contractId, mandateId: null,
        agentId, agentPublicKey: agentKp.getPublicKey().toString(), agentKey: agentKp.toString(),
        guardianId, guardianKey: guardKp.toString(), token, recipients,
        budget: check.budget, perPaymentCap: check.cap, approvalThreshold: check.threshold, expiresAtMs,
        createdAt: new Date().toISOString(), funded: false, txs: {},
      };
      // Keys first: if the wallet redirects or the tab closes, nothing is lost.
      persist(record);
      setActiveAgent(agentId);
      const input = { contractId: LIVE.contractId, agentId, guardianId, token, budget, perPaymentCap: cap, approvalThreshold: threshold, recipients, expiresAtMs };
      const txs = [
        ...buildSetupTxs({ contractId: LIVE.contractId, agentId, guardianId, agentPublicKey: record.agentPublicKey, guardianPublicKey: guardKp.getPublicKey().toString(), agentNear: AGENT_NEAR, allowanceNear: ALLOWANCE_NEAR, guardianNear: GUARDIAN_NEAR }),
        buildCreateMandateTx(input, check),
      ];
      const outcomes = await w.sendMany(txs);
      const failed = outcomes.map(outcomeFailed).find(Boolean);
      if (failed) throw new Error(`A transaction failed on-chain: ${failed}`);
      const mandateId = mandateIdFromOutcome(outcomes[outcomes.length - 1]);
      if (mandateId === null) throw new Error("The mandate was created but its id could not be read. Check the transaction on the explorer.");
      persist({ ...record, mandateId, txs: { agent: txHashOf(outcomes[0]), guardian: txHashOf(outcomes[1]), mandate: txHashOf(outcomes[2]) } });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const fund = async () => {
    if (!active || active.mandateId === null) return;
    setError(null);
    setBusy("Waiting for your wallet…");
    try {
      const o = await w.send(buildFundTx({ token: active.token, contractId: active.contractId, ownerId: active.ownerId, mandateId: active.mandateId, amountUnits: active.budget, recipients: active.recipients }));
      const failed = outcomeFailed(o);
      if (failed) throw new Error(`Funding failed on-chain: ${failed}`);
      const m = await viewMandate(active.contractId, active.mandateId);
      setView(m);
      persist({ ...active, funded: !!m && BigInt(m.deposited) > BigInt(0), txs: { ...active.txs, fund: txHashOf(o) } });
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const revoke = async () => {
    if (!active || active.mandateId === null) return;
    setError(null);
    setBusy("Waiting for your wallet…");
    try {
      const o = await w.send(buildRevokeTx(active.contractId, active.mandateId));
      const failed = outcomeFailed(o);
      if (failed) throw new Error(`Revoke failed: ${failed}`);
      persist({ ...active, txs: { ...active.txs, revoke: txHashOf(o) } });
      await refreshView();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const withdraw = async () => {
    if (!active || active.mandateId === null || !view) return;
    const amount = freeRemainder(view);
    if (amount === "0") { setError("Nothing left to withdraw."); return; }
    setError(null);
    setBusy("Waiting for your wallet…");
    try {
      const o = await w.send(buildWithdrawTx(active.contractId, active.mandateId, amount));
      const failed = outcomeFailed(o);
      if (failed) throw new Error(`Withdraw failed: ${failed}`);
      persist({ ...active, txs: { ...active.txs, withdraw: txHashOf(o) } });
      await refreshView();
    } catch (e) {
      setError(errText(e));
    } finally {
      setBusy(null);
    }
  };

  const downloadKeys = () => {
    if (!active) return;
    const blob = new Blob([JSON.stringify(active, null, 2)], { type: "application/json" });
    const a = document.createElement("a");
    a.href = URL.createObjectURL(blob);
    a.download = `scrip-mandate-${active.mandateId ?? "draft"}-keys.json`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(a.href), 1000);
  };

  const forget = () => {
    if (!active) return;
    setOwned((prev) => {
      const list = prev.filter((m) => m.agentId !== active.agentId);
      saveOwned(list);
      return list;
    });
    setActiveAgent(null);
  };

  const target: TryTarget | null = active && active.mandateId !== null && active.funded
    ? {
      contractId: active.contractId, mandateId: active.mandateId, agentId: active.agentId, agentKey: active.agentKey,
      agentPublicKey: active.agentPublicKey, recipients: active.recipients, budget: active.budget,
      perPaymentCap: active.perPaymentCap, approvalThreshold: active.approvalThreshold,
      symbol: active.token.symbol, decimals: active.token.decimals, publicDemo: false,
    }
    : null;

  const status = view?.status === "Revoked" ? "Revoked" : view ? "Active" : null;
  const free = view ? freeRemainder(view) : "0";

  return (
    <div className="bp-app-stack nl-owner">
      <section className="bp-plate bp-app-plate bp-app-enter" aria-labelledby="owner-wallet">
        <div className="nl-owner-head">
          <div>
            <span className="bp-chapter-label">Step 1</span>
            <h2 id="owner-wallet" className="bp-app-section-title">Connect a testnet wallet</h2>
          </div>
          {w.accountId ? (
            <div className="nl-owner-acct">
              <span className="bp-app-chip bp-app-chip-pass">Connected</span>
              <a className="bp-app-inline font-mono" href={`${EXPLORER_ACCOUNT_BASE}/${w.accountId}`} target="_blank" rel="noopener noreferrer">{w.accountId}</a>
              <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" onClick={() => w.disconnect()}>Disconnect</button>
            </div>
          ) : (
            <button type="button" className="bp-btn bp-btn-primary" onClick={() => w.connect().catch((e) => setError(errText(e)))} disabled={!w.ready}>
              {w.ready ? "Connect wallet" : "Loading wallets…"}
            </button>
          )}
        </div>
        <p className="bp-app-hint">
          Meteor, Intear, Nightly, Ledger and other NEAR wallets that support <b>testnet</b>. No testnet NEAR yet? Get some from the{" "}
          <a className="bp-app-inline" href="https://near-faucet.io" target="_blank" rel="noopener noreferrer">NEAR testnet faucet</a>.
          You will sign every step yourself; this page never sees your wallet key.
        </p>
        {w.accountId && !canCreateSubaccounts(w.accountId) ? (
          <p className="text-bp-reject text-xs" role="alert">
            This flow creates the agent and the guardian as sub-accounts of your account, so it needs a named testnet account (like <span className="font-mono">you.testnet</span>, at most 45 characters). Implicit or EVM accounts cannot create sub-accounts.
          </p>
        ) : null}
      </section>

      {!w.accountId ? (
        <ol className="nl-steps" aria-label="What happens after you connect">
          <li><b>Set the rules</b><span>Token, budget, cap per payment, guardian threshold, allowed shops, expiry. One approval creates the agent, the guardian and the mandate.</span></li>
          <li><b>Fund it</b><span>wNEAR (wrapped in the same transaction) or testnet USDC goes into the mandate, not to the agent.</span></li>
          <li><b>Be your own agent</b><span>Pay with the agent&apos;s key, gasless through the relayer. Then try to overspend.</span></li>
          <li><b>Revoke and withdraw</b><span>Stop the agent at any time and take back what is left.</span></li>
        </ol>
      ) : null}

      {w.accountId && canCreateSubaccounts(w.accountId) ? (
        <section className="bp-plate bp-app-plate bp-app-enter" aria-labelledby="owner-create">
          <span className="bp-chapter-label">Step 2</span>
          <h2 id="owner-create" className="bp-app-section-title">Set the rules and create the mandate</h2>
          <div className="nl-owner-form">
            <div>
              <label className="bp-app-label" htmlFor={ids.token}>Token</label>
              <select id={ids.token} className="bp-app-input" value={tokenKey} onChange={(e) => setTokenKey(e.target.value as "wnear" | "usdc")}>
                <option value="wnear">wNEAR (wrapped from your testnet NEAR)</option>
                <option value="usdc">Testnet USDC (you must already hold it)</option>
              </select>
            </div>
            <div>
              <label className="bp-app-label" htmlFor={ids.budget}>Total budget ({token.symbol})</label>
              <input id={ids.budget} className="bp-app-input" inputMode="decimal" value={budget} onChange={(e) => setBudget(e.target.value)} />
            </div>
            <div>
              <label className="bp-app-label" htmlFor={ids.cap}>Per payment, at most ({token.symbol})</label>
              <input id={ids.cap} className="bp-app-input" inputMode="decimal" value={cap} onChange={(e) => setCap(e.target.value)} />
            </div>
            <div>
              <label className="bp-app-label" htmlFor={ids.thr}>Guardian approval above ({token.symbol})</label>
              <input id={ids.thr} className="bp-app-input" inputMode="decimal" value={threshold} onChange={(e) => setThreshold(e.target.value)} />
            </div>
            <div className="nl-owner-wide">
              <label className="bp-app-label" htmlFor={ids.rec}>Allowed recipients (one per line, up to 16)</label>
              <textarea id={ids.rec} className="bp-app-input" rows={3} value={recipientsText} onChange={(e) => setRecipientsText(e.target.value)} spellCheck={false} />
            </div>
            <div>
              <label className="bp-app-label" htmlFor={ids.days}>Expires in (days)</label>
              <input id={ids.days} className="bp-app-input" inputMode="numeric" value={days} onChange={(e) => setDays(e.target.value)} />
            </div>
          </div>
          {formError ? <p className="text-bp-reject text-xs" role="alert" style={{ marginTop: 10 }}>{formError}</p> : null}
          <p className="bp-app-hint" style={{ marginTop: 12 }}>
            One wallet approval sends three transactions: create <span className="font-mono">scrip-agent-…</span> with a key that can only call <code>request_payment</code> ({AGENT_NEAR} NEAR for its gas), create <span className="font-mono">scrip-guard-…</span> ({GUARDIAN_NEAR} NEAR), and call <code>create_mandate</code> on <a className="bp-app-inline font-mono" href={`${EXPLORER_ACCOUNT_BASE}/${LIVE.contractId}`} target="_blank" rel="noopener noreferrer">{LIVE.contractId}</a> (0.05 NEAR storage). Funding is the next step. In total you need about <b>{nearNeeded} NEAR</b>{token.wrapsNear ? " including the budget" : ` plus ${budget} USDC`}.
          </p>
          <div className="bp-app-try-actions">
            <button type="button" className="bp-btn bp-btn-primary" onClick={create} disabled={!!busy || !!formError} aria-disabled={!!busy || !!formError}>
              {busy ?? "Create agent, guardian and mandate"}
            </button>
          </div>
        </section>
      ) : null}

      {active ? (
        <section className="bp-plate bp-app-plate bp-app-enter" aria-labelledby="owner-mine">
          <span className="bp-chapter-label">Step 3</span>
          <h2 id="owner-mine" className="bp-app-section-title">
            Your mandate {active.mandateId !== null ? `#${active.mandateId}` : "(not created yet)"} {status ? <span className={`bp-app-chip ${status === "Active" ? "bp-app-chip-pass" : ""}`}>{status}</span> : null}
          </h2>
          {mine.length > 1 ? (
            <label className="bp-app-label">
              Switch mandate{" "}
              <select className="bp-app-input" value={active.agentId} onChange={(e) => setActiveAgent(e.target.value)}>
                {mine.map((m) => <option key={m.agentId} value={m.agentId}>#{m.mandateId ?? "?"} · {m.token.symbol} · {m.createdAt.slice(0, 16).replace("T", " ")}</option>)}
              </select>
            </label>
          ) : null}
          <dl className="nl-live-facts">
            <div><dt>Agent</dt><dd className="font-mono"><a className="bp-app-inline" href={`${EXPLORER_ACCOUNT_BASE}/${active.agentId}`} target="_blank" rel="noopener noreferrer">{active.agentId}</a></dd></div>
            <div><dt>Guardian</dt><dd className="font-mono"><a className="bp-app-inline" href={`${EXPLORER_ACCOUNT_BASE}/${active.guardianId}`} target="_blank" rel="noopener noreferrer">{active.guardianId}</a></dd></div>
            <div><dt>Deposited</dt><dd>{view ? fromUnits(view.deposited, active.token.decimals) : "…"} {active.token.symbol}</dd></div>
            <div><dt>Free to withdraw</dt><dd>{view ? fromUnits(free, active.token.decimals) : "…"} {active.token.symbol}</dd></div>
          </dl>
          <ul className="nl-owner-txs">
            {Object.entries(active.txs).filter(([, h]) => h).map(([k, h]) => (
              <li key={k}><span>{k}</span> <a className="bp-app-inline font-mono" href={`${EXPLORER_TX_BASE}/${h}`} target="_blank" rel="noopener noreferrer">{short(h)} ↗</a></li>
            ))}
          </ul>
          <div className="bp-app-try-actions">
            {active.mandateId !== null && !active.funded ? (
              <button type="button" className="bp-btn bp-btn-primary" onClick={fund} disabled={!!busy}>
                {busy ?? `Fund it with ${fromUnits(active.budget, active.token.decimals)} ${active.token.symbol}`}
              </button>
            ) : null}
            {active.mandateId !== null ? <Link className="bp-btn bp-btn-secondary bp-btn-sm" href={`/mandates/${active.mandateId}`}>Open in the dashboard</Link> : null}
            {status === "Active" ? <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" onClick={revoke} disabled={!!busy}>Revoke</button> : null}
            {status === "Revoked" && free !== "0" ? <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" onClick={withdraw} disabled={!!busy}>Withdraw {fromUnits(free, active.token.decimals)} {active.token.symbol}</button> : null}
            <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" onClick={downloadKeys}>Download keys</button>
            <button type="button" className="bp-btn bp-btn-secondary bp-btn-sm" onClick={forget}>Forget in this browser</button>
          </div>
          <p className="bp-app-hint" style={{ marginTop: 12 }}>
            The agent and guardian keys were made in this browser and are kept only here (testnet). Hand the agent key to your own agent with &quot;Download keys&quot;: it can call <code>request_payment</code> and nothing else. The guardian key can approve large payments and loosen rules.
          </p>
        </section>
      ) : null}

      {error ? <p className="text-bp-reject text-xs" role="alert">{error}</p> : null}

      {target ? (
        <section aria-labelledby="owner-try">
          <span className="bp-chapter-label">Step 4</span>
          <h2 id="owner-try" className="bp-app-section-title">Be your own agent</h2>
          <LiveTry key={`${target.contractId}-${target.mandateId}`} target={target} />
        </section>
      ) : null}
    </div>
  );
}
