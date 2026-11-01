// @ts-check
/**
 * StrykerJS configuration for the client library.
 *
 * Same pattern as facilitator/stryker.config.mjs: plain Node.js ESM, tests run
 * with `node --test test/` (no Jest/Mocha/Vitest), so the built-in `command`
 * test runner is used. The command runner cannot collect per-test coverage,
 * hence `coverageAnalysis: 'off'` (all tests run for every mutant).
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

  // client/test/payment.test.mjs and test/delegate.test.mjs import
  // `../../facilitator/...` (files Outside client/), and test/intent.test.mjs
  // reads `../../docs/vectors/intent_hash.json`. A sandbox copy of client/
  // alone cannot resolve those paths, so mutation runs in place: originals are
  // backed up to the temp dir and restored afterwards.
  inPlace: true,

  // Full suite (82 tests) runs fast; allow slow mutants but bound runaway loops.
  // Actual limit = netTimeMs * timeoutFactor + timeoutMS + overheadMs.
  timeoutMS: 15_000,
  timeoutFactor: 2,

  reporters: ['clear-text', 'json'],
  jsonReporter: {
    fileName: '.stryker-out/mutation.json',
  },

  // Temp dir for logs and in-place backups stays inside the project.
  tempDirName: '.stryker-tmp',
  ignorePatterns: [
    '.stryker-out',
    '**/*.md',
    'node_modules',
  ],

  thresholds: { high: 80, low: 60, break: null },
};
