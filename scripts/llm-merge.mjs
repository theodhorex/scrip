#!/usr/bin/env node
// Merges seed-chunk result files of ONE model into a single llm-trials file.
// usage: node scripts/llm-merge.mjs <out.json> <chunk1.json> <chunk2.json> ... [--runs <url,url,...>]
import { readFileSync, writeFileSync } from 'node:fs';
import { summarizeTrials, PROMPT_KINDS, INVOICE_MODES } from './llm-trials.mjs';

export function mergeChunks(docs, runs = []) {
  if (docs.length === 0) throw new Error('no chunks to merge');
  const model = docs[0].metadata.model;
  const trials = [];
  const seen = new Set();
  for (const d of docs) {
    if (d.metadata.model !== model) throw new Error(`mixed models: ${model} and ${d.metadata.model}`);
    for (const t of d.trials) {
      const key = `${t.prompt}/${t.invoiceMode}/${t.seed}`;
      if (seen.has(key)) throw new Error(`duplicate trial ${key}`);
      seen.add(key);
      trials.push(t);
    }
  }
  const seeds = [...new Set(trials.map((t) => t.seed))].sort((a, b) => a - b);
  const perCondition = PROMPT_KINDS.length * INVOICE_MODES.length;
  if (trials.length !== seeds.length * perCondition) throw new Error('chunks do not cover the same seeds in every condition');
  const first = docs[0].metadata;
  return {
    metadata: {
      ...first,
      runAt: docs.map((d) => d.metadata.runAt).sort().at(-1),
      seeds: seeds.length,
      seedStart: seeds[0],
      seedList: seeds,
      totalTrials: trials.length,
      mergedFromChunks: docs.length,
      runs,
    },
    summary: summarizeTrials(trials),
    trials,
  };
}

if (process.argv[1] && import.meta.url === new URL(`file://${process.argv[1]}`).href) {
  const args = process.argv.slice(2);
  let runs = [];
  const ri = args.indexOf('--runs');
  if (ri !== -1) { runs = (args[ri + 1] ?? '').split(',').filter(Boolean); args.splice(ri, 2); }
  const [out, ...inputs] = args;
  if (!out || inputs.length === 0) { console.error('usage: llm-merge.mjs <out.json> <chunk.json>... [--runs url,url]'); process.exit(1); }
  const merged = mergeChunks(inputs.map((f) => JSON.parse(readFileSync(f, 'utf8'))), runs);
  writeFileSync(out, JSON.stringify(merged, null, 2), 'utf8');
  console.log(`${merged.metadata.model}: ${merged.metadata.seeds} seeds, ${merged.metadata.totalTrials} trials -> ${out}`);
}
