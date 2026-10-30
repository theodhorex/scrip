import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, readFileSync, unlinkSync, rmSync, mkdirSync } from 'node:fs';
import { resolve, join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';

const HERE = dirname(fileURLToPath(import.meta.url));
const CATALOG_DIR = resolve(HERE, '..');
const REPO_ROOT = resolve(CATALOG_DIR, '../..');
const RUN_TESTNET_BIN = resolve(CATALOG_DIR, 'run-testnet.mjs');

import {
  runTestnetExecution,
  parseCliArgs,
} from '../run-testnet.mjs';

test('parseCliArgs correctly parses wave, range, comparison, dry and out', () => {
  const args1 = parseCliArgs(['--wave', '2', '--dry']);
  assert.equal(args1.wave, 2);
  assert.equal(args1.dry, true);
  assert.equal(args1.comparison, false);

  const args2 = parseCliArgs(['--from', '10', '--to', '30', '--comparison', '--out', 'custom.json']);
  assert.equal(args2.from, 10);
  assert.equal(args2.to, 30);
  assert.equal(args2.comparison, true);
  assert.equal(args2.out, 'custom.json');
});

test('runTestnetExecution runs a wave under --dry, tags source: dry, and writes partial output', async () => {
  const tmpOut = resolve(CATALOG_DIR, '.out/test-wave-partial.json');
  if (existsSync(tmpOut)) unlinkSync(tmpOut);

  const result = await runTestnetExecution({
    wave: 1,
    dry: true,
    out: tmpOut,
    maxCases: 5, // small slice for fast test execution
    rateLimitCapacity: 1000,
    rateLimitRps: 1000,
  });

  assert.ok(result);
  assert.equal(result.cases.length, 5);
  assert.equal(result.clean, true);
  assert.deepEqual(result.leftoverAccounts, []);

  // Verify each case has source: "dry"
  for (const c of result.cases) {
    assert.equal(c.source, 'dry');
    assert.ok(c.actual);
    assert.ok(c.verdict);
    assert.ok(c.actual.txHash);
  }

  // Verify file on disk
  assert.ok(existsSync(tmpOut));
  const saved = JSON.parse(readFileSync(tmpOut, 'utf8'));
  assert.equal(saved.count, 5);
  assert.equal(saved.dry, true);
  assert.equal(saved.cases.length, 5);

  if (existsSync(tmpOut)) unlinkSync(tmpOut);
});

test('runTestnetExecution closes session in finally even when execution throws', async () => {
  let sessionClosed = false;

  const mockSession = {
    isDry: true,
    closed: false,
    mandates: [{ id: 1 }],
    limiter: { acquire: async () => {} },
    viewMandate: async () => ({ id: 1, spent: '0', reserved: '0', deposited: '1000', status: 'Active' }),
    viewFtBalance: async () => 0n,
    closeSession: async () => {
      sessionClosed = true;
      return { clean: true, leftoverAccounts: [] };
    },
  };

  const throwingCases = [
    {
      id: 'KAT-E-TEST-ERR',
      category: 1,
      layer: 'E',
      title: 'Throws immediately',
      params: {},
      expected: { label: 'INERT' },
    },
  ];

  await assert.rejects(
    async () => {
      await runTestnetExecution({
        customCases: throwingCases,
        customSession: mockSession,
        executorOverride: async () => {
          throw new Error('Forced executor failure');
        },
      });
    },
    /Forced executor failure/
  );

  assert.equal(sessionClosed, true, 'Session closeSession must be called in finally');
});

test('runTestnetExecution forbids writing to results/ in dry mode', async () => {
  await assert.rejects(
    async () => {
      await runTestnetExecution({
        dry: true,
        out: resolve(REPO_ROOT, 'results/attack-catalog.json'),
        maxCases: 1,
      });
    },
    /Mode dry TIDAK boleh dipakai untuk menulis ke results\//
  );
});

test('run-testnet CLI prints tx count and leftover accounts [] without printing full tx hashes', () => {
  const tmpOut = resolve(CATALOG_DIR, '.out/test-cli-run.json');
  if (existsSync(tmpOut)) unlinkSync(tmpOut);

  const stdout = execFileSync('node', [
    RUN_TESTNET_BIN,
    '--wave', '1',
    '--from', '0',
    '--to', '3',
    '--dry',
    '--out', tmpOut,
  ], {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    env: { ...process.env, RATE_LIMIT_CAPACITY: '1000', RATE_LIMIT_RPS: '1000' },
  });

  // Verify printed summary elements
  assert.match(stdout, /Tx hashes count\s*:\s*\d+/i);
  assert.match(stdout, /Leftover accounts\s*:\s*\[\]/);
  assert.match(stdout, /PASS|FAIL|BREACH/);

  // Assert that individual mock tx hashes are NOT printed to stdout (only count)
  assert.doesNotMatch(stdout, /TX_E_DRY_/);

  if (existsSync(tmpOut)) unlinkSync(tmpOut);
});

test('run-testnet CLI executes successfully from 3 different current working directories', () => {
  const cwds = [
    REPO_ROOT,
    CATALOG_DIR,
    '/tmp',
  ];

  for (let i = 0; i < cwds.length; i++) {
    const cwd = cwds[i];
    const outPath = resolve(CATALOG_DIR, `.out/test-cwd-${i}.json`);
    if (existsSync(outPath)) unlinkSync(outPath);

    const stdout = execFileSync('node', [
      RUN_TESTNET_BIN,
      '--from', '0',
      '--to', '2',
      '--dry',
      '--out', outPath,
    ], {
      cwd,
      encoding: 'utf8',
      env: { ...process.env, RATE_LIMIT_CAPACITY: '1000', RATE_LIMIT_RPS: '1000' },
    });

    assert.match(stdout, /Leftover accounts\s*:\s*\[\]/);
    assert.ok(existsSync(outPath));
    if (existsSync(outPath)) unlinkSync(outPath);
  }
});
