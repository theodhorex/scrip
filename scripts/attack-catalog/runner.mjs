// Runner for Scrip Attack Catalog
// Executes cases sequentially with per-case timeout and evaluates verdicts

import { mkdirSync, writeFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateCases, validateCase, summarize } from './schema.mjs';

const __filename = fileURLToPath(import.meta.url);
const __dirname = dirname(__filename);

export const DEFAULT_OUT_PATH = resolve(__dirname, '.out/attack-catalog.json');
export const DEFAULT_TIMEOUT_MS = 5000;

/**
 * Runs attack cases sequentially through layer executors.
 *
 * @param {Array<object>} rawCases - List of attack cases
 * @param {object} [options]
 * @param {object} [options.executors] - Map of layer -> async fn(case): actual
 * @param {number} [options.timeoutMs] - Timeout in ms per case (default 5000ms)
 * @param {string} [options.outPath] - Path to write results JSON (default: .out/attack-catalog.json)
 * @param {boolean} [options.writeOut] - Whether to write output to file (default: true)
 * @param {Function} [options.onProgress] - Optional progress callback (case, index, total)
 * @returns {Promise<{summary: object, cases: Array<object>, outPath: string|null}>}
 */
export async function runCatalog(rawCases, options = {}) {
  const cases = validateCases(rawCases);
  const executors = options.executors || {};
  const timeoutMs = typeof options.timeoutMs === 'number' && options.timeoutMs > 0
    ? options.timeoutMs
    : DEFAULT_TIMEOUT_MS;
  const outPath = options.outPath !== undefined ? options.outPath : DEFAULT_OUT_PATH;
  const writeOut = options.writeOut !== undefined ? Boolean(options.writeOut) : true;
  const onProgress = typeof options.onProgress === 'function' ? options.onProgress : null;

  const results = [];

  for (let i = 0; i < cases.length; i++) {
    const c = cases[i];
    const evaluated = {
      ...c,
      params: { ...c.params },
      expected: { ...c.expected },
    };

    const executor = executors[c.layer];

    if (typeof executor !== 'function') {
      // Layer executor not provided: SKIPPED (counted separately, never PASS)
      evaluated.actual = {
        label: 'INERT',
        note: `Executor for layer ${c.layer} not configured`,
      };
      evaluated.verdict = 'SKIPPED';
    } else {
      // Execute with per-case timeout
      let actual;
      let timer;
      try {
        const executionPromise = Promise.resolve().then(() => executor(c));
        const timeoutPromise = new Promise((_, reject) => {
          timer = setTimeout(() => {
            reject(new Error(`Timeout after ${timeoutMs}ms`));
          }, timeoutMs);
          if (timer.unref) timer.unref();
        });

        actual = await Promise.race([executionPromise, timeoutPromise]);
      } catch (err) {
        actual = {
          label: 'INERT',
          code: err.name || 'Error',
          note: err.message,
        };
      } finally {
        if (timer) clearTimeout(timer);
      }

      evaluated.actual = actual;

      // Verdict evaluation
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
    }

    validateCase(evaluated);
    results.push(evaluated);

    if (onProgress) {
      onProgress(evaluated, i + 1, cases.length);
    }
  }

  const summary = summarize(results);

  let finalOutPath = null;
  if (writeOut && outPath) {
    finalOutPath = resolve(process.cwd(), outPath);
    mkdirSync(dirname(finalOutPath), { recursive: true });
    // Serialises absurd inputs safely: bigint -> string, circular references -> "[Circular]".
    const seen = new WeakSet();
    const replacer = (key, value) => {
      if (typeof value === 'bigint') return value.toString();
      if (value !== null && typeof value === 'object') {
        if (seen.has(value)) return '[Circular]';
        seen.add(value);
      }
      return value;
    };
    const payload = JSON.stringify(
      {
        generatedAt: new Date().toISOString(),
        summary,
        cases: results,
      },
      replacer,
      2
    );
    writeFileSync(finalOutPath, payload, 'utf8');
  }

  return {
    summary,
    cases: results,
    outPath: finalOutPath,
  };
}
