import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync, rmSync, existsSync } from 'node:fs';
import { resolve } from 'node:path';
import { runCatalog, DEFAULT_OUT_PATH } from '../runner.mjs';

function makeCase(id, layer, expected, params = {}) {
  return {
    id,
    category: 1,
    layer,
    title: `Test case ${id}`,
    params,
    expected,
  };
}

test('runner marks case as PASS when label and code match', async () => {
  const cases = [
    makeCase('C-PASS-1', 'C', { label: 'BLOCKED', code: 'RangeError' }),
  ];

  const executors = {
    C: async () => ({ label: 'BLOCKED', code: 'RangeError' }),
  };

  const res = await runCatalog(cases, { executors, writeOut: false });
  assert.equal(res.cases[0].verdict, 'PASS');
  assert.equal(res.summary.verdicts.PASS, 1);
});

test('runner marks case as FAIL when code differs from expected code', async () => {
  const cases = [
    makeCase('C-FAIL-1', 'C', { label: 'BLOCKED', code: 'RangeError' }),
  ];

  const executors = {
    C: async () => ({ label: 'BLOCKED', code: 'TypeError' }),
  };

  const res = await runCatalog(cases, { executors, writeOut: false });
  assert.equal(res.cases[0].verdict, 'FAIL');
  assert.equal(res.summary.verdicts.FAIL, 1);
});

test('runner marks case as FAIL when label differs from expected label', async () => {
  const cases = [
    makeCase('C-FAIL-2', 'C', { label: 'BLOCKED' }),
  ];

  const executors = {
    C: async () => ({ label: 'INERT', note: 'Allowed without error' }),
  };

  const res = await runCatalog(cases, { executors, writeOut: false });
  assert.equal(res.cases[0].verdict, 'FAIL');
  assert.equal(res.summary.verdicts.FAIL, 1);
});

test('runner marks case as BREACH when actual label is BREACH', async () => {
  const cases = [
    makeCase('C-BREACH-1', 'C', { label: 'BLOCKED' }),
  ];

  const executors = {
    C: async () => ({ label: 'BREACH', note: 'Unauthorized action bypassed' }),
  };

  const res = await runCatalog(cases, { executors, writeOut: false });
  assert.equal(res.cases[0].verdict, 'BREACH');
  assert.equal(res.summary.verdicts.BREACH, 1);
  assert.equal(res.summary.breaches.length, 1);
});

test('runner marks case as SKIPPED when executor is missing', async () => {
  const cases = [
    makeCase('A-SKIP-1', 'A', { label: 'BLOCKED' }),
  ];

  // No executor for layer A
  const res = await runCatalog(cases, { executors: {}, writeOut: false });
  assert.equal(res.cases[0].verdict, 'SKIPPED');
  assert.equal(res.summary.verdicts.SKIPPED, 1);
});

test('runner enforces per-case timeout', async () => {
  const cases = [
    makeCase('C-TIMEOUT-1', 'C', { label: 'BLOCKED', code: 'RangeError' }),
  ];

  const executors = {
    C: async () => {
      await new Promise((r) => setTimeout(r, 150));
      return { label: 'BLOCKED', code: 'RangeError' };
    },
  };

  // Set timeout to 50ms
  const res = await runCatalog(cases, { executors, timeoutMs: 50, writeOut: false });
  assert.equal(res.cases[0].verdict, 'FAIL');
  assert.match(res.cases[0].actual.note, /Timeout after 50ms/);
});

test('runner writes output to file when writeOut is true', async () => {
  const testOut = resolve('scripts/attack-catalog/.out/test-run.json');
  if (existsSync(testOut)) rmSync(testOut);

  const cases = [
    makeCase('C-OUT-1', 'C', { label: 'BLOCKED' }),
  ];
  const executors = {
    C: async () => ({ label: 'BLOCKED' }),
  };

  const res = await runCatalog(cases, { executors, outPath: testOut, writeOut: true });
  assert.ok(existsSync(testOut));
  const written = JSON.parse(readFileSync(testOut, 'utf8'));
  assert.equal(written.summary.total, 1);
  assert.equal(written.cases[0].id, 'C-OUT-1');
  rmSync(testOut);
});
