// Pure mappers for the real-model trials (src/data/llm-trials.json) and their testnet replay (src/data/demo-llm.json).
// Erasable TypeScript only, so `node --test` can import it directly.
import trialsJson from "../data/llm-trials.json" with { type: "json" };
import replayJson from "../data/demo-llm.json" with { type: "json" };

export type Trial = { model: string; prompt: string; invoiceMode: string; seed: number; label: string };
export type Cond = { fooled: number; total: number };
export type ModelSummary = {
  model: string;
  total: number;
  seeds: number;
  injected: { normal: Cond; hijacked: Cond };
  paidOk: number;
  fooledRecipient: number;
  overpaid: number;
  declined: number;
  broken: number;
};

export function summarizeTrials(trials: ReadonlyArray<Trial>): ModelSummary[] {
  const order: string[] = [];
  const by = new Map<string, ModelSummary>();
  const seedSets = new Map<string, Set<number>>();
  for (const t of trials) {
    let m = by.get(t.model);
    if (!m) {
      m = { model: t.model, total: 0, seeds: 0, injected: { normal: { fooled: 0, total: 0 }, hijacked: { fooled: 0, total: 0 } }, paidOk: 0, fooledRecipient: 0, overpaid: 0, declined: 0, broken: 0 };
      by.set(t.model, m);
      seedSets.set(t.model, new Set());
      order.push(t.model);
    }
    m.total += 1;
    seedSets.get(t.model)!.add(t.seed);
    if (t.invoiceMode === "injected" && (t.prompt === "normal" || t.prompt === "hijacked")) {
      const c = m.injected[t.prompt];
      c.total += 1;
      if (t.label === "FOOLED_RECIPIENT") c.fooled += 1;
    }
    if (t.label === "PAID_OK") m.paidOk += 1;
    else if (t.label === "FOOLED_RECIPIENT") m.fooledRecipient += 1;
    else if (t.label === "FOOLED_AMOUNT") m.overpaid += 1;
    else if (t.label === "DECLINED") m.declined += 1;
    else m.broken += 1;
  }
  return order.map((k) => ({ ...by.get(k)!, seeds: seedSets.get(k)!.size }));
}

export type ReplayDecision = { model: string; prompt: string; invoiceMode: string; label: string; recipient: string; amount: string; paid: boolean; txHash: string | null; rejectionCode: string | null };
export type ReplayInput = {
  agents: {
    naive: { before: string; after: string; decisions: ReadonlyArray<ReplayDecision>; attackerGained: number | string };
    scrip: { before: string; after: string; decisions: ReadonlyArray<ReplayDecision>; attackerGained: number | string };
  };
};
export type ReplayRow = { model: string; prompt: string; invoiceMode: string; naiveTx: string | null; scripTx: string | null; code: string | null };

export function summarizeReplay(r: ReplayInput) {
  const codes: Record<string, number> = {};
  for (const d of r.agents.scrip.decisions) if (d.rejectionCode) codes[d.rejectionCode] = (codes[d.rejectionCode] ?? 0) + 1;
  const rows: ReplayRow[] = r.agents.scrip.decisions.map((d, i) => ({
    model: d.model, prompt: d.prompt, invoiceMode: d.invoiceMode,
    naiveTx: r.agents.naive.decisions[i]?.txHash ?? null, scripTx: d.txHash, code: d.rejectionCode,
  }));
  return {
    decisions: r.agents.scrip.decisions.length,
    naivePaid: r.agents.naive.decisions.filter((d) => d.paid).length,
    scripRejected: r.agents.scrip.decisions.filter((d) => !d.paid).length,
    naiveBefore: r.agents.naive.before, naiveAfter: r.agents.naive.after,
    scripBefore: r.agents.scrip.before, scripAfter: r.agents.scrip.after,
    attackerGainedNaive: String(r.agents.naive.attackerGained),
    attackerGainedScrip: String(r.agents.scrip.attackerGained),
    codes, rows,
  };
}

export const LLM_TRIALS = trialsJson.trials as ReadonlyArray<Trial>;
export const LLM_REPLAY = replayJson as unknown as ReplayInput;
