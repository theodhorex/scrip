import test from 'node:test';
import assert from 'node:assert/strict';

import {
  guardedSign,
  GuardBlockedError,
  GuardDeniedError
} from '../src/guarded-sign.mjs';

test('block verdict: throws GuardBlockedError and never calls sign', async () => {
  let signCalls = 0;
  const auditEntries = [];

  const mockChecker = async () => ({
    verdict: 'block',
    score: 100,
    reasons: [{ signal: 'blocklist', level: 'block', detail: 'Known malicious account', source: 'blocklist' }]
  });

  await assert.rejects(
    async () => {
      await guardedSign({
        receiver: 'scammer.near',
        agentId: 'agent.near',
        sign: async () => {
          signCalls++;
          return 'signed-payload';
        },
        checker: mockChecker,
        policy: {
          audit: (entry) => auditEntries.push(entry),
          now: 1_700_000_000_000
        }
      });
    },
    (err) => {
      assert.ok(err instanceof GuardBlockedError);
      assert.equal(err.name, 'GuardBlockedError');
      assert.equal(err.verdict, 'block');
      assert.equal(err.reasons.length, 1);
      assert.equal(err.reasons[0].signal, 'blocklist');
      return true;
    }
  );

  assert.equal(signCalls, 0);
  assert.equal(auditEntries.length, 1);
  assert.deepEqual(auditEntries[0], {
    ts: 1_700_000_000_000,
    receiver: 'scammer.near',
    verdict: 'block',
    decision: 'blocked'
  });
});

test('warn verdict: denied when askHuman returns false', async () => {
  let signCalls = 0;
  let humanAsked = false;
  const auditEntries = [];

  const mockChecker = async () => ({
    verdict: 'warn',
    score: 20,
    reasons: [{ signal: 'account_age', level: 'warn', detail: 'Young account', source: 'history' }]
  });

  await assert.rejects(
    async () => {
      await guardedSign({
        receiver: 'newbie.near',
        agentId: 'agent.near',
        sign: async () => {
          signCalls++;
          return 'signed';
        },
        checker: mockChecker,
        askHuman: async ({ receiver, reasons }) => {
          humanAsked = true;
          assert.equal(receiver, 'newbie.near');
          assert.equal(reasons.length, 1);
          return false;
        },
        policy: {
          audit: (entry) => auditEntries.push(entry),
          now: 1_700_000_000_000
        }
      });
    },
    (err) => {
      assert.ok(err instanceof GuardDeniedError);
      assert.equal(err.name, 'GuardDeniedError');
      assert.equal(err.verdict, 'warn');
      return true;
    }
  );

  assert.equal(humanAsked, true);
  assert.equal(signCalls, 0);
  assert.equal(auditEntries.length, 1);
  assert.deepEqual(auditEntries[0], {
    ts: 1_700_000_000_000,
    receiver: 'newbie.near',
    verdict: 'warn',
    decision: 'denied'
  });
});

test('warn verdict: denied when askHuman is missing or throws', async () => {
  let signCalls = 0;

  const mockChecker = async () => ({
    verdict: 'warn',
    score: 20,
    reasons: [{ signal: 'account_age', level: 'warn', detail: 'Young account', source: 'history' }]
  });

  // Missing askHuman
  await assert.rejects(
    async () => {
      await guardedSign({
        receiver: 'newbie.near',
        sign: async () => { signCalls++; },
        checker: mockChecker
      });
    },
    GuardDeniedError
  );
  assert.equal(signCalls, 0);

  // askHuman throws
  await assert.rejects(
    async () => {
      await guardedSign({
        receiver: 'newbie.near',
        sign: async () => { signCalls++; },
        checker: mockChecker,
        askHuman: async () => { throw new Error('user closed terminal'); }
      });
    },
    GuardDeniedError
  );
  assert.equal(signCalls, 0);
});

test('warn verdict: signs once when askHuman returns exactly true', async () => {
  let signCalls = 0;
  const auditEntries = [];

  const mockChecker = async () => ({
    verdict: 'warn',
    score: 20,
    reasons: [{ signal: 'prior_interaction', level: 'warn', detail: 'New recipient', source: 'interactions' }]
  });

  const res = await guardedSign({
    receiver: 'newbie.near',
    sign: async () => {
      signCalls++;
      return { txHash: '0xabc' };
    },
    checker: mockChecker,
    askHuman: async () => true,
    policy: {
      audit: (entry) => auditEntries.push(entry),
      now: 1_700_000_000_000
    }
  });

  assert.deepEqual(res, { txHash: '0xabc' });
  assert.equal(signCalls, 1);
  assert.equal(auditEntries.length, 1);
  assert.deepEqual(auditEntries[0], {
    ts: 1_700_000_000_000,
    receiver: 'newbie.near',
    verdict: 'warn',
    decision: 'signed'
  });
});

test('allow verdict: signs once without asking human', async () => {
  let signCalls = 0;
  let humanAsked = false;
  const auditEntries = [];

  const mockChecker = async () => ({
    verdict: 'allow',
    score: 0,
    reasons: []
  });

  const res = await guardedSign({
    receiver: 'trusted.near',
    sign: async () => {
      signCalls++;
      return { success: true };
    },
    checker: mockChecker,
    askHuman: async () => {
      humanAsked = true;
      return false;
    },
    policy: {
      audit: (entry) => auditEntries.push(entry),
      now: 1_700_000_000_000
    }
  });

  assert.deepEqual(res, { success: true });
  assert.equal(humanAsked, false);
  assert.equal(signCalls, 1);
  assert.equal(auditEntries.length, 1);
  assert.deepEqual(auditEntries[0], {
    ts: 1_700_000_000_000,
    receiver: 'trusted.near',
    verdict: 'allow',
    decision: 'signed'
  });
});

test('fail-closed: checker throwing or returning invalid verdict denies signing', async () => {
  let signCalls = 0;

  // Checker throws
  await assert.rejects(
    async () => {
      await guardedSign({
        receiver: 'alice.near',
        sign: async () => { signCalls++; },
        checker: async () => { throw new Error('network crash'); }
      });
    },
    GuardDeniedError
  );
  assert.equal(signCalls, 0);

  // Checker returns malformed shape
  await assert.rejects(
    async () => {
      await guardedSign({
        receiver: 'alice.near',
        sign: async () => { signCalls++; },
        checker: async () => ({ verdict: 'super-allow' })
      });
    },
    GuardDeniedError
  );
  assert.equal(signCalls, 0);
});

test('property-based: sign is called at most once, and NEVER when verdict is block', async () => {
  const verdicts = ['allow', 'warn', 'block', 'corrupted', 'throw'];

  for (let i = 0; i < 100; i++) {
    const verdictType = verdicts[i % verdicts.length];
    let signCalls = 0;
    const humanApproval = i % 2 === 0;

    const checker = async () => {
      if (verdictType === 'throw') throw new Error('simulated error');
      return {
        verdict: verdictType,
        score: verdictType === 'block' ? 100 : (verdictType === 'warn' ? 20 : 0),
        reasons: [{ signal: 'test', level: verdictType === 'corrupted' ? 'info' : verdictType, detail: 'test' }]
      };
    };

    try {
      await guardedSign({
        receiver: `acc-${i}.near`,
        sign: async () => {
          signCalls++;
          return 'ok';
        },
        checker,
        askHuman: async () => humanApproval
      });
    } catch (err) {
      // expected for blocked or denied
    }

    if (verdictType === 'block') {
      assert.equal(signCalls, 0, `sign must never be called on block (iteration ${i})`);
    }
    assert.ok(signCalls <= 1, `sign must never be called more than once (iteration ${i})`);
  }
});
