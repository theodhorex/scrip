import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, writeFileSync, readFileSync, unlinkSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(CATALOG_DIR, '../..');
const MERGE_BIN = resolve(CATALOG_DIR, 'merge.mjs');

import {
  mergeLayerOutputs,
  findDefaultInputFiles,
  buildCategoryLayerLabelMatrix,
} from '../merge.mjs';

test('buildCategoryLayerLabelMatrix creates 3D counts for category x layer x label', () => {
  const cases = [
    {
      id: 'KAT-C-01-01',
      category: 1,
      layer: 'C',
      actual: { label: 'BLOCKED' },
    },
    {
      id: 'KAT-E-01-01',
      category: 1,
      layer: 'E',
      actual: { label: 'BREACH' },
    },
    {
      id: 'KAT-E-02-01',
      category: 2,
      layer: 'E',
      actual: { label: 'INERT' },
    },
  ];

  const matrix = buildCategoryLayerLabelMatrix(cases);
  assert.equal(matrix[1]['C'].BLOCKED, 1);
  assert.equal(matrix[1]['C'].total, 1);
  assert.equal(matrix[1]['E'].BREACH, 1);
  assert.equal(matrix[1]['E'].total, 1);
  assert.equal(matrix[2]['E'].INERT, 1);
  assert.equal(matrix[2]['E'].total, 1);
  assert.equal(matrix[3]['A'].total, 0);
});

test('mergeLayerOutputs correctly aggregates cases, summaries, failures, breaches, out-of-scope and comparisons', async () => {
  const tmpDir = resolve(CATALOG_DIR, '.out/test-merge-fixture');
  mkdirSync(tmpDir, { recursive: true });

  const file1 = join(tmpDir, 'attack-catalog.json');
  const file2 = join(tmpDir, 'testnet-wave-1.json');
  const outFile = join(tmpDir, 'attack-catalog.merged.json');

  const casesABC = [
    {
      id: 'KAT-C-01-01',
      category: 1,
      layer: 'C',
      title: 'Valid C test',
      params: {},
      expected: { label: 'BLOCKED' },
      actual: { label: 'BLOCKED' },
      verdict: 'PASS',
      source: 'real',
    },
    {
      id: 'KAT-B-05-01',
      category: 5,
      layer: 'B',
      title: 'Failing B test',
      params: {},
      expected: { label: 'BLOCKED', code: 'UNAUTHORIZED' },
      actual: { label: 'BLOCKED', code: 'BAD_REQUEST' },
      verdict: 'FAIL',
      source: 'real',
    },
    {
      id: 'KAT-C-12-01',
      category: 12,
      layer: 'C',
      title: 'Out of scope test',
      params: {},
      expected: { label: 'OUT_OF_SCOPE' },
      actual: { label: 'OUT_OF_SCOPE' },
      verdict: 'PASS',
      source: 'real',
    },
  ];

  const casesWave = [
    {
      id: 'KAT-E-02-01',
      category: 2,
      layer: 'E',
      title: 'Breach E test',
      params: {},
      expected: { label: 'BLOCKED' },
      actual: { label: 'BREACH', note: 'Balance stolen' },
      verdict: 'BREACH',
      source: 'real',
    },
    {
      id: 'KAT-E-COMP-01',
      category: 2,
      layer: 'E',
      comparison: true,
      title: 'Naive comparison test',
      params: {},
      expected: { label: 'INERT' },
      actual: { label: 'INERT' },
      verdict: 'PASS',
      source: 'real',
    },
  ];

  writeFileSync(file1, JSON.stringify({ cases: casesABC }));
  writeFileSync(file2, JSON.stringify({ cases: casesWave }));

  const res = await mergeLayerOutputs({
    inputFiles: [file1, file2],
    out: outFile,
  });

  assert.equal(res.total, 5);
  assert.equal(res.summary.verdicts.PASS, 3);
  assert.equal(res.summary.verdicts.FAIL, 1);
  assert.equal(res.summary.verdicts.BREACH, 1);

  // Check specific sections
  assert.equal(res.breaches.length, 1);
  assert.equal(res.breaches[0].id, 'KAT-E-02-01');

  assert.equal(res.failures.length, 1);
  assert.equal(res.failures[0].id, 'KAT-B-05-01');

  assert.equal(res.outOfScope.length, 1);
  assert.equal(res.outOfScope[0].id, 'KAT-C-12-01');

  assert.equal(res.comparisonCases.length, 1);
  assert.equal(res.comparisonCases[0].id, 'KAT-E-COMP-01');

  // Verify file written to disk
  assert.ok(existsSync(outFile));
  const written = JSON.parse(readFileSync(outFile, 'utf8'));
  assert.equal(written.total, 5);
  assert.equal(written.breaches.length, 1);
  assert.ok(written.summary.categoryLayerLabel);

  rmSync(tmpDir, { recursive: true, force: true });
});

test('mergeLayerOutputs rejects --publish when any case has source: "dry"', async () => {
  const tmpDir = resolve(CATALOG_DIR, '.out/test-merge-publish-reject');
  mkdirSync(tmpDir, { recursive: true });

  const file1 = join(tmpDir, 'testnet-wave-dry.json');
  const casesWithDry = [
    {
      id: 'KAT-E-02-01',
      category: 2,
      layer: 'E',
      title: 'Dry test',
      params: {},
      expected: { label: 'INERT' },
      actual: { label: 'INERT', txHash: 'TX_E_DRY_001' },
      verdict: 'PASS',
      source: 'dry',
    },
  ];
  writeFileSync(file1, JSON.stringify({ cases: casesWithDry }));

  await assert.rejects(
    async () => {
      await mergeLayerOutputs({
        inputFiles: [file1],
        publish: true,
      });
    },
    /Cannot publish to results: contains cases with source: "dry"/
  );

  rmSync(tmpDir, { recursive: true, force: true });
});

test('mergeLayerOutputs rejects writing to results/ directory without --publish flag', async () => {
  const tmpDir = resolve(CATALOG_DIR, '.out/test-merge-nopublish');
  mkdirSync(tmpDir, { recursive: true });

  const file1 = join(tmpDir, 'attack-catalog.json');
  writeFileSync(file1, JSON.stringify({
    cases: [{
      id: 'KAT-C-01-01',
      category: 1,
      layer: 'C',
      title: 'Real test',
      params: {},
      expected: { label: 'BLOCKED' },
      actual: { label: 'BLOCKED' },
      verdict: 'PASS',
      source: 'real',
    }],
  }));

  await assert.rejects(
    async () => {
      await mergeLayerOutputs({
        inputFiles: [file1],
        out: resolve(REPO_ROOT, 'results/attack-catalog.json'),
        publish: false,
      });
    },
    /Writing to results\/ requires explicit --publish flag/
  );

  rmSync(tmpDir, { recursive: true, force: true });
});

test('merge.mjs CLI runs successfully from 3 different current working directories', () => {
  const tmpDir = resolve(CATALOG_DIR, '.out/test-merge-cli');
  mkdirSync(tmpDir, { recursive: true });

  const fixtureFile = join(tmpDir, 'testnet-wave-1.json');
  writeFileSync(fixtureFile, JSON.stringify({
    cases: [
      {
        id: 'KAT-E-01-01',
        category: 1,
        layer: 'E',
        title: 'CLI test 1',
        params: {},
        expected: { label: 'BLOCKED' },
        actual: { label: 'BLOCKED' },
        verdict: 'PASS',
        source: 'dry',
      },
    ],
  }));

  const cwds = [
    REPO_ROOT,
    CATALOG_DIR,
    '/tmp',
  ];

  for (let i = 0; i < cwds.length; i++) {
    const cwd = cwds[i];
    const outFile = join(tmpDir, `merged-out-${i}.json`);

    const stdout = execFileSync('node', [
      MERGE_BIN,
      '--inputs', fixtureFile,
      '--out', outFile,
    ], {
      cwd,
      encoding: 'utf8',
    });

    assert.match(stdout, /Total Merged Cases:\s+\d+/);
    assert.ok(existsSync(outFile));
  }

  rmSync(tmpDir, { recursive: true, force: true });
});
