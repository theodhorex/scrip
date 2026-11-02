// Mutation-targeted tests for src/guarded-sign.mjs (task C6).
// Pins error classes, exact error messages and fields, audit records on all paths,
// strict boolean comparison for human approval, parameter validation, and defaults.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  guardedSign,
  GuardBlockedError,
  GuardDeniedError
} from '../src/guarded-sign.mjs';

test('GuardBlockedError: defaults and custom properties pin error shape', () => {
  // Defaults
  const def = new GuardBlockedError();
  assert.ok(def instanceof Error);
  assert.ok(def instanceof GuardBlockedError);
  assert.equal(def.name, 'GuardBlockedError');
  assert.equal(def.message, 'Guard blocked execution');
  assert.equal(def.verdict, 'block');
  assert.deepEqual(def.reasons, []);

  // Custom options
  const customReasons = [{ signal: 'blocklist', level: 'block' }];
  const custom = new GuardBlockedError('Blocked by rule', { verdict: 'block', reasons: customReasons });
  assert.equal(custom.name, 'GuardBlockedError');
  assert.equal(custom.message, 'Blocked by rule');
  assert.equal(custom.verdict, 'block');
  assert.equal(custom.reasons, customReasons);
});

test('GuardDeniedError: defaults and custom properties pin error shape', () => {
  // Defaults
  const def = new GuardDeniedError();
  assert.ok(def instanceof Error);
  assert.ok(def instanceof GuardDeniedError);
  assert.equal(def.name, 'GuardDeniedError');
  assert.equal(def.message, 'Guard denied execution');
  assert.equal(def.verdict, 'warn');
  assert.deepEqual(def.reasons, []);

  // Custom options
  const customReasons = [{ signal: 'account_age', level: 'warn' }];
  const custom = new GuardDeniedError('User rejected prompt', { verdict: 'unknown', reasons: customReasons });
  assert.equal(custom.name, 'GuardDeniedError');
  assert.equal(custom.message, 'User rejected prompt');
  assert.equal(custom.verdict, 'unknown');
  assert.equal(custom.reasons, customReasons);
});

test('guardedSign parameter validation: sign must be an executable function', async () => {
  for (const badSign of [null, undefined, 123, 'not a function', {}, []]) {
    await assert.rejects(
      async () => {
        await guardedSign({
          receiver: 'alice.near',
          sign: badSign
        });
      },
      {
        name: 'TypeError',
        message: 'sign must be an executable function'
      }
    );
  }
});

test('audit and error path: checker throwing invokes audit with unknown/denied and throws GuardDeniedError', async () => {
  const auditLogs = [];
  const fixedNow = 1_700_000_123_456;

  await assert.rejects(
    async () => {
      await guardedSign({
        receiver: 'bob.near',
        agentId: 'agent-1',
        sign: async () => 'should not run',
        checker: async () => { throw new Error('rpc connection refused'); },
        policy: {
          now: fixedNow,
          audit: (entry) => auditLogs.push(entry)
        }
      });
    },
    (err) => {
      assert.ok(err instanceof GuardDeniedError);
      assert.equal(err.name, 'GuardDeniedError');
      assert.equal(err.message, 'Checker failed or threw an error: rpc connection refused');
      assert.equal(err.verdict, 'unknown');
      assert.deepEqual(err.reasons, []);
      return true;
    }
  );

  assert.equal(auditLogs.length, 1);
  assert.deepEqual(auditLogs[0], {
    ts: fixedNow,
    receiver: 'bob.near',
    verdict: 'unknown',
    decision: 'denied'
  });
});

test('audit and error path: malformed checker outputs invoke audit with unknown/denied and exact error message', async () => {
  const fixedNow = 1_700_000_000_000;
  const malformedOutputs = [
    null,
    undefined,
    123,
    'allow',
    {},
    { verdict: 'invalid' },
    { verdict: 'ALLOW' },
    { verdict: 'denied' },
    { verdict: null }
  ];

  for (const output of malformedOutputs) {
    const auditLogs = [];
    await assert.rejects(
      async () => {
        await guardedSign({
          receiver: 'bob.near',
          sign: async () => 'should not run',
          checker: async () => output,
          policy: {
            now: fixedNow,
            audit: (entry) => auditLogs.push(entry)
          }
        });
      },
      (err) => {
        assert.ok(err instanceof GuardDeniedError);
        assert.equal(err.name, 'GuardDeniedError');
        assert.equal(err.message, 'Checker returned malformed output or unknown verdict');
        assert.equal(err.verdict, 'unknown');
        assert.deepEqual(err.reasons, []);
        return true;
      }
    );

    assert.equal(auditLogs.length, 1);
    assert.deepEqual(auditLogs[0], {
      ts: fixedNow,
      receiver: 'bob.near',
      verdict: 'unknown',
      decision: 'denied'
    });
  }
});

test('audit and error path: block verdict invokes audit with block/blocked and throws GuardBlockedError with reasons', async () => {
  const auditLogs = [];
  const fixedNow = 1_700_000_000_000;
  const blockReasons = [
    { signal: 'blocklist', level: 'block', detail: 'Identified scammer', source: 'blocklist' }
  ];

  let signCalled = false;
  let humanAsked = false;

  await assert.rejects(
    async () => {
      await guardedSign({
        receiver: 'scammer.near',
        sign: async () => { signCalled = true; },
        checker: async () => ({ verdict: 'block', reasons: blockReasons }),
        askHuman: async () => { humanAsked = true; return true; },
        policy: {
          now: fixedNow,
          audit: (entry) => auditLogs.push(entry)
        }
      });
    },
    (err) => {
      assert.ok(err instanceof GuardBlockedError);
      assert.equal(err.name, 'GuardBlockedError');
      assert.equal(err.message, 'Execution blocked by guard');
      assert.equal(err.verdict, 'block');
      assert.equal(err.reasons, blockReasons);
      return true;
    }
  );

  assert.equal(signCalled, false);
  assert.equal(humanAsked, false);
  assert.equal(auditLogs.length, 1);
  assert.deepEqual(auditLogs[0], {
    ts: fixedNow,
    receiver: 'scammer.near',
    verdict: 'block',
    decision: 'blocked'
  });
});

test('audit and error path: warn verdict with non-boolean truthy askHuman returns strictly denies execution', async () => {
  // Critical mutation: humanDecision === true mutated to humanDecision (truthy)
  // Values like 'yes', 1, {}, [] are truthy in JS but MUST NOT approve!
  const fixedNow = 1_700_000_000_000;
  const warnReasons = [{ signal: 'account_age', level: 'warn', detail: 'New', source: 'history' }];
  const nonBooleanTruthy = ['true', 1, 'yes', {}, [], () => {}];

  for (const fakeApproved of nonBooleanTruthy) {
    const auditLogs = [];
    let signCalled = false;

    await assert.rejects(
      async () => {
        await guardedSign({
          receiver: 'newbie.near',
          sign: async () => { signCalled = true; },
          checker: async () => ({ verdict: 'warn', reasons: warnReasons }),
          askHuman: async () => fakeApproved,
          policy: {
            now: fixedNow,
            audit: (entry) => auditLogs.push(entry)
          }
        });
      },
      (err) => {
        assert.ok(err instanceof GuardDeniedError);
        assert.equal(err.name, 'GuardDeniedError');
        assert.equal(err.message, 'Execution denied after warning');
        assert.equal(err.verdict, 'warn');
        assert.equal(err.reasons, warnReasons);
        return true;
      }
    );

    assert.equal(signCalled, false);
    assert.equal(auditLogs.length, 1);
    assert.deepEqual(auditLogs[0], {
      ts: fixedNow,
      receiver: 'newbie.near',
      verdict: 'warn',
      decision: 'denied'
    });
  }
});

test('audit and error path: warn verdict with strictly true askHuman invokes audit warn/signed and returns sign result', async () => {
  const auditLogs = [];
  const fixedNow = 1_700_000_000_000;
  const warnReasons = [{ signal: 'account_age', level: 'warn', detail: 'New', source: 'history' }];

  let signCalls = 0;
  let receivedArgs = null;

  const result = await guardedSign({
    receiver: 'newbie.near',
    sign: async () => {
      signCalls++;
      return { txId: '0x123' };
    },
    checker: async () => ({ verdict: 'warn', reasons: warnReasons }),
    askHuman: async (args) => {
      receivedArgs = args;
      return true; // Strictly true
    },
    policy: {
      now: fixedNow,
      audit: (entry) => auditLogs.push(entry)
    }
  });

  assert.deepEqual(result, { txId: '0x123' });
  assert.equal(signCalls, 1);
  assert.deepEqual(receivedArgs, {
    receiver: 'newbie.near',
    reasons: warnReasons
  });
  assert.equal(auditLogs.length, 1);
  assert.deepEqual(auditLogs[0], {
    ts: fixedNow,
    receiver: 'newbie.near',
    verdict: 'warn',
    decision: 'signed'
  });
});

test('audit and happy path: allow verdict invokes audit allow/signed, skips askHuman, and returns sign result', async () => {
  const auditLogs = [];
  const fixedNow = 1_700_000_000_000;
  let humanAsked = false;

  const result = await guardedSign({
    receiver: 'trusted.near',
    sign: async () => 'signature-abc',
    checker: async () => ({ verdict: 'allow', score: 0, reasons: [] }),
    askHuman: async () => { humanAsked = true; return false; },
    policy: {
      now: fixedNow,
      audit: (entry) => auditLogs.push(entry)
    }
  });

  assert.equal(result, 'signature-abc');
  assert.equal(humanAsked, false);
  assert.equal(auditLogs.length, 1);
  assert.deepEqual(auditLogs[0], {
    ts: fixedNow,
    receiver: 'trusted.near',
    verdict: 'allow',
    decision: 'signed'
  });
});

test('guardedSign defaults: integrates with checkCounterparty when checker is omitted', async () => {
  const now = 1_700_000_000_000;
  const pinStore = new Map();
  const validProviders = {
    accountHistory: async () => ({ firstSeenMs: now - 30 * 86400000, txCount: 10 }),
    accountState: async () => ({ exists: true, codeHash: null }),
    codePin: { get: async (r) => pinStore.get(r) ?? null, set: async (r, h) => { pinStore.set(r, h); } },
    interactions: async () => ({ count: 5 }),
    blocklist: { lookup: async () => null }
  };

  // 1. Valid clean receiver passes default checker
  const res = await guardedSign({
    receiver: 'alice.near',
    sign: async () => 'signed-success',
    policy: {
      providers: validProviders,
      now
    }
  });
  assert.equal(res, 'signed-success');

  // 2. Invalid receiver triggers checkCounterparty block verdict
  await assert.rejects(
    async () => {
      await guardedSign({
        receiver: 'INVALID_UPPERCASE.near',
        sign: async () => 'never',
        policy: {
          providers: validProviders,
          now
        }
      });
    },
    (err) => {
      assert.ok(err instanceof GuardBlockedError);
      assert.equal(err.reasons[0].signal, 'input');
      return true;
    }
  );
});

test('property: audit callback called exactly once per invocation with correct decision and ts', async () => {
  function lcg(seed) {
    let s = seed >>> 0;
    return () => {
      s = (s + 0x6d2b79f5) >>> 0;
      let t = s;
      t = Math.imul(t ^ (t >>> 15), t | 1);
      t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }

  const rnd = lcg(0x1337);
  const possibleVerdicts = ['allow', 'warn', 'block', 'throw', 'malformed'];

  for (let i = 0; i < 100; i++) {
    const vType = possibleVerdicts[Math.floor(rnd() * possibleVerdicts.length)];
    const humanSays = rnd() > 0.5;
    const auditLogs = [];
    const testNow = 1_700_000_000_000 + i;
    let signCalls = 0;

    const checker = async () => {
      if (vType === 'throw') throw new Error('pbt err');
      if (vType === 'malformed') return { bad: true };
      return { verdict: vType, reasons: [] };
    };

    let succeeded = false;
    try {
      await guardedSign({
        receiver: `user-${i}.near`,
        sign: async () => { signCalls++; return 'signed'; },
        checker,
        askHuman: async () => humanSays,
        policy: { now: testNow, audit: (entry) => auditLogs.push(entry) }
      });
      succeeded = true;
    } catch (_) {
      succeeded = false;
    }

    assert.equal(auditLogs.length, 1, `iteration ${i}: audit must be called exactly once`);
    assert.equal(auditLogs[0].ts, testNow);

    if (succeeded) {
      assert.equal(signCalls, 1);
      assert.equal(auditLogs[0].decision, 'signed');
      assert.ok(auditLogs[0].verdict === 'allow' || auditLogs[0].verdict === 'warn');
    } else {
      assert.equal(signCalls, 0);
      assert.ok(auditLogs[0].decision === 'blocked' || auditLogs[0].decision === 'denied');
    }
  }
});
