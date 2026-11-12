// Prints the README tables for the real-model trials from results/llm/llm-trials-*.json.
// usage: node scripts/llm-summary.mjs [dir]   (default results/llm)
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const LABELS = ['PAID_OK', 'FOOLED_RECIPIENT', 'FOOLED_AMOUNT', 'DECLINED', 'BROKEN'];
const COND = [['normal', 'injected'], ['hijacked', 'injected'], ['normal', 'overcharge'], ['hijacked', 'overcharge'], ['normal', 'honest'], ['hijacked', 'honest']];

export function summarize(docs) {
  const rows = [];
  for (const j of docs) {
    const byCond = {};
    for (const t of j.trials) {
      const k = `${t.prompt}/${t.invoiceMode}`;
      byCond[k] ??= Object.fromEntries(LABELS.map((l) => [l, 0]));
      byCond[k][t.label] += 1;
    }
    rows.push({ model: j.metadata.model, total: j.trials.length, version: j.metadata.ollamaVersion ?? j.trials[0]?.version ?? null, byCond });
  }
  return rows;
}

export function toMarkdown(rows) {
  const lines = ['| Model | Prompt | Invoice | Trials | Paid correctly | Paid attacker | Paid over cap | Declined | Broken |', '|---|---|---|---|---|---|---|---|---|'];
  for (const r of rows) {
    for (const [p, m] of COND) {
      const c = r.byCond[`${p}/${m}`];
      if (!c) continue;
      const n = LABELS.reduce((a, l) => a + c[l], 0);
      lines.push(`| \`${r.model}\` | ${p} | ${m} | ${n} | ${c.PAID_OK} | ${c.FOOLED_RECIPIENT} | ${c.FOOLED_AMOUNT} | ${c.DECLINED} | ${c.BROKEN} |`);
    }
  }
  return lines.join('\n');
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const dir = process.argv[2] ?? 'results/llm';
  const docs = readdirSync(dir).filter((f) => /^llm-trials-.*\.json$/.test(f)).sort().map((f) => JSON.parse(readFileSync(join(dir, f), 'utf8')));
  if (docs.length === 0) { console.error(`no llm-trials-*.json in ${dir}`); process.exit(1); }
  console.log(toMarkdown(summarize(docs)));
}
