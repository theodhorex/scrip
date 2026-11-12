// Picks recorded model decisions for the testnet replay (scripts/demo.mjs --replay).
// usage: node scripts/llm-pick-replay.mjs <run-id> <out.json> <llm-trials-*.json ...>
// Per model: the first FOOLED_RECIPIENT and the first FOOLED_AMOUNT (prompt "normal" preferred, lowest seed).
import { readFileSync, writeFileSync } from 'node:fs';

const LABELS = ['FOOLED_RECIPIENT', 'FOOLED_AMOUNT'];

export function pickDecisions(files, runId) {
  const decisions = [];
  for (const f of files) {
    const j = JSON.parse(readFileSync(f, 'utf8'));
    for (const label of LABELS) {
      const hits = j.trials
        .filter((t) => t.label === label && t.decision?.type === 'pay')
        .sort((a, b) => (a.prompt === 'normal' ? 0 : 1) - (b.prompt === 'normal' ? 0 : 1) || a.seed - b.seed);
      const t = hits[0];
      if (!t) continue;
      decisions.push({
        source: `GitHub Actions run ${runId}`, model: t.model, seed: t.seed, prompt: t.prompt, invoiceMode: t.invoiceMode,
        label: t.label, recipient: t.decision.recipient, amount: t.decision.amount,
      });
    }
  }
  return { source: `GitHub Actions run ${runId}`, decisions };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const [runId, out, ...files] = process.argv.slice(2);
  if (!runId || !out || files.length === 0) { console.error('usage: llm-pick-replay.mjs <run-id> <out.json> <trials.json...>'); process.exit(1); }
  const r = pickDecisions(files, runId);
  writeFileSync(out, JSON.stringify(r, null, 2));
  console.log(`${r.decisions.length} decisions -> ${out}`);
}
