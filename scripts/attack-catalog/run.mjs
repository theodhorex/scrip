#!/usr/bin/env node
// CLI runner for Amanat Attack Catalog
// Usage: node scripts/attack-catalog/run.mjs [--layers C] [--out <path>] [--timeout <ms>]

import { parseArgs } from 'node:util';
import { runCatalog, DEFAULT_OUT_PATH } from './runner.mjs';
import { getSampleCases, defaultExecutors } from './cases/index.mjs';

const options = {
  layers: { type: 'string', short: 'l' },
  out: { type: 'string', short: 'o', default: DEFAULT_OUT_PATH },
  timeout: { type: 'string', short: 't', default: '5000' },
  help: { type: 'boolean', short: 'h' },
};

function printHelp() {
  console.log(`
Amanat Attack Catalog Runner
Usage: node scripts/attack-catalog/run.mjs [options]

Options:
  -l, --layers <layers>   Comma-separated layers to run (e.g. C or A,B,C)
  -o, --out <path>        Output JSON path (default: scripts/attack-catalog/.out/attack-catalog.json)
  -t, --timeout <ms>      Per-case timeout in ms (default: 5000)
  -h, --help              Show help message
`);
}

async function main() {
  const { values } = parseArgs({ args: process.argv.slice(2), options, allowPositionals: true });

  if (values.help) {
    printHelp();
    process.exit(0);
  }

  let cases = getSampleCases();

  if (values.layers) {
    const requested = values.layers.split(',').map((s) => s.trim().toUpperCase());
    cases = cases.filter((c) => requested.includes(c.layer));
    console.log(`[Attack Catalog] Filtered to layer(s) [${requested.join(', ')}]: ${cases.length} case(s)`);
  } else {
    console.log(`[Attack Catalog] Running all ${cases.length} case(s)`);
  }

  const timeoutMs = parseInt(values.timeout, 10) || 5000;
  const outPath = values.out;

  let result;
  try {
    result = await runCatalog(cases, {
      executors: defaultExecutors,
      timeoutMs,
      outPath,
      writeOut: true,
      onProgress: (c, idx, total) => {
        const v = c.verdict.padEnd(7);
        console.log(`[${idx}/${total}] [${v}] ${c.id}: ${c.title}`);
      },
    });
  } finally {
    if (typeof defaultExecutors.cleanup === 'function') {
      await defaultExecutors.cleanup();
    }
  }

  const { summary } = result;
  console.log('\n=== Attack Catalog Execution Summary ===');
  console.log(`Total Cases : ${summary.total}`);
  console.log(`PASS        : ${summary.verdicts.PASS}`);
  console.log(`FAIL        : ${summary.verdicts.FAIL}`);
  console.log(`BREACH      : ${summary.verdicts.BREACH}`);
  console.log(`SKIPPED     : ${summary.verdicts.SKIPPED}`);
  console.log(`Results file: ${result.outPath}`);

  if (summary.verdicts.FAIL > 0) {
    console.log('\nDiscrepancies (FAIL):');
    for (const c of result.cases.filter((c) => c.verdict === 'FAIL')) {
      console.log(`- ${c.id}: expected ${c.expected.label}${c.expected.code ? ` (${c.expected.code})` : ''}, actual ${c.actual.label}${c.actual.code ? ` (${c.actual.code})` : ''} - ${c.actual.note || ''}`);
    }
  }

  if (summary.breaches.length > 0) {
    console.log('\nCRITICAL: Breaches detected:');
    for (const b of summary.breaches) {
      console.log(`- ${b.id}: ${b.title} (${b.actual?.note || 'No details'})`);
    }
  }
}

main().catch((err) => {
  console.error('[Attack Catalog] Fatal error:', err);
  process.exit(1);
});
