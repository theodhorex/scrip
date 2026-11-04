// Tests for Layer E State Preparation and Callback Settlement Synchronization
// Verifies:
// 1. remainingBudget preparation sequence: prep -> available == target -> case executes -> OVER_BUDGET
// 2. openRequestsCount preparation sequence: prep -> open_requests == target -> case executes -> TOO_MANY_OPEN
// 3. Queue saturation: openRequestsCount: 32 executes cleanly as INERT
// 4. Mutation proof: disabling state preparation causes expected BLOCKED cases to fail (return INERT)
// 5. Settlement polling and breach detection: prior pending callback settlement does not flag false BREACH

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestnetSession,
  executeLayerE,
  detectMandateBreach,
  waitForSettlement,
  prepareCaseState,
} from '../layers/testnet.mjs';
import { getLayerECases } from '../cases/layer_e/index.mjs';

test('state preparation: remainingBudget correctly depletes mandate and triggers OVER_BUDGET', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    const c = {
      id: 'KAT-E-03-26',
      category: 3,
      layer: 'E',
      title: 'Payment exceeding remaining free budget by 1',
      params: {
        mandate_id: 1,
        amount: '100001',
        remainingBudget: '100000',
        method: 'request_payment',
        args: {
          mandate_id: 1,
          recipient: 'merchant.testnet',
          amount: '100001',
          nonce: 1026,
        },
      },
      expected: {
        label: 'BLOCKED',
        code: 'OVER_BUDGET',
      },
    };

    // 1. Before prep: mandate has full 1,250,000 budget
    const initialM = await session.viewMandate(1);
    assert.equal(initialM.spent, '0');
    assert.equal(initialM.budget, '1250000');

    // 2. Execute case through Layer E (includes preparation sequence)
    const actual = await executeLayerE(c, session);

    // 3. Verify sequence outcome: state reached remainingBudget 100,000, case rejected OVER_BUDGET
    const afterM = await session.viewMandate(1);
    assert.equal(afterM.spent, '1150000', 'Mandate must have spent 1,150,000 to leave 100,000 remaining');
    assert.equal(actual.label, 'BLOCKED');
    assert.equal(actual.code, 'OVER_BUDGET');
  } finally {
    await session.closeSession();
  }
});

test('state preparation: openRequestsCount prepares queue to MAX_OPEN and triggers TOO_MANY_OPEN', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    const c = {
      id: 'KAT-E-03-34',
      category: 3,
      layer: 'E',
      title: 'Queue overflow beyond MAX_OPEN (33/32)',
      params: {
        mandate_id: 1,
        amount: '1000',
        openRequestsCount: 33,
        method: 'request_payment',
        args: {
          mandate_id: 1,
          recipient: 'merchant.testnet',
          amount: '1000',
          nonce: 1034,
        },
      },
      expected: {
        label: 'BLOCKED',
        code: 'TOO_MANY_OPEN',
      },
    };

    const actual = await executeLayerE(c, session);

    // Mandate queue reached 32 open requests, 33rd request triggers TOO_MANY_OPEN
    const m = await session.viewMandate(1);
    assert.equal(m.open_requests, 32);
    assert.equal(actual.label, 'BLOCKED');
    assert.equal(actual.code, 'TOO_MANY_OPEN');
  } finally {
    await session.closeSession();
  }
});

test('state preparation: queue saturation at 32/32 prepares 31 open requests and executes as INERT', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    const c = {
      id: 'KAT-E-03-33',
      category: 3,
      layer: 'E',
      title: 'Queue saturation near MAX_OPEN (32/32)',
      params: {
        mandate_id: 1,
        amount: '1000',
        openRequestsCount: 32,
        method: 'request_payment',
        args: {
          mandate_id: 1,
          recipient: 'merchant.testnet',
          amount: '1000',
          nonce: 1033,
        },
      },
      expected: {
        label: 'INERT',
        code: null,
      },
    };

    const actual = await executeLayerE(c, session);
    assert.equal(actual.label, 'INERT');
  } finally {
    await session.closeSession();
  }
});

test('manual mutation proof: disabling state preparation causes tests to fail', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    // Case expecting OVER_BUDGET when remainingBudget is 100,000
    const cBudget = {
      id: 'KAT-E-03-26',
      category: 3,
      layer: 'E',
      title: 'Payment exceeding remaining free budget by 1',
      params: {
        mandate_id: 1,
        amount: '100001',
        remainingBudget: '100000',
        skipStatePrep: true, // MUTATION: Disable prep
        args: {
          mandate_id: 1,
          recipient: 'merchant.testnet',
          amount: '100001',
          nonce: 1026,
        },
      },
      expected: {
        label: 'BLOCKED',
        code: 'OVER_BUDGET',
      },
    };

    const actualBudget = await executeLayerE(cBudget, session);
    // Without prep, mandate has 1.25M available so 100,001 succeeds as INERT instead of OVER_BUDGET
    assert.notEqual(actualBudget.code, 'OVER_BUDGET', 'Mutation proof: without prep, code must NOT be OVER_BUDGET');
    assert.equal(actualBudget.label, 'INERT', 'Without prep, unspent budget allows transaction');

    // Case expecting TOO_MANY_OPEN
    const cQueue = {
      id: 'KAT-E-03-34',
      category: 3,
      layer: 'E',
      title: 'Queue overflow beyond MAX_OPEN (33/32)',
      params: {
        mandate_id: 1,
        amount: '1000',
        openRequestsCount: 33,
        skipStatePrep: true, // MUTATION: Disable prep
        args: {
          mandate_id: 1,
          recipient: 'merchant.testnet',
          amount: '1000',
          nonce: 1034,
        },
      },
      expected: {
        label: 'BLOCKED',
        code: 'TOO_MANY_OPEN',
      },
    };

    const actualQueue = await executeLayerE(cQueue, session);
    // Without prep, open_requests is 0 so request succeeds as INERT instead of TOO_MANY_OPEN
    assert.notEqual(actualQueue.code, 'TOO_MANY_OPEN', 'Mutation proof: without prep, code must NOT be TOO_MANY_OPEN');
    assert.equal(actualQueue.label, 'INERT');
  } finally {
    await session.closeSession();
  }
});

test('settlement polling & breach protection: prior pending callback does not trigger false BREACH', async () => {
  // Case marked BLOCKED, but had a prior pending callback (priorPendingReserved = 1000)
  // Spent changed 308455 -> 309455 because prior pending payment settled.
  const beforeWithPending = {
    id: 1,
    spent: '308455',
    reserved: '1000',
    deposited: '1250000',
    withdrawn: '0',
    status: 'Active',
    priorPendingReserved: 1000n, // Prior in-flight request was pending
    merchantBalance: 308455n,
  };
  const afterSettled = {
    id: 1,
    spent: '309455',
    reserved: '0',
    deposited: '1250000',
    withdrawn: '0',
    status: 'Active',
    merchantBalance: 309455n,
  };

  // Must NOT be marked breach because it was a prior pending settlement
  const res1 = detectMandateBreach(beforeWithPending, afterSettled, 'BLOCKED');
  assert.equal(res1.isBreach, false, 'Prior pending resolution must NOT be flagged as BREACH');

  // Conversely, without prior pending (pure blocked case), unexpected spent mutation IS a BREACH
  const beforeClean = {
    ...beforeWithPending,
    priorPendingReserved: 0n,
    reserved: '0',
  };
  const res2 = detectMandateBreach(beforeClean, afterSettled, 'BLOCKED');
  assert.equal(res2.isBreach, true, 'Unexpected spent mutation without prior pending IS a BREACH');
});

test('state preparation: Cat 4 NEEDS_APPROVAL, APPROVAL_USED, APPROVAL_EXPIRED', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 4 });
  try {
    // 1. NEEDS_APPROVAL with amount <= cap: tightens threshold to amount - 1
    const cNeeds = {
      id: 'KAT-E-04-05',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 1,
        method: 'request_payment',
        args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 9999 },
      },
      expected: { label: 'BLOCKED', code: 'NEEDS_APPROVAL' },
    };
    const actNeeds = await executeLayerE(cNeeds, session);
    assert.equal(actNeeds.label, 'BLOCKED');
    assert.equal(actNeeds.code, 'NEEDS_APPROVAL');

    // 2. NEEDS_APPROVAL with amount > per_payment_cap (500001): must be SKIPPED
    const cOverCap = {
      id: 'KAT-E-04-02',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 1,
        method: 'request_payment',
        args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500001', nonce: 2 },
      },
      expected: { label: 'BLOCKED', code: 'NEEDS_APPROVAL' },
    };
    const actOverCap = await executeLayerE(cOverCap, session);
    assert.equal(actOverCap.label, 'SKIPPED');
    assert.ok(actOverCap.note.includes('per_payment_cap'));

    // 3. APPROVAL_USED: prepares approval, consumes it, case re-executes -> APPROVAL_USED
    const cUsed = {
      id: 'KAT-E-04-06',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 2,
        method: 'request_payment',
        args: { mandate_id: 2, recipient: 'merchant.testnet', amount: '500000', nonce: 4 },
      },
      expected: { label: 'BLOCKED', code: 'APPROVAL_USED' },
    };
    const actUsed = await executeLayerE(cUsed, session);
    assert.equal(actUsed.label, 'BLOCKED');
    assert.equal(actUsed.code, 'APPROVAL_USED');

    // 4. APPROVAL_EXPIRED: prepares approval with expired timestamp -> APPROVAL_EXPIRED
    const cExp = {
      id: 'KAT-E-04-13',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 3,
        method: 'request_payment',
        args: { mandate_id: 3, recipient: 'merchant.testnet', amount: '500000', nonce: 19 },
      },
      expected: { label: 'BLOCKED', code: 'APPROVAL_EXPIRED' },
    };
    const actExp = await executeLayerE(cExp, session);
    assert.equal(actExp.label, 'BLOCKED');
    assert.equal(actExp.code, 'APPROVAL_EXPIRED');

    // 5. ALREADY_APPROVED via request_payment: inconsistent with contract -> SKIPPED
    const cReqAA = {
      id: 'KAT-E-04-23',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 4,
        method: 'request_payment',
        args: { mandate_id: 4, recipient: 'merchant.testnet', amount: '500000', nonce: 507 },
      },
      expected: { label: 'BLOCKED', code: 'ALREADY_APPROVED' },
    };
    const actReqAA = await executeLayerE(cReqAA, session);
    assert.equal(actReqAA.label, 'SKIPPED');
    assert.ok(actReqAA.note.includes('ALREADY_APPROVED'));
  } finally {
    await session.closeSession();
  }
});

test('state preparation: Cat 4 direct approve_intent methods', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    // 1. KAT-E-04-10 duplicate approve_intent -> ALREADY_APPROVED
    const cDup = {
      id: 'KAT-E-04-10',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 1,
        method: 'approve_intent',
        args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 4, approval_expires_at_ms: Date.now() + 3600000 },
      },
      expected: { label: 'BLOCKED', code: 'ALREADY_APPROVED' },
    };
    const actDup = await executeLayerE(cDup, session);
    assert.equal(actDup.label, 'BLOCKED');
    assert.equal(actDup.code, 'ALREADY_APPROVED');

    // 2. KAT-E-04-11 insufficient deposit -> INSUFFICIENT_APPROVAL_DEPOSIT
    const cDep = {
      id: 'KAT-E-04-11',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 1,
        method: 'approve_intent',
        deposit: '1000000000000000000000',
        args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 15, approval_expires_at_ms: Date.now() + 3600000 },
      },
      expected: { label: 'BLOCKED', code: 'INSUFFICIENT_APPROVAL_DEPOSIT' },
    };
    const actDep = await executeLayerE(cDep, session);
    assert.equal(actDep.label, 'BLOCKED');
    assert.equal(actDep.code, 'INSUFFICIENT_APPROVAL_DEPOSIT');

    // 3. KAT-E-04-15 expiry in past -> APPROVAL_NOT_IN_FUTURE
    const cPast = {
      id: 'KAT-E-04-15',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 1,
        method: 'approve_intent',
        args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 21, approval_expires_at_ms: 1000 },
      },
      expected: { label: 'BLOCKED', code: 'APPROVAL_NOT_IN_FUTURE' },
    };
    const actPast = await executeLayerE(cPast, session);
    assert.equal(actPast.label, 'BLOCKED');
    assert.equal(actPast.code, 'APPROVAL_NOT_IN_FUTURE');

    // 4. KAT-E-04-12 TOO_MANY_APPROVALS -> SKIPPED (expensive)
    const cMany = {
      id: 'KAT-E-04-12',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 1,
        method: 'approve_intent',
        args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 513, approval_expires_at_ms: Date.now() + 3600000 },
      },
      expected: { label: 'BLOCKED', code: 'TOO_MANY_APPROVALS' },
    };
    const actMany = await executeLayerE(cMany, session);
    assert.equal(actMany.label, 'SKIPPED');
  } finally {
    await session.closeSession();
  }
});

test('state preparation: Cat 4 seeded duplicate approve_intent (ALREADY_APPROVED)', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    const cases = getLayerECases();
    const targetIds = [
      'KAT-E-04-35',
      'KAT-E-04-41',
      'KAT-E-04-45',
      'KAT-E-04-48',
      'KAT-E-04-49',
      'KAT-E-04-52',
      'KAT-E-04-54',
      'KAT-E-04-57',
    ];
    for (const id of targetIds) {
      const c = cases.find((x) => x.id === id);
      assert.ok(c, `Case ${id} not found`);
      assert.equal(c.params.method, 'approve_intent', `Case ${id} should use approve_intent`);
      assert.ok(c.params.args.approval_expires_at_ms > Date.now(), `Case ${id} approval_expires_at_ms must be in future`);
      const act = await executeLayerE(c, session);
      assert.equal(act.label, 'BLOCKED', `Case ${id} should be BLOCKED`);
      assert.equal(act.code, 'ALREADY_APPROVED', `Case ${id} should have code ALREADY_APPROVED`);
    }
  } finally {
    await session.closeSession();
  }
});

test('manual mutation proof: Cat 4 state prep disable causes failure', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    // With skipStatePrep: true, NEEDS_APPROVAL case executes without threshold tightening -> INERT
    const cNeedsMut = {
      id: 'KAT-E-04-05',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 1,
        skipStatePrep: true, // MUTATION: Disable prep
        method: 'request_payment',
        args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 9999 },
      },
      expected: { label: 'BLOCKED', code: 'NEEDS_APPROVAL' },
    };
    const actNeedsMut = await executeLayerE(cNeedsMut, session);
    assert.equal(actNeedsMut.label, 'INERT', 'Without threshold tightening, 500000 payment does not need approval');

    // With skipStatePrep: true, APPROVAL_USED case executes without prior consumption -> INERT
    const cUsedMut = {
      id: 'KAT-E-04-06',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 1,
        skipStatePrep: true, // MUTATION: Disable prep
        method: 'request_payment',
        args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 4 },
      },
      expected: { label: 'BLOCKED', code: 'APPROVAL_USED' },
    };
    const actUsedMut = await executeLayerE(cUsedMut, session);
    assert.equal(actUsedMut.label, 'INERT', 'Without prior consumption, payment does not trigger APPROVAL_USED');

    // With skipStatePrep: true, seeded duplicate approve_intent executes without prior approval -> INERT
    const cDupMut = {
      id: 'KAT-E-04-35',
      category: 4,
      layer: 'E',
      params: {
        mandate_id: 1,
        skipStatePrep: true, // MUTATION: Disable prep
        method: 'approve_intent',
        args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 519, approval_expires_at_ms: Date.now() + 3600000 },
      },
      expected: { label: 'BLOCKED', code: 'ALREADY_APPROVED' },
    };
    const actDupMut = await executeLayerE(cDupMut, session);
    assert.equal(actDupMut.label, 'INERT', 'Without prior registration, approve_intent succeeds as INERT');
  } finally {
    await session.closeSession();
  }
});

// --- H3: layer E state prep for cat 5/10 cases that were set up against the wrong state ---

test('state preparation: KAT-E-05-09 lowers budget so the guardian loosen is legal', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    const c = {
      id: 'KAT-E-05-09',
      category: 5,
      layer: 'E',
      params: {
        mandate_id: 1,
        method: 'loosen',
        loosenBudgetPrep: '1000000',
        args: { mandate_id: 1, change: { Budget: '1250000' } },
      },
      expected: { label: 'INERT', code: null },
    };

    // Budget starts equal to deposited (1250000), so no valid raise exists until prep lowers it.
    const prep = await prepareCaseState(c, session);
    assert.equal(prep.ok, true, prep.reason);
    assert.equal((await session.viewMandate(1)).budget, '1000000', 'prep must lower budget below deposited');

    const actual = await executeLayerE(c, session);
    assert.equal(actual.label, 'INERT');
    assert.equal(actual.code, null);
    const m = await session.viewMandate(1);
    assert.equal(m.budget, '1250000', 'loosen must raise budget back to the deposited ceiling');
  } finally {
    await session.closeSession();
  }
});

test('state preparation: KAT-E-10-20 fills the allowlist to 16 recipients before the 17th', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    const c = {
      id: 'KAT-E-10-20',
      category: 10,
      layer: 'E',
      params: {
        mandate_id: 1,
        method: 'loosen',
        recipientsCount: 16,
        args: { mandate_id: 1, change: { AddRecipient: 'merchant17.testnet' } },
      },
      expected: { label: 'BLOCKED', code: 'TOO_MANY_RECIPIENTS' },
    };

    const prep = await prepareCaseState(c, session);
    assert.equal(prep.ok, true, prep.reason);
    assert.equal((await session.viewMandate(1)).recipients.length, 16, 'prep must reach MAX_RECIPIENTS');

    const actual = await executeLayerE(c, session);
    assert.equal(actual.label, 'BLOCKED');
    assert.equal(actual.code, 'TOO_MANY_RECIPIENTS');

    const after = await session.viewMandate(1);
    assert.equal(after.recipients.length, 16, 'the 17th recipient must not be stored');
    assert.equal(after.recipients.includes('merchant17.testnet'), false);
  } finally {
    await session.closeSession();
  }
});

test('state preparation: KAT-E-10-21 creates a fresh Pending so resolve_stale is NOT_STALE_YET', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    const c = {
      id: 'KAT-E-10-21',
      category: 10,
      layer: 'E',
      params: {
        mandate_id: 1,
        method: 'resolve_stale',
        pendingRequest: 'fresh',
        amount: '1000',
        args: { mandate_id: 1, request_id: 1, transferred: false },
      },
      expected: { label: 'BLOCKED', code: 'NOT_STALE_YET' },
    };

    const prep = await prepareCaseState(c, session);
    assert.equal(prep.ok, true, prep.reason);
    assert.ok(session.mockEngine.pending.has('1:1'), 'prep must create the Pending entry');
    assert.equal((await session.viewMandate(1)).reserved, '1000');

    const actual = await executeLayerE(c, session);
    assert.equal(actual.label, 'BLOCKED');
    assert.equal(actual.code, 'NOT_STALE_YET');
    assert.ok(session.mockEngine.pending.has('1:1'), 'a non-stale Pending must stay unresolved');
  } finally {
    await session.closeSession();
  }
});

test('state preparation: KAT-E-05-25 needs a stale Pending (>= 200 blocks) to resolve as INERT', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    const c = {
      id: 'KAT-E-05-25',
      category: 5,
      layer: 'E',
      params: {
        mandate_id: 1,
        isStale: true,
        pendingRequest: 'stale',
        amount: '1000',
        method: 'resolve_stale',
        args: { mandate_id: 1, request_id: 1, transferred: true },
      },
      expected: { label: 'INERT', code: null },
    };

    const prep = await prepareCaseState(c, session);
    assert.equal(prep.ok, true, prep.reason);
    const p = session.mockEngine.pending.get('1:1');
    assert.ok(p, 'prep must create the Pending entry');
    assert.ok(2000 - p.height >= 200, 'Pending must be at least STALE_BLOCKS old');

    const actual = await executeLayerE(c, session);
    assert.equal(actual.label, 'INERT');
    const m = await session.viewMandate(1);
    assert.equal(m.reserved, '0', 'resolve must release the reservation');
    assert.equal(m.spent, '1000', 'transferred=true settles reserved -> spent');
    assert.equal(session.mockEngine.pending.has('1:1'), false);
  } finally {
    await session.closeSession();
  }
});

test('manual mutation proof: skipping the H3 state prep changes the four outcomes', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 2 });
  try {
    const run = (c) => executeLayerE({ ...c, params: { ...c.params, skipStatePrep: true } }, session);

    const loosen = await run({
      id: 'KAT-E-05-09', category: 5, layer: 'E',
      params: { mandate_id: 1, method: 'loosen', loosenBudgetPrep: '1000000', args: { mandate_id: 1, change: { Budget: '1250000' } } },
      expected: { label: 'INERT', code: null },
    });
    assert.equal(loosen.code, 'NOT_LOOSER', 'without prep the budget is already at the ceiling');

    const recipients = await run({
      id: 'KAT-E-10-20', category: 10, layer: 'E',
      params: { mandate_id: 1, method: 'loosen', recipientsCount: 16, args: { mandate_id: 1, change: { AddRecipient: 'merchant17.testnet' } } },
      expected: { label: 'BLOCKED', code: 'TOO_MANY_RECIPIENTS' },
    });
    assert.equal(recipients.label, 'INERT', 'without prep there is room for the recipient');

    const fresh = await run({
      id: 'KAT-E-10-21', category: 10, layer: 'E',
      params: { mandate_id: 1, method: 'resolve_stale', pendingRequest: 'fresh', args: { mandate_id: 1, request_id: 1, transferred: false } },
      expected: { label: 'BLOCKED', code: 'NOT_STALE_YET' },
    });
    assert.equal(fresh.code, 'NO_SUCH_PENDING', 'without prep there is no Pending entry');

    const stale = await run({
      id: 'KAT-E-05-25', category: 5, layer: 'E',
      params: { mandate_id: 1, method: 'resolve_stale', isStale: true, pendingRequest: 'stale', args: { mandate_id: 1, request_id: 1, transferred: true } },
      expected: { label: 'INERT', code: null },
    });
    assert.equal(stale.code, 'NO_SUCH_PENDING', 'without prep there is no stale Pending entry');
  } finally {
    await session.closeSession();
  }
});
