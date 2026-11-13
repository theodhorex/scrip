"use client";

import { useId, useMemo, useState, useSyncExternalStore } from "react";

const inputBase = "bp-app-input";

function subscribe() {
  return () => {};
}

function getClientTime() {
  return Date.now();
}

function getServerTime() {
  return 0;
}
import type { U128 } from "@/lib/types";
import { TryPayment } from "./TryPayment";

function parseUsdcToU128(input: string): { value: U128; error?: string } {
  const trimmed = input.trim();
  if (!trimmed) {
    return { value: "0", error: "Amount is required" };
  }
  if (!/^\d+(\.\d{1,6})?$/.test(trimmed)) {
    return {
      value: "0",
      error: "Must be a valid positive number with at most 6 decimal places",
    };
  }

  const [wholePart, fracPart = ""] = trimmed.split(".");
  const fracPadded = fracPart.padEnd(6, "0");
  try {
    const whole = BigInt(wholePart);
    const frac = BigInt(fracPadded);
    const total = whole * BigInt(1000000) + frac;
    return { value: total.toString() };
  } catch {
    return { value: "0", error: "Invalid numeric value" };
  }
}

export function NewMandateForm() {
  const agentId = useId();
  const guardianId = useId();
  const tokenId = useId();
  const budgetId = useId();
  const perPaymentCapId = useId();
  const approvalThresholdId = useId();
  const expiryId = useId();
  const recipientsId = useId();

  const [agent, setAgent] = useState("agent.example.testnet");
  const [guardian, setGuardian] = useState("guardian.example.testnet");
  const [token, setToken] = useState("usdc.example.testnet");
  const [budgetUsdc, setBudgetUsdc] = useState("50");
  const [perPaymentCapUsdc, setPerPaymentCapUsdc] = useState("5");
  const [approvalThresholdUsdc, setApprovalThresholdUsdc] = useState("2");

  const [expiryStr, setExpiryStr] = useState("2026-11-14T23:59");
  const currentTimeMs = useSyncExternalStore(
    subscribe,
    getClientTime,
    getServerTime
  );
  const [recipientsText, setRecipientsText] = useState(
    "merchant-a.example.testnet\nmerchant-b.example.testnet"
  );

  // Parsing and validation
  const budgetParsed = parseUsdcToU128(budgetUsdc);
  const capParsed = parseUsdcToU128(perPaymentCapUsdc);
  const thresholdParsed = parseUsdcToU128(approvalThresholdUsdc);

  const recipientList = useMemo(() => {
    return recipientsText
      .split("\n")
      .map((r) => r.trim())
      .filter((r) => r.length > 0);
  }, [recipientsText]);

  const expiryMs = useMemo(() => {
    if (!expiryStr) return 0;
    const ms = new Date(`${expiryStr}:00Z`).getTime();
    return Number.isNaN(ms) ? 0 : ms;
  }, [expiryStr]);

  const validationErrors = useMemo(() => {
    const errors: string[] = [];

    if (!agent.trim()) {
      errors.push("Agent account is required.");
    }
    if (!guardian.trim()) {
      errors.push("Guardian account is required.");
    }
    if (agent.trim() && guardian.trim() && agent.trim() === guardian.trim()) {
      errors.push("Guardian account must be different from agent account.");
    }
    if (!token.trim()) {
      errors.push("Token account is required.");
    }

    if (budgetParsed.error) {
      errors.push(`Budget: ${budgetParsed.error}`);
    }
    if (capParsed.error) {
      errors.push(`Per-payment cap: ${capParsed.error}`);
    }
    if (thresholdParsed.error) {
      errors.push(`Approval threshold: ${thresholdParsed.error}`);
    }

    if (!budgetParsed.error && !capParsed.error) {
      if (BigInt(budgetParsed.value) < BigInt(capParsed.value)) {
        errors.push(
          "Budget must be greater than or equal to per-payment cap."
        );
      }
    }

    if (recipientList.length === 0) {
      errors.push("At least one recipient must be listed in allowlist.");
    }

    if (currentTimeMs > 0 && expiryMs <= currentTimeMs) {
      errors.push("Expiry date must be in the future.");
    }

    return errors;
  }, [
    agent,
    guardian,
    token,
    budgetParsed,
    capParsed,
    thresholdParsed,
    recipientList,
    expiryMs,
    currentTimeMs,
  ]);

  const mandateArgsPreview = useMemo(() => {
    return {
      agent: agent.trim(),
      guardian: guardian.trim(),
      token: token.trim(),
      budget: budgetParsed.value,
      per_payment_cap: capParsed.value,
      approval_threshold: thresholdParsed.value,
      expires_at_ms: expiryMs,
      recipients: recipientList,
    };
  }, [
    agent,
    guardian,
    token,
    budgetParsed.value,
    capParsed.value,
    thresholdParsed.value,
    expiryMs,
    recipientList,
  ]);

  return (
    <div className="grid grid-cols-1 lg:grid-cols-2 gap-6 items-start">
      <form
        onSubmit={(e) => e.preventDefault()}
        className="bp-plate bp-app-plate space-y-6"
      >
        <div className="border-b border-bp-line pb-4">
          <h2 className="bp-app-section-title" style={{ marginBottom: 0 }}>
            Mandate settings
          </h2>
          <p className="bp-app-hint">
            Change any value: the contract call on the right and the payment check below it update as you type.
          </p>
        </div>

        {validationErrors.length > 0 && (
          <div
            role="alert"
            className="bp-plate bp-plate-reject p-3.5 text-xs text-bp-ink space-y-1"
          >
            <p className="font-semibold text-bp-reject">&#10005; Please correct the following:</p>
            <ul className="list-disc pl-4 space-y-0.5 text-bp-muted">
              {validationErrors.map((err) => (
                <li key={err}>{err}</li>
              ))}
            </ul>
          </div>
        )}

        <div className="space-y-4">
          <div>
            <label
              htmlFor={agentId}
              className="bp-app-label"
            >
              Agent account ID
            </label>
            <input
              id={agentId}
              type="text"
              value={agent}
              onChange={(e) => setAgent(e.target.value)}
              className={`${inputBase} font-mono`}
              placeholder="agent.example.testnet"
              required
            />
          </div>

          <div>
            <label
              htmlFor={guardianId}
              className="bp-app-label"
            >
              Guardian account ID
            </label>
            <input
              id={guardianId}
              type="text"
              value={guardian}
              onChange={(e) => setGuardian(e.target.value)}
              className={`${inputBase} font-mono`}
              placeholder="guardian.example.testnet"
              required
            />
            <p className="bp-app-hint">
              Must be distinct from the agent account.
            </p>
          </div>

          <div>
            <label
              htmlFor={tokenId}
              className="bp-app-label"
            >
              Token contract ID
            </label>
            <input
              id={tokenId}
              type="text"
              value={token}
              onChange={(e) => setToken(e.target.value)}
              className={`${inputBase} font-mono`}
              placeholder="usdc.example.testnet"
              required
            />
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-3 items-end gap-3">
            <div>
              <label
                htmlFor={budgetId}
                className="bp-app-label"
              >
                Budget (USDC)
              </label>
              <input
                id={budgetId}
                type="text"
                inputMode="decimal"
                value={budgetUsdc}
                onChange={(e) => setBudgetUsdc(e.target.value)}
                className={`${inputBase} font-mono`}
                placeholder="50"
                required
              />
            </div>

            <div>
              <label
                htmlFor={perPaymentCapId}
                className="bp-app-label"
              >
                Cap per payment (USDC)
              </label>
              <input
                id={perPaymentCapId}
                type="text"
                inputMode="decimal"
                value={perPaymentCapUsdc}
                onChange={(e) => setPerPaymentCapUsdc(e.target.value)}
                className={`${inputBase} font-mono`}
                placeholder="5"
                required
              />
            </div>

            <div>
              <label
                htmlFor={approvalThresholdId}
                className="bp-app-label"
              >
                Threshold (USDC)
              </label>
              <input
                id={approvalThresholdId}
                type="text"
                inputMode="decimal"
                value={approvalThresholdUsdc}
                onChange={(e) => setApprovalThresholdUsdc(e.target.value)}
                className={`${inputBase} font-mono`}
                placeholder="2"
                required
              />
            </div>
          </div>

          <div>
            <label
              htmlFor={expiryId}
              className="bp-app-label"
            >
              Expiry date and time (UTC)
            </label>
            <input
              id={expiryId}
              type="datetime-local"
              value={expiryStr}
              onChange={(e) => setExpiryStr(e.target.value)}
              className={inputBase}
              required
            />
          </div>

          <div>
            <label
              htmlFor={recipientsId}
              className="bp-app-label"
            >
              Recipient allowlist (one address per line)
            </label>
            <textarea
              id={recipientsId}
              rows={4}
              value={recipientsText}
              onChange={(e) => setRecipientsText(e.target.value)}
              className={`${inputBase} !text-xs font-mono`}
              placeholder="merchant-a.example.testnet&#10;merchant-b.example.testnet"
              required
            />
          </div>
        </div>

        <div className="pt-2">
          <a href="#owner-wallet" className="bp-btn bp-btn-secondary py-2.5">
            Create it for real: connect a wallet above
          </a>
          <p className="bp-app-hint" style={{ marginTop: 10 }}>
            This form only checks your input and shows the contract call. To create a real mandate on testnet, connect a wallet at the top of this page. To pay as an agent without a wallet, open <a className="bp-app-inline" href="/try">Try to steal</a>.
          </p>
        </div>
      </form>

      <div className="space-y-4">
        <div className="bp-plate bp-app-plate">
          <div className="flex items-center justify-between pb-3 border-b border-bp-line">
            <h2 className="text-sm font-semibold text-bp-ink">
              The <code>create_mandate</code> call
            </h2>
            <span className="bp-app-chip">
              JSON
            </span>
          </div>
          <p className="bp-app-hint mt-3">
            The arguments this form would send. Amounts are exact token units (6 decimals for USDC), computed
            with BigInt, never floating point.
          </p>
          <pre className="bp-app-code">
            <code>{JSON.stringify(mandateArgsPreview, null, 2)}</code>
          </pre>
        </div>

        <TryPayment mandate={mandateArgsPreview} />

        <div className="bp-plate bp-app-plate text-xs text-bp-muted space-y-2">
          <p className="bp-kicker">
            The contract refuses to create a mandate unless
          </p>
          <ul className="list-disc pl-4 space-y-1">
            <li>the budget is at least the cap per payment, and the approval threshold at most the cap</li>
            <li>owner, agent and guardian are three different accounts</li>
            <li>there are 1 to 16 distinct recipients</li>
            <li>the expiry is in the future</li>
          </ul>
        </div>
      </div>
    </div>
  );
}
