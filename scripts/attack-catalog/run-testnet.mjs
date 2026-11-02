#!/usr/bin/env node
// CLI Runner for Layer E (Testnet) Attack Cases
// Strict safety enforcement:
// - Rate limited to <= 8 rps via Token-Bucket
// - Session created ONCE per command execution
// - closeSession() strictly invoked in finally block and on SIGINT/SIGTERM
// - Prohibited from writing to results/ in --dry mode
// - Writes partial results to output file during execution
// - Summary printed with tx count (no full tx list) and leftover accounts (must be [])

import { parseArgs } from 'node:util';
import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  createTestnetSession,
  executeLayerE,
  isResultsPath,
  TokenBucketLimiter,
} from './layers/testnet.mjs';
import {
  getLayerECases,
  getLayerEComparisonCases,
} from './cases/layer_e/index.mjs';
import { summarize } from './schema.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = HERE;
const REPO_ROOT = resolve(CATALOG_DIR, '../..');

export const cliOptions = {
  wave: { type: 'string', short: 'w' },
  from: { type: 'string' },
  to: { type: 'string' },
  comparison: { type: 'boolean', short: 'c', default: false },
  dry: { type: 'boolean', short: 'd', default: false },
  out: { type: 'string', short: 'o' },
  help: { type: 'boolean', short: 'h', default: false },
};

export function parseCliArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: cliOptions,
    allowPositionals: true,
  });

  return {
    wave: values.wave !== undefined ? parseInt(values.wave, 10) : undefined,
    from: values.from !== undefined ? parseInt(values.from, 10) : undefined,
    to: values.to !== undefined ? parseInt(values.to, 10) : undefined,
    comparison: Boolean(values.comparison),
    dry: Boolean(values.dry),
    out: values.out,
    help: Boolean(values.help),
  };
}

export function printHelp() {
  console.log(`
Amanat Attack Catalog - Layer E (Testnet) Runner
Usage: node scripts/attack-catalog/run-testnet.mjs [options]

Options:
  -w, --wave <n>      Wave number to execute (1-indexed, <= 60 cases per wave)
  --from <index>      Starting case index (inclusive)
  --to <index>        Ending case index (exclusive)
  -c, --comparison    Execute comparison cases (naive baseline) instead of standard Layer E cases
  -d, --dry           Run offline in dry mode with simulated state (no network calls)
  -o, --out <path>    Output file path (default: scripts/attack-catalog/.out/testnet-wave-<n>.json)
  -h, --help          Show this help message
`);
}

/**
 * Runs Layer E execution session with lifecycle management.
 *
 * @param {object} options
 * @returns {Promise<object>}
 */
export async function runTestnetExecution(options = {}) {
  const isDry = Boolean(options.dry);
  const isComparison = Boolean(options.comparison);

  // 1. Select case dataset
  let allCases = options.customCases
    ? [...options.customCases]
    : (isComparison ? getLayerEComparisonCases() : getLayerECases());

  // 2. Determine slice of cases
  const WAVE_SIZE = 60;
  let waveNum = options.wave;
  let startIndex = 0;
  let endIndex = allCases.length;

  if (options.from !== undefined || options.to !== undefined) {
    startIndex = options.from !== undefined ? Math.max(0, parseInt(options.from, 10)) : 0;
    endIndex = options.to !== undefined ? Math.min(allCases.length, parseInt(options.to, 10)) : allCases.length;
  } else if (waveNum !== undefined && !Number.isNaN(waveNum) && waveNum > 0) {
    startIndex = (waveNum - 1) * WAVE_SIZE;
    endIndex = Math.min(startIndex + WAVE_SIZE, allCases.length);
  } else {
    // Default to wave 1
    waveNum = 1;
    startIndex = 0;
    endIndex = Math.min(WAVE_SIZE, allCases.length);
  }

  let casesToRun = allCases.slice(startIndex, endIndex);
  if (options.maxCases && options.maxCases > 0) {
    casesToRun = casesToRun.slice(0, options.maxCases);
  }

  if (casesToRun.length > 60) {
    throw new RangeError(`Gelombang kasus melebihi batas maksimum 60 kasus (diminta: ${casesToRun.length})`);
  }

  // 3. Resolve output destination
  let outPath = options.out;
  if (!outPath) {
    const waveTag = waveNum !== undefined ? waveNum : 'custom';
    const compTag = isComparison ? '-comparison' : '';
    outPath = resolve(CATALOG_DIR, `.out/testnet-wave-${waveTag}${compTag}.json`);
  } else {
    outPath = resolve(process.cwd(), outPath);
  }

  // Strict safety rule: dry mode cannot write to results/
  if (isDry && isResultsPath(outPath)) {
    throw new Error('ATURAN KERAS: Mode dry TIDAK boleh dipakai untuk menulis ke results/');
  }

  // 4. Create or reuse session ONCE
  let session = options.customSession;
  let ownsSession = false;

  const rateLimitCapacity = options.rateLimitCapacity ?? (process.env.RATE_LIMIT_CAPACITY ? parseInt(process.env.RATE_LIMIT_CAPACITY, 10) : 8);
  const rateLimitRps = options.rateLimitRps ?? (process.env.RATE_LIMIT_RPS ? parseInt(process.env.RATE_LIMIT_RPS, 10) : 8);

  if (!session) {
    ownsSession = true;
    session = await createTestnetSession({
      dry: isDry,
      mandatesCount: Math.min(casesToRun.length, 60) || 1,
      limiter: new TokenBucketLimiter({
        capacity: rateLimitCapacity,
        refillPerSecond: rateLimitRps,
      }),
    });
  }

  let sigHandler = null;
  if (ownsSession && typeof process.on === 'function') {
    sigHandler = async (sig) => {
      console.log(`\n[run-testnet] Received ${sig}, closing session...`);
      if (session && !session.closed) {
        try {
          const res = await session.closeSession();
          console.log(`[run-testnet] Leftover accounts: ${JSON.stringify(res.leftoverAccounts)}`);
        } catch {}
      }
      process.exit(130);
    };
    process.once('SIGINT', sigHandler);
    process.once('SIGTERM', sigHandler);
  }

  const results = [];
  const txHashes = [];
  let closeResult = { clean: true, leftoverAccounts: [] };

  const writePartial = (evaluatedCases) => {
    mkdirSync(dirname(outPath), { recursive: true });
    const payload = JSON.stringify({
      generatedAt: new Date().toISOString(),
      wave: waveNum,
      startIndex,
      endIndex,
      dry: isDry,
      source: isDry ? 'dry' : 'real',
      count: evaluatedCases.length,
      total: casesToRun.length,
      cases: evaluatedCases,
    }, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2);
    writeFileSync(outPath, payload, 'utf8');
  };

  try {
    const executor = options.executorOverride || ((c, s) => executeLayerE(c, s));

    for (let i = 0; i < casesToRun.length; i++) {
      const c = casesToRun[i];
      const evaluated = {
        ...c,
        source: isDry ? 'dry' : 'real',
        params: { ...c.params },
        expected: { ...c.expected },
      };

      const actual = await executor(c, session);
      evaluated.actual = actual;

      if (actual.txHash) {
        txHashes.push(actual.txHash);
      }

      if (actual.label === 'BREACH') {
        evaluated.verdict = 'BREACH';
      } else if (actual.label === c.expected.label) {
        if (c.expected.code !== undefined && c.expected.code !== null) {
          evaluated.verdict = actual.code === c.expected.code ? 'PASS' : 'FAIL';
        } else {
          evaluated.verdict = 'PASS';
        }
      } else {
        evaluated.verdict = 'FAIL';
      }

      results.push(evaluated);

      // Write partial progress periodically and at the end
      writePartial(results);

      if (typeof options.onProgress === 'function') {
        options.onProgress(evaluated, i + 1, casesToRun.length);
      }
    }
  } finally {
    if (sigHandler) {
      process.removeListener('SIGINT', sigHandler);
      process.removeListener('SIGTERM', sigHandler);
    }
    if (session && !session.closed) {
      closeResult = await session.closeSession();
    }
  }

  const summary = summarize(results);

  return {
    wave: waveNum,
    count: results.length,
    cases: results,
    txHashesCount: txHashes.length,
    clean: closeResult.clean,
    leftoverAccounts: closeResult.leftoverAccounts,
    summary,
    outPath,
  };
}

async function main() {
  const cliArgs = parseCliArgs();

  if (cliArgs.help) {
    printHelp();
    process.exit(0);
  }

  console.log(`[run-testnet] Initializing Layer E execution...`);
  console.log(`[run-testnet] Mode: ${cliArgs.dry ? 'DRY (Simulated offline)' : 'REAL (Network RPC)'}`);
  if (cliArgs.comparison) {
    console.log(`[run-testnet] Running comparison naive cases`);
  }

  const result = await runTestnetExecution({
    wave: cliArgs.wave,
    from: cliArgs.from,
    to: cliArgs.to,
    comparison: cliArgs.comparison,
    dry: cliArgs.dry,
    out: cliArgs.out,
    onProgress: (c, idx, total) => {
      const v = c.verdict.padEnd(7);
      console.log(`[${idx}/${total}] [${v}] ${c.id}: ${c.title}`);
    },
  });

  console.log('\n=== Layer E Execution Summary ===');
  console.log(`Wave              : ${result.wave !== undefined ? result.wave : 'custom'}`);
  console.log(`Total Cases       : ${result.count}`);
  console.log(`PASS              : ${result.summary.verdicts.PASS}`);
  console.log(`FAIL              : ${result.summary.verdicts.FAIL}`);
  console.log(`BREACH            : ${result.summary.verdicts.BREACH}`);
  console.log(`SKIPPED           : ${result.summary.verdicts.SKIPPED}`);
  console.log(`Tx hashes count   : ${result.txHashesCount}`);
  console.log(`Leftover accounts : ${JSON.stringify(result.leftoverAccounts)}`);
  console.log(`Output file       : ${result.outPath}`);

  if (result.summary.verdicts.BREACH > 0) {
    console.log('\nCRITICAL: Breaches detected:');
    for (const b of result.summary.breaches) {
      console.log(`- ${b.id}: ${b.title} (${b.actual?.note || 'No details'})`);
    }
  }

  if (result.leftoverAccounts.length > 0) {
    console.error(`\nWARNING: Leftover accounts remaining: ${JSON.stringify(result.leftoverAccounts)}`);
    process.exit(1);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('[run-testnet] Execution error:', err.message);
    process.exit(1);
  });
}
