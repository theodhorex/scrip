#!/usr/bin/env node
// Merger for Attack Catalog Layer Outputs
// Conforms to .agy/BRIEF_BACKEND.md and E1c task specifications:
// - Reads per-layer output files (.out/attack-catalog.json, .out/testnet-wave-*.json, .out/layer-a.json, .out/layer-d.json)
// - Merges into a single comprehensive output file
// - Generates summarize() + category x layer x label matrix, BREACH list, FAIL list, SKIPPED count, OUT_OF_SCOPE, and naive comparison cases
// - Enforces: writing to results/attack-catalog.json ONLY with explicit --publish flag AND rejects if any case has source: "dry"
// - Ensures absolute path resolution via import.meta.url for portability across any cwd

import { parseArgs } from 'node:util';
import { readdirSync, readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

import {
  VALID_CATEGORIES,
  VALID_LAYERS,
  ACTUAL_LABELS,
  summarize,
} from './schema.mjs';
import { isResultsPath } from './layers/testnet.mjs';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = HERE;
const REPO_ROOT = resolve(CATALOG_DIR, '../..');
const OUT_DIR = resolve(CATALOG_DIR, '.out');
const DEFAULT_OUT_PATH = resolve(OUT_DIR, 'attack-catalog.merged.json');
const PUBLISH_DEST_PATH = resolve(REPO_ROOT, 'results/attack-catalog.json');

export const cliOptions = {
  inputs: { type: 'string', short: 'i' },
  out: { type: 'string', short: 'o' },
  publish: { type: 'boolean', short: 'p', default: false },
  help: { type: 'boolean', short: 'h', default: false },
};

export function parseCliArgs(argv = process.argv.slice(2)) {
  const { values } = parseArgs({
    args: argv,
    options: cliOptions,
    allowPositionals: true,
  });

  return {
    inputs: values.inputs ? values.inputs.split(',').map((s) => s.trim()) : undefined,
    out: values.out,
    publish: Boolean(values.publish),
    help: Boolean(values.help),
  };
}

export function printHelp() {
  console.log(`
Scrip Attack Catalog - Layer Output Merger
Usage: node scripts/attack-catalog/merge.mjs [options]

Options:
  -i, --inputs <paths>  Comma-separated list of result files to merge
  -o, --out <path>      Output file path (default: scripts/attack-catalog/.out/attack-catalog.merged.json)
  -p, --publish         Publish merged results to results/attack-catalog.json (strictly forbids dry data)
  -h, --help            Show this help message
`);
}

/**
 * Finds default layer result files in scripts/attack-catalog/.out/
 *
 * @returns {Array<string>} List of absolute file paths
 */
export function findDefaultInputFiles() {
  const found = [];
  if (!existsSync(OUT_DIR)) {
    return found;
  }

  // 1. Standard A/B/C catalog output
  const standardCatalog = resolve(OUT_DIR, 'attack-catalog.json');
  if (existsSync(standardCatalog)) {
    found.push(standardCatalog);
  }

  // 2. Specific single layer outputs if present
  const layerA = resolve(OUT_DIR, 'layer-a.json');
  if (existsSync(layerA)) found.push(layerA);

  const layerD = resolve(OUT_DIR, 'layer-d.json');
  if (existsSync(layerD)) found.push(layerD);

  // 3. Testnet waves (testnet-wave-*.json)
  const entries = readdirSync(OUT_DIR);
  for (const entry of entries) {
    if (entry.startsWith('testnet-wave-') && entry.endsWith('.json')) {
      const fullPath = resolve(OUT_DIR, entry);
      if (!found.includes(fullPath)) {
        found.push(fullPath);
      }
    }
  }

  return found;
}

/**
 * Builds 3D breakdown matrix: category x layer x label.
 *
 * @param {Array<object>} cases
 * @returns {object}
 */
export function buildCategoryLayerLabelMatrix(cases) {
  const matrix = {};

  for (const cat of VALID_CATEGORIES) {
    matrix[cat] = {};
    for (const layer of VALID_LAYERS) {
      matrix[cat][layer] = {
        BLOCKED: 0,
        INERT: 0,
        OUT_OF_SCOPE: 0,
        BREACH: 0,
        total: 0,
      };
    }
  }

  for (const c of cases) {
    const cat = c.category;
    const layer = c.layer;
    const label = c.actual?.label || c.expected?.label;

    if (
      matrix[cat] &&
      matrix[cat][layer] &&
      label &&
      matrix[cat][layer][label] !== undefined
    ) {
      matrix[cat][layer][label] += 1;
      matrix[cat][layer].total += 1;
    }
  }

  return matrix;
}

/**
 * Merges layer output files into a unified dataset.
 *
 * @param {object} options
 * @param {Array<string>} [options.inputFiles] - Files to read
 * @param {string} [options.out] - Destination output file
 * @param {boolean} [options.publish] - Whether to publish to results/attack-catalog.json
 * @returns {Promise<object>} Merged dataset
 */
export async function mergeLayerOutputs(options = {}) {
  const publish = Boolean(options.publish);
  const inputFiles = options.inputFiles && options.inputFiles.length > 0
    ? options.inputFiles.map((p) => resolve(process.cwd(), p))
    : findDefaultInputFiles();

  if (inputFiles.length === 0) {
    throw new Error('No input files found to merge. Run layer executions first or provide --inputs');
  }

  const caseMap = new Map();
  let dryFilesCount = 0;
  let realFilesCount = 0;

  for (const filePath of inputFiles) {
    if (!existsSync(filePath)) {
      continue;
    }

    const raw = readFileSync(filePath, 'utf8');
    const parsed = JSON.parse(raw);
    const fileIsDry = Boolean(parsed.dry);
    const fileSource = parsed.source || (fileIsDry ? 'dry' : undefined);

    if (fileIsDry) dryFilesCount++;
    else realFilesCount++;

    const caseList = Array.isArray(parsed)
      ? parsed
      : (Array.isArray(parsed.cases) ? parsed.cases : []);

    for (const c of caseList) {
      if (!c || !c.id) continue;

      // Determine source: "real" | "dry"
      let caseSource = c.source || fileSource;
      if (!caseSource) {
        if (c.actual?.txHash && c.actual.txHash.includes('DRY')) {
          caseSource = 'dry';
        } else if (c.actual?.note && c.actual.note.toLowerCase().includes('mock')) {
          caseSource = 'dry';
        } else {
          caseSource = 'real';
        }
      }

      const normalized = {
        ...c,
        source: caseSource,
      };

      // Add or update by ID
      caseMap.set(c.id, normalized);
    }
  }

  const mergedCases = Array.from(caseMap.values());

  // Determine output path
  let finalOutPath;
  if (publish) {
    finalOutPath = options.out ? resolve(process.cwd(), options.out) : PUBLISH_DEST_PATH;
  } else {
    finalOutPath = options.out ? resolve(process.cwd(), options.out) : DEFAULT_OUT_PATH;
  }

  // Security check: Writing to results/ requires explicit --publish
  if (isResultsPath(finalOutPath) && !publish) {
    throw new Error('Writing to results/ requires explicit --publish flag');
  }

  // Security check: Never publish dry data
  const dryCases = mergedCases.filter((c) => c.source === 'dry');
  if (publish || isResultsPath(finalOutPath)) {
    if (dryCases.length > 0) {
      throw new Error(`Cannot publish to results: contains cases with source: "dry" (${dryCases.length} case(s))`);
    }
  }

  // Summaries
  const summary = summarize(mergedCases);
  const categoryLayerLabel = buildCategoryLayerLabelMatrix(mergedCases);
  summary.categoryLayerLabel = categoryLayerLabel;

  // Specific filtered sections
  const breaches = mergedCases.filter(
    (c) => c.verdict === 'BREACH' || c.actual?.label === 'BREACH'
  );

  const failures = mergedCases.filter((c) => c.verdict === 'FAIL');
  const skippedCount = summary.verdicts.SKIPPED || 0;

  const outOfScope = mergedCases.filter(
    (c) => c.expected?.label === 'OUT_OF_SCOPE' || c.actual?.label === 'OUT_OF_SCOPE'
  );

  const comparisonCases = mergedCases.filter(
    (c) => c.comparison === true || (c.id && c.id.includes('-COMP-'))
  );

  const sourceCounts = {
    real: mergedCases.filter((c) => c.source === 'real').length,
    dry: dryCases.length,
  };

  const payload = {
    generatedAt: new Date().toISOString(),
    total: mergedCases.length,
    published: publish,
    sourceCounts,
    summary,
    breaches,
    failures,
    skippedCount,
    outOfScope,
    comparisonCases,
    cases: mergedCases,
  };

  mkdirSync(dirname(finalOutPath), { recursive: true });
  writeFileSync(
    finalOutPath,
    JSON.stringify(payload, (k, v) => (typeof v === 'bigint' ? v.toString() : v), 2),
    'utf8'
  );

  return {
    outPath: finalOutPath,
    total: mergedCases.length,
    publish,
    sourceCounts,
    summary,
    breaches,
    failures,
    skippedCount,
    outOfScope,
    comparisonCases,
    cases: mergedCases,
  };
}

async function main() {
  const cliArgs = parseCliArgs();

  if (cliArgs.help) {
    printHelp();
    process.exit(0);
  }

  console.log('[merge] Merging attack catalog layer outputs...');
  if (cliArgs.publish) {
    console.log('[merge] Publish flag active -> destination: results/attack-catalog.json');
  }

  const result = await mergeLayerOutputs({
    inputFiles: cliArgs.inputs,
    out: cliArgs.out,
    publish: cliArgs.publish,
  });

  console.log('\n=== Attack Catalog Merged Summary ===');
  console.log(`Total Merged Cases: ${result.total}`);
  console.log(`PASS              : ${result.summary.verdicts.PASS}`);
  console.log(`FAIL              : ${result.summary.verdicts.FAIL}`);
  console.log(`BREACH            : ${result.summary.verdicts.BREACH}`);
  console.log(`SKIPPED           : ${result.skippedCount}`);
  console.log(`OUT_OF_SCOPE      : ${result.outOfScope.length}`);
  console.log(`Comparison Cases  : ${result.comparisonCases.length}`);
  console.log(`Source Breakdown  : ${result.sourceCounts.real} real, ${result.sourceCounts.dry} dry`);
  console.log(`Output File       : ${result.outPath}`);

  if (result.breaches.length > 0) {
    console.log('\nCRITICAL: Breaches detected in merged dataset:');
    for (const b of result.breaches) {
      console.log(`- ${b.id}: ${b.title} (${b.actual?.note || 'No details'})`);
    }
  }

  if (result.failures.length > 0) {
    console.log(`\nDiscrepancies (FAIL): ${result.failures.length} cases`);
  }
}

if (process.argv[1] && resolve(process.argv[1]) === resolve(fileURLToPath(import.meta.url))) {
  main().catch((err) => {
    console.error('[merge] Execution error:', err.message);
    process.exit(1);
  });
}
