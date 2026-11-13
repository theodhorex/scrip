import { test } from 'node:test';
import assert from 'node:assert/strict';
import { existsSync, unlinkSync, readFileSync, statSync, rmSync, mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
import {
  TokenBucketLimiter,
  detectMandateBreach,
  isResultsPath,
  createTestnetSession,
  executeLayerE,
  runLayerEInWaves,
} from '../layers/testnet.mjs';

test('TokenBucketLimiter enforces maximum capacity and rate <= 8 rps', async () => {
  let virtualTime = 1000;
  const limiter = new TokenBucketLimiter({
    capacity: 8,
    refillPerSecond: 8,
    now: () => virtualTime,
    sleep: async (ms) => {
      virtualTime += ms;
    },
  });

  // Initial burst: 8 tokens should be available immediately
  for (let i = 0; i < 8; i++) {
    const start = virtualTime;
    await limiter.acquire();
    assert.equal(virtualTime, start, `Token ${i} should be acquired without delay`);
  }

  // 9th token must wait ~125ms (1000ms / 8)
  const before9 = virtualTime;
  await limiter.acquire();
  assert.equal(virtualTime - before9, 125, '9th token should wait 125ms for refill');

  // Fast-forward 500ms -> should refill 4 tokens (min(8, 0 + 4) = 4)
  virtualTime += 500;
  for (let i = 0; i < 4; i++) {
    const s = virtualTime;
    await limiter.acquire();
    assert.equal(virtualTime, s, `Refilled token ${i} should be immediate`);
  }

  // Next token must wait 125ms again
  const beforeNext = virtualTime;
  await limiter.acquire();
  assert.equal(virtualTime - beforeNext, 125);
});

test('detectMandateBreach detects state mutations on BLOCKED cases', () => {
  const before = {
    id: 1,
    spent: '500000',
    reserved: '0',
    deposited: '1250000',
    withdrawn: '0',
    status: 'Active',
    merchantBalance: 100000n,
  };

  // Case 1: No change in state -> not a breach
  const same = { ...before };
  const r1 = detectMandateBreach(before, same, 'BLOCKED');
  assert.equal(r1.isBreach, false);

  // Case 2: spent increased while case was BLOCKED -> BREACH!
  const mutatedSpent = { ...before, spent: '600000' };
  const r2 = detectMandateBreach(before, mutatedSpent, 'BLOCKED');
  assert.equal(r2.isBreach, true);
  assert.match(r2.reason, /spent/);

  // Case 3: merchant balance increased while case was BLOCKED -> BREACH!
  const mutatedMerch = { ...before, merchantBalance: 200000n };
  const r3 = detectMandateBreach(before, mutatedMerch, 'BLOCKED');
  assert.equal(r3.isBreach, true);
  assert.match(r3.reason, /merchantBalance/);

  // Case 4: reserved increased while case was BLOCKED -> BREACH!
  const mutatedReserved = { ...before, reserved: '100000' };
  const r4 = detectMandateBreach(before, mutatedReserved, 'BLOCKED');
  assert.equal(r4.isBreach, true);
  assert.match(r4.reason, /reserved/);
});

test('isResultsPath correctly guards results/ directory from dry mode', () => {
  assert.equal(isResultsPath(join(REPO_ROOT, 'results', 'attack-catalog.json')), true);
  assert.equal(isResultsPath(join(REPO_ROOT, 'results', 'gate.json')), true);
  assert.equal(isResultsPath('scripts/attack-catalog/.out/test.json'), false);
  assert.equal(isResultsPath('.out/test.json'), false);
});

test('dry run session lifecycle creates recovery file (0600), runs cases, and cleans up cleanly', async () => {
  const tmpRecoveryDir = join(process.cwd(), 'scripts/attack-catalog/.out/test-recovery');
  mkdirSync(tmpRecoveryDir, { recursive: true });

  const session = await createTestnetSession({
    dry: true,
    mandatesCount: 3,
    recoveryDir: tmpRecoveryDir,
  });

  // 1. Recovery file created BEFORE accounts and has mode 0600
  assert.ok(existsSync(session.recoveryFile), 'Recovery file must exist');
  const stat = statSync(session.recoveryFile);
  const mode = stat.mode & 0o777;
  assert.equal(mode, 0o600, 'Recovery file permissions must be 0600');

  // Verify structure matches recover.mjs expectation
  const parsedRecovery = JSON.parse(readFileSync(session.recoveryFile, 'utf8'));
  assert.ok(Array.isArray(parsedRecovery.accounts));
  assert.ok(parsedRecovery.accounts.length >= 8); // 1 contract + 1 merchant + 3 agents + 3 guardians = 8
  for (const acct of parsedRecovery.accounts) {
    assert.equal(typeof acct.id, 'string');
    assert.ok(acct.key.startsWith('ed25519:'));
  }

  // 2. Session created 3 mandates with distinct agents/guardians
  assert.equal(session.mandates.length, 3);
  const m1 = await session.viewMandate(1);
  assert.ok(m1);
  assert.equal(m1.deposited, '1250000');
  assert.equal(m1.status, 'Active');
  assert.notEqual(m1.agent, m1.guardian);
  assert.notEqual(m1.agent, m1.owner);

  // 3. Execute sample cases
  const cBlocked = {
    id: 'KAT-E-01-01',
    category: 1,
    layer: 'E',
    title: 'Recipient not allowed',
    params: {
      mandate_id: 1,
      recipientNotAllowed: true,
      recipient: 'intruder.testnet',
    },
    expected: { label: 'BLOCKED', code: 'RECIPIENT_NOT_ALLOWED' },
  };

  const resBlocked = await executeLayerE(cBlocked, session);
  assert.equal(resBlocked.label, 'BLOCKED');
  assert.equal(resBlocked.code, 'RECIPIENT_NOT_ALLOWED');
  assert.ok(resBlocked.txHash, 'Every case must include txHash');

  // 4. Close session: revoke, withdraw, sweep, delete, remove recovery
  const closeRes = await session.closeSession();
  assert.equal(closeRes.clean, true);
  assert.deepEqual(closeRes.leftoverAccounts, []);
  assert.equal(existsSync(session.recoveryFile), false, 'Recovery file unlinked on clean completion');

  rmSync(tmpRecoveryDir, { recursive: true, force: true });
});

test('unclean session keeps recovery file for recover.mjs', async () => {
  const tmpRecoveryDir = join(process.cwd(), 'scripts/attack-catalog/.out/test-recovery-unclean');
  mkdirSync(tmpRecoveryDir, { recursive: true });

  const session = await createTestnetSession({
    dry: true,
    mandatesCount: 2,
    recoveryDir: tmpRecoveryDir,
  });

  const recoveryFile = session.recoveryFile;
  assert.ok(existsSync(recoveryFile));

  // Simulate an account deletion failure
  const originalDelete = session.mockEngine.deleteAccount.bind(session.mockEngine);
  let failedOnce = false;
  session.mockEngine.deleteAccount = async (id, ben) => {
    if (!failedOnce) {
      failedOnce = true;
      throw new Error('Simulated delete network failure');
    }
    return originalDelete(id, ben);
  };

  const closeRes = await session.closeSession();
  assert.equal(closeRes.clean, false);
  assert.ok(closeRes.leftoverAccounts.length > 0, 'Leftover accounts must be recorded');
  assert.ok(existsSync(recoveryFile), 'Recovery file MUST BE KEPT when session is not clean');

  // Clean up test file
  unlinkSync(recoveryFile);
  rmSync(tmpRecoveryDir, { recursive: true, force: true });
});

test('executeLayerE detects BREACH if state mutates on a BLOCKED case', async () => {
  const tmpRecoveryDir = join(process.cwd(), 'scripts/attack-catalog/.out/test-recovery-breach');
  mkdirSync(tmpRecoveryDir, { recursive: true });

  const session = await createTestnetSession({
    dry: true,
    mandatesCount: 1,
    recoveryDir: tmpRecoveryDir,
    limiter: new TokenBucketLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });

  try {
    const cBreach = {
      id: 'KAT-E-03-01',
      category: 3,
      layer: 'E',
      title: 'Simulated parallel breach',
      params: {
        mandate_id: 1,
        simulateBreach: true,
      },
      expected: { label: 'BLOCKED' },
    };

    const res = await executeLayerE(cBreach, session);
    assert.equal(res.label, 'BREACH', 'State mutation on BLOCKED must be classified as BREACH');
    assert.ok(res.txHash);
    assert.match(res.note, /Mandate spent changed/);
  } finally {
    await session.closeSession();
    rmSync(tmpRecoveryDir, { recursive: true, force: true });
  }
});

test('runLayerEInWaves limits wave size <= 60 and writes partial results', async () => {
  const tmpRecoveryDir = join(process.cwd(), 'scripts/attack-catalog/.out/test-recovery-waves');
  const partialFile = join(process.cwd(), 'scripts/attack-catalog/.out/partial-layer-e.json');
  mkdirSync(tmpRecoveryDir, { recursive: true });

  const session = await createTestnetSession({
    dry: true,
    mandatesCount: 1,
    recoveryDir: tmpRecoveryDir,
    limiter: new TokenBucketLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });

  try {
    // Generate 125 cases to test multiple waves (e.g. waveSize 50 -> 3 waves: 50, 50, 25)
    const cases = Array.from({ length: 125 }, (_, i) => ({
      id: `KAT-E-WAVE-${String(i).padStart(3, '0')}`,
      category: 2,
      layer: 'E',
      title: `Wave case ${i}`,
      params: { mandate_id: 1 },
      expected: { label: 'INERT' },
    }));

    const wavesCompleted = [];
    const waveRun = await runLayerEInWaves(cases, session, {
      waveSize: 50, // <= 60
      partialOutPath: partialFile,
      onWaveComplete: (info) => {
        wavesCompleted.push(info);
      },
    });

    assert.equal(waveRun.count, 125);
    assert.equal(wavesCompleted.length, 3);
    assert.equal(wavesCompleted[0].waveResults.length, 50);
    assert.equal(wavesCompleted[1].waveResults.length, 50);
    assert.equal(wavesCompleted[2].waveResults.length, 25);

    // Verify partial output file was written and updated
    assert.ok(existsSync(partialFile));
    const partialData = JSON.parse(readFileSync(partialFile, 'utf8'));
    assert.equal(partialData.processedCount, 125);
    assert.equal(partialData.totalCases, 125);
    assert.equal(partialData.cases.length, 125);
  } finally {
    await session.closeSession();
    if (existsSync(partialFile)) unlinkSync(partialFile);
    rmSync(tmpRecoveryDir, { recursive: true, force: true });
  }
});

test('runLayerEInWaves forbids writing to results/ in dry mode', async () => {
  const tmpRecoveryDir = join(process.cwd(), 'scripts/attack-catalog/.out/test-recovery-prohibit');
  mkdirSync(tmpRecoveryDir, { recursive: true });

  const session = await createTestnetSession({
    dry: true,
    mandatesCount: 1,
    recoveryDir: tmpRecoveryDir,
    limiter: new TokenBucketLimiter({ capacity: 1000, refillPerSecond: 1000 }),
  });

  try {
    const cases = [{
      id: 'KAT-E-PROHIBIT-01',
      category: 1,
      layer: 'E',
      title: 'Prohibited write',
      params: {},
      expected: { label: 'INERT' },
    }];

    await assert.rejects(
      async () => {
        await runLayerEInWaves(cases, session, {
          partialOutPath: join(REPO_ROOT, 'results', 'attack-catalog.json'),
        });
      },
      /Dry mode CANNOT be used to write to results\//
    );
  } finally {
    await session.closeSession();
    rmSync(tmpRecoveryDir, { recursive: true, force: true });
  }
});
