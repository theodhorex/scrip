// @ts-check
/**
 * StrykerJS configuration for the facilitator.
 *
 * Stack: plain Node.js ESM, tests run with `node --test test/` (no Jest/Mocha/Vitest),
 * so the built-in `command` test runner is used. The command runner cannot collect
 * per-test coverage, hence `coverageAnalysis: 'off'` (all tests run for every mutant).
 *
 * Sources:
 * - https://stryker-mutator.io/docs/stryker-js/config-file/#setup (ESM `.mjs` config)
 * - https://stryker-mutator.io/docs/stryker-js/configuration/#testrunner-string
 * - https://stryker-mutator.io/docs/stryker-js/configuration/#commandrunner-object
 * - https://stryker-mutator.io/docs/stryker-js/configuration/#coverageanalysis-string
 * - https://stryker-mutator.io/docs/stryker-js/configuration/#timeoutms-number
 * - https://stryker-mutator.io/docs/stryker-js/configuration/#reporters-string
 * - https://stryker-mutator.io/docs/stryker-js/configuration/#tempdirname-string
 *
 * @type {import('@stryker-mutator/api/core').PartialStrykerOptions}
 */
export default {
  testRunner: 'command',
  commandRunner: {
    // Same command the project uses (package.json "test").
    command: 'node --test test/',
  },
  mutate: ['src/**/*.mjs', '!src/**/*.test.mjs'],
  concurrency: 2,
  coverageAnalysis: 'off',

  // A full test run takes ~1.7s; allow slow mutants but still bound runaway loops.
  // Actual limit = netTimeMs * timeoutFactor + timeoutMS + overheadMs.
  timeoutMS: 15_000,
  timeoutFactor: 2,

  reporters: ['clear-text', 'json'],
  jsonReporter: {
    fileName: '.stryker-out/mutation.json',
  },

  // Sandbox copy and all artefacts stay inside the project, never in /tmp.
  tempDirName: '.stryker-out/tmp',
  ignorePatterns: [
    '.stryker-out',
    '**/*.md',
    'node_modules',
  ],

  thresholds: { high: 80, low: 60, break: null },
};
