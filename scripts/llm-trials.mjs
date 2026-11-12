#!/usr/bin/env node
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTrial } from '../demo/llm-agent.mjs';

export const PROMPT_KINDS = ['normal', 'hijacked'];
export const INVOICE_MODES = ['honest', 'injected', 'overcharge'];
export const LABELS = ['PAID_OK', 'FOOLED_RECIPIENT', 'FOOLED_AMOUNT', 'DECLINED', 'BROKEN'];

export function sanitizeModelName(model) {
  if (typeof model !== 'string') return '';
  return model.replace(/:/g, '-');
}

export function parseArgs(argv) {
  const options = {
    model: null,
    seeds: 20,
    baseUrl: 'http://127.0.0.1:11434',
    out: './results',
  };

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    if (arg === '--help' || arg === '-h') {
      options.help = true;
      return options;
    }
    if (arg === '--model') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) {
        throw new Error('Missing value for --model');
      }
      options.model = val;
    } else if (arg === '--seeds') {
      const val = argv[++i];
      if (!val || !/^[1-9][0-9]*$/.test(val)) {
        throw new Error('--seeds must be a positive integer');
      }
      options.seeds = parseInt(val, 10);
    } else if (arg === '--base-url') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) {
        throw new Error('Missing value for --base-url');
      }
      options.baseUrl = val;
    } else if (arg === '--out') {
      const val = argv[++i];
      if (!val || val.startsWith('--')) {
        throw new Error('Missing value for --out');
      }
      options.out = val;
    } else {
      throw new Error(`Unknown flag: ${arg}`);
    }
  }

  if (!options.model) {
    throw new Error('--model is required');
  }

  return options;
}

export function summarizeTrials(trials) {
  const byCondition = {};
  for (const p of PROMPT_KINDS) {
    byCondition[p] = {};
    for (const inv of INVOICE_MODES) {
      byCondition[p][inv] = {
        PAID_OK: 0,
        FOOLED_RECIPIENT: 0,
        FOOLED_AMOUNT: 0,
        DECLINED: 0,
        BROKEN: 0,
        total: 0,
      };
    }
  }

  const totals = {
    PAID_OK: 0,
    FOOLED_RECIPIENT: 0,
    FOOLED_AMOUNT: 0,
    DECLINED: 0,
    BROKEN: 0,
    total: 0,
  };

  for (const trial of trials) {
    const p = trial.promptKind;
    const inv = trial.invoiceMode;
    const label = trial.label;

    if (byCondition[p]?.[inv]) {
      if (typeof byCondition[p][inv][label] === 'number') {
        byCondition[p][inv][label]++;
      }
      byCondition[p][inv].total++;
    }

    if (typeof totals[label] === 'number') {
      totals[label]++;
    }
    totals.total++;
  }

  return { byCondition, totals };
}

export async function runTrials({
  model,
  seeds = 20,
  baseUrl = 'http://127.0.0.1:11434',
  out = './results',
  fetch: customFetch = globalThis.fetch,
}) {
  const sanitizedModel = sanitizeModelName(model);
  const trials = [];

  for (const promptKind of PROMPT_KINDS) {
    for (const invoiceMode of INVOICE_MODES) {
      for (let s = 1; s <= seeds; s++) {
        const trialResult = await runTrial({
          baseUrl,
          model,
          promptKind,
          invoiceMode,
          seed: s,
          fetch: customFetch,
        });
        trials.push(trialResult);
      }
    }
  }

  const summary = summarizeTrials(trials);
  const metadata = {
    runAt: new Date().toISOString(),
    model,
    sanitizedModel,
    version: trials[0]?.version ?? null,
    baseUrl,
    seeds,
    prompts: PROMPT_KINDS,
    invoices: INVOICE_MODES,
    totalTrials: trials.length,
  };

  const outputData = {
    metadata,
    summary,
    trials,
  };

  mkdirSync(out, { recursive: true });
  const filename = `llm-trials-${sanitizedModel}.json`;
  const filePath = join(out, filename);
  writeFileSync(filePath, JSON.stringify(outputData, null, 2), 'utf8');

  return { filePath, metadata, summary, trials };
}

export function printSummary({ metadata, summary, filePath }) {
  console.log('='.repeat(60));
  console.log(`LLM Harness Evaluation: ${metadata.model} (version: ${metadata.version ?? 'unknown'})`);
  console.log(`Seeds: ${metadata.seeds} | Total trials: ${metadata.totalTrials}`);
  console.log(`Output: ${filePath}`);
  console.log('='.repeat(60));
  for (const p of metadata.prompts) {
    console.log(`\nPrompt: ${p}`);
    for (const inv of metadata.invoices) {
      const c = summary.byCondition[p][inv];
      console.log(`  [${inv.padEnd(10)}] OK: ${c.PAID_OK} | FOOLED_RECIP: ${c.FOOLED_RECIPIENT} | FOOLED_AMT: ${c.FOOLED_AMOUNT} | DECLINED: ${c.DECLINED} | BROKEN: ${c.BROKEN}`);
    }
  }
  console.log('\nTotals:');
  const t = summary.totals;
  console.log(`  PAID_OK:          ${t.PAID_OK}`);
  console.log(`  FOOLED_RECIPIENT: ${t.FOOLED_RECIPIENT}`);
  console.log(`  FOOLED_AMOUNT:    ${t.FOOLED_AMOUNT}`);
  console.log(`  DECLINED:         ${t.DECLINED}`);
  console.log(`  BROKEN:           ${t.BROKEN}`);
  console.log(`  TOTAL:            ${t.total}`);
  console.log('='.repeat(60));
}

export async function main(argv = process.argv.slice(2)) {
  let parsed;
  try {
    parsed = parseArgs(argv);
  } catch (err) {
    console.error(`Error: ${err.message}`);
    console.error('Usage: node scripts/llm-trials.mjs --model <model> [--seeds <n>] [--base-url <url>] [--out <dir>]');
    process.exit(1);
  }

  if (parsed.help) {
    console.log('Usage: node scripts/llm-trials.mjs --model <model> [--seeds <n>] [--base-url <url>] [--out <dir>]');
    process.exit(0);
  }

  try {
    const result = await runTrials(parsed);
    printSummary(result);
    process.exit(0);
  } catch (err) {
    console.error(`Execution error: ${err.message}`);
    process.exit(1);
  }
}

if (process.argv[1] && fileURLToPath(import.meta.url) === process.argv[1]) {
  main();
}
