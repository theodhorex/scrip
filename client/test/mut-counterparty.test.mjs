// Mutation-targeted tests for src/counterparty.mjs (task C6).
// Pins exact values, boundaries, comparison operators, reason structures,
// scoring weights, evidence validation, and fail-closed branches.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkCounterparty, createDefaultProviders } from '../src/counterparty.mjs';

const VALID_TX_HASH = '4uQpvRwYhS3nT6kLzA8cJmB2eF9gD1xN7b'; // 34 chars base58

function makeProviders(overrides = {}) {
  const pinStore = new Map();
  return {
    accountHistory: async () => ({
      firstSeenMs: 1_700_000_000_000 - 30 * 24 * 60 * 60 * 1000,
      txCount: 10
    }),
    accountState: async () => ({
      exists: true,
      codeHash: null
    }),
    codePin: {
      get: async (r) => pinStore.get(r) ?? null,
      set: async (r, h) => { pinStore.set(r, h); }
    },
    interactions: async () => ({
      count: 5,
      lastMs: 1_700_000_000_000 - 1000
    }),
    blocklist: {
      lookup: async () => null
    },
    ...overrides
  };
}

test('input validation: invalid receiver returns exact block verdict, score 100, and detail message', async () => {
  const providers = makeProviders();
  const res = await checkCounterparty({
    receiver: 'INVALID_UPPERCASE.near',
    providers
  });

  assert.equal(res.verdict, 'block');
  assert.equal(res.score, 100);
  assert.equal(res.reasons.length, 1);
  assert.deepEqual(res.reasons[0], {
    signal: 'input',
    level: 'block',
    detail: 'Invalid recipient: recipient must match [a-z0-9._-] (ASCII only)',
    source: 'input'
  });
});

test('signal 1 account_age: default 7-day boundary kills < vs <= mutant', async () => {
  const now = 1_700_000_000_000;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000; // 604800000 ms

  // Age is exactly 7 days: ageMs === minAgeMs -> NOT below threshold, info
  {
    const providers = makeProviders({
      accountHistory: async () => ({
        firstSeenMs: now - sevenDaysMs,
        txCount: 3
      })
    });
    const res = await checkCounterparty({ receiver: 'alice.near', providers, now });
    const reason = res.reasons.find((r) => r.signal === 'account_age');
    assert.equal(reason.level, 'info');
    assert.equal(reason.detail, 'Account age and transaction history meet policy');
    assert.equal(reason.source, 'history');
  }

  // Age is 7 days minus 1 ms: ageMs < minAgeMs -> warn with exact seconds
  {
    const providers = makeProviders({
      accountHistory: async () => ({
        firstSeenMs: now - (sevenDaysMs - 1000),
        txCount: 3
      })
    });
    const res = await checkCounterparty({ receiver: 'alice.near', providers, now });
    const reason = res.reasons.find((r) => r.signal === 'account_age');
    assert.equal(reason.level, 'warn');
    assert.equal(
      reason.detail,
      'Account age (604799s) is below required threshold (604800s)'
    );
    assert.equal(reason.source, 'history');
  }
});

test('signal 1 account_age: minTxCount boundary kills < vs <= mutant and nullish coalesce', async () => {
  const now = 1_700_000_000_000;
  const oldAge = now - 10 * 24 * 60 * 60 * 1000;

  // txCount === 3 (default minTxCount = 3) -> meets policy, info
  {
    const providers = makeProviders({
      accountHistory: async () => ({ firstSeenMs: oldAge, txCount: 3 })
    });
    const res = await checkCounterparty({ receiver: 'alice.near', providers, now });
    const reason = res.reasons.find((r) => r.signal === 'account_age');
    assert.equal(reason.level, 'info');
  }

  // txCount === 2 (below 3) -> warn with exact count and threshold
  {
    const providers = makeProviders({
      accountHistory: async () => ({ firstSeenMs: oldAge, txCount: 2 })
    });
    const res = await checkCounterparty({ receiver: 'alice.near', providers, now });
    const reason = res.reasons.find((r) => r.signal === 'account_age');
    assert.equal(reason.level, 'warn');
    assert.equal(
      reason.detail,
      'Transaction count (2) is below required threshold (3)'
    );
    assert.equal(reason.source, 'history');
  }

  // txCount missing (undefined) defaults to 0 -> warns with count 0
  {
    const providers = makeProviders({
      accountHistory: async () => ({ firstSeenMs: oldAge })
    });
    const res = await checkCounterparty({ receiver: 'alice.near', providers, now });
    const reason = res.reasons.find((r) => r.signal === 'account_age');
    assert.equal(reason.level, 'warn');
    assert.equal(
      reason.detail,
      'Transaction count (0) is below required threshold (3)'
    );
  }
});

test('signal 1 account_age: both age and txCount below threshold emit two distinct reasons', async () => {
  const now = 1_700_000_000_000;
  const providers = makeProviders({
    accountHistory: async () => ({
      firstSeenMs: now - 1000,
      txCount: 1
    })
  });

  const res = await checkCounterparty({ receiver: 'alice.near', providers, now });
  const ageReasons = res.reasons.filter((r) => r.signal === 'account_age');
  assert.equal(ageReasons.length, 2);
  assert.equal(
    ageReasons[0].detail,
    'Account age (1s) is below required threshold (604800s)'
  );
  assert.equal(
    ageReasons[1].detail,
    'Transaction count (1) is below required threshold (3)'
  );
  assert.equal(ageReasons[0].level, 'warn');
  assert.equal(ageReasons[1].level, 'warn');
});

test('signal 1 account_age: custom policy minAgeMs and minTxCount overrides default thresholds', async () => {
  const now = 1_700_000_000_000;
  const providers = makeProviders({
    accountHistory: async () => ({
      firstSeenMs: now - 5000,
      txCount: 10
    })
  });

  const res = await checkCounterparty({
    receiver: 'alice.near',
    providers,
    now,
    policy: { minAgeMs: 10000, minTxCount: 20 }
  });

  const ageReasons = res.reasons.filter((r) => r.signal === 'account_age');
  assert.equal(ageReasons.length, 2);
  assert.equal(
    ageReasons[0].detail,
    'Account age (5s) is below required threshold (10s)'
  );
  assert.equal(
    ageReasons[1].detail,
    'Transaction count (10) is below required threshold (20)'
  );
});

test('signal 1 account_age: history null or firstSeenMs null/undefined emits exact message', async () => {
  for (const hist of [null, undefined, { firstSeenMs: null }, { firstSeenMs: undefined }]) {
    const providers = makeProviders({ accountHistory: async () => hist });
    const res = await checkCounterparty({ receiver: 'alice.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'account_age');
    assert.deepEqual(reason, {
      signal: 'account_age',
      level: 'warn',
      detail: 'Account has never been seen before',
      source: 'history'
    });
  }
});

test('signal 1 account_age: provider throw emits exact unavailable detail', async () => {
  const providers = makeProviders({
    accountHistory: async () => { throw new Error('indexer timeout'); }
  });
  const res = await checkCounterparty({ receiver: 'alice.near', providers });
  const reason = res.reasons.find((r) => r.signal === 'account_age');
  assert.deepEqual(reason, {
    signal: 'account_age',
    level: 'warn',
    detail: 'Account history provider unavailable: indexer timeout',
    source: 'unavailable'
  });
});

test('signal 2 contract_code: empty code hash (32 ones) recognized as non-contract info', async () => {
  const EMPTY_32_ONES = '11111111111111111111111111111111';
  for (const codeHash of [null, '', EMPTY_32_ONES]) {
    const providers = makeProviders({
      accountState: async () => ({ exists: true, codeHash })
    });
    const res = await checkCounterparty({ receiver: 'alice.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'contract_code');
    assert.deepEqual(reason, {
      signal: 'contract_code',
      level: 'info',
      detail: 'Account is not a contract (no code hash)',
      source: 'state'
    });
  }
});

test('signal 2 contract_code: account nonexistent emits exact warn reason', async () => {
  for (const state of [null, undefined, { exists: false }]) {
    const providers = makeProviders({ accountState: async () => state });
    const res = await checkCounterparty({ receiver: 'ghost.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'contract_code');
    assert.deepEqual(reason, {
      signal: 'contract_code',
      level: 'warn',
      detail: 'Account does not exist on-chain',
      source: 'state'
    });
  }
});

test('signal 2 contract_code: codePin.get throwing falls back to unpinned flow and pins', async () => {
  let pinned = null;
  const providers = makeProviders({
    accountState: async () => ({ exists: true, codeHash: 'hash-abc' }),
    codePin: {
      get: async () => { throw new Error('disk read error'); },
      set: async (r, h) => { pinned = h; }
    }
  });

  const res = await checkCounterparty({ receiver: 'contract.near', providers });
  const reason = res.reasons.find((r) => r.signal === 'contract_code');
  assert.deepEqual(reason, {
    signal: 'contract_code',
    level: 'warn',
    detail: 'New contract seen for the first time',
    source: 'state'
  });
  assert.equal(pinned, 'hash-abc');
});

test('signal 2 contract_code: state provider throw emits exact unavailable reason', async () => {
  const providers = makeProviders({
    accountState: async () => { throw new Error('rpc unreachable'); }
  });
  const res = await checkCounterparty({ receiver: 'alice.near', providers });
  const reason = res.reasons.find((r) => r.signal === 'contract_code');
  assert.deepEqual(reason, {
    signal: 'contract_code',
    level: 'warn',
    detail: 'Account state provider unavailable: rpc unreachable',
    source: 'unavailable'
  });
});

test('signal 3 prior_interaction: count boundary kills <= 0 vs < 0 mutant', async () => {
  // count === 0 -> warn
  {
    const providers = makeProviders({
      interactions: async () => ({ count: 0 })
    });
    const res = await checkCounterparty({ receiver: 'alice.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'prior_interaction');
    assert.deepEqual(reason, {
      signal: 'prior_interaction',
      level: 'warn',
      detail: 'New receiver for this agent',
      source: 'interactions'
    });
  }

  // count === -1 -> warn
  {
    const providers = makeProviders({
      interactions: async () => ({ count: -1 })
    });
    const res = await checkCounterparty({ receiver: 'alice.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'prior_interaction');
    assert.equal(reason.level, 'warn');
  }

  // count === 1 -> info with exact detail message
  {
    const providers = makeProviders({
      interactions: async () => ({ count: 1 })
    });
    const res = await checkCounterparty({ receiver: 'alice.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'prior_interaction');
    assert.deepEqual(reason, {
      signal: 'prior_interaction',
      level: 'info',
      detail: 'Prior interactions with receiver: 1',
      source: 'interactions'
    });
  }

  // interaction provider throw
  {
    const providers = makeProviders({
      interactions: async () => { throw new Error('corrupt db'); }
    });
    const res = await checkCounterparty({ receiver: 'alice.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'prior_interaction');
    assert.deepEqual(reason, {
      signal: 'prior_interaction',
      level: 'warn',
      detail: 'Prior interactions provider unavailable: corrupt db',
      source: 'unavailable'
    });
  }
});

test('signal 4 blocklist: evidence validation boundary kills length and protocol mutants', async () => {
  // 1. txHash length boundary: 31 chars fails, 32 chars passes, 44 chars passes, 45 chars fails
  const base58Char = '1';
  const hash31 = base58Char.repeat(31);
  const hash32 = base58Char.repeat(32);
  const hash44 = base58Char.repeat(44);
  const hash45 = base58Char.repeat(45);

  for (const [hash, shouldBlock] of [
    [hash31, false],
    [hash32, true],
    [hash44, true],
    [hash45, false]
  ]) {
    const providers = makeProviders({
      blocklist: { lookup: async () => ({ evidence: { txHash: hash }, reportedBy: 'bot' }) }
    });
    const res = await checkCounterparty({ receiver: 'target.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'blocklist');
    assert.equal(reason.level, shouldBlock ? 'block' : 'warn');
  }

  // 2. URL length boundary: 300 chars passes, 301 chars fails
  const prefix = 'https://example.com/';
  const url300 = prefix + 'a'.repeat(300 - prefix.length);
  assert.equal(url300.length, 300);
  const url301 = url300 + 'a';
  assert.equal(url301.length, 301);

  for (const [url, shouldBlock] of [
    [url300, true],
    [url301, false],
    ['http://example.com', true],
    ['https://example.com', true],
    ['ftp://example.com', false]
  ]) {
    const providers = makeProviders({
      blocklist: { lookup: async () => ({ evidence: { url }, reportedBy: 'bot' }) }
    });
    const res = await checkCounterparty({ receiver: 'target.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'blocklist');
    assert.equal(reason.level, shouldBlock ? 'block' : 'warn');
  }
});

test('signal 4 blocklist: reportedBy fallback to unknown when missing', async () => {
  for (const rep of ['', null, undefined]) {
    const providers = makeProviders({
      blocklist: {
        lookup: async () => ({
          evidence: { txHash: VALID_TX_HASH },
          reportedBy: rep
        })
      }
    });
    const res = await checkCounterparty({ receiver: 'target.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'blocklist');
    assert.deepEqual(reason, {
      signal: 'blocklist',
      level: 'block',
      detail: 'Receiver is on blocklist (reported by unknown)',
      source: 'blocklist'
    });
  }
});

test('signal 4 blocklist: provider throw emits exact unavailable reason', async () => {
  const providers = makeProviders({
    blocklist: { lookup: async () => { throw new Error('dns fail'); } }
  });
  const res = await checkCounterparty({ receiver: 'target.near', providers });
  const reason = res.reasons.find((r) => r.signal === 'blocklist');
  assert.deepEqual(reason, {
    signal: 'blocklist',
    level: 'warn',
    detail: 'Blocklist provider unavailable: dns fail',
    source: 'unavailable'
  });
});

test('scoring weights and score capping: exact 20 per warn, 100 per block, clamped 0..100', async () => {
  // Test each count of warns: 1 warn = 20, 2 warns = 40, 3 warns = 60, 4 warns = 80
  const allWarnProviders = makeProviders({
    accountHistory: async () => ({ firstSeenMs: null }), // warn (+20)
    accountState: async () => ({ exists: false }), // warn (+20)
    interactions: async () => ({ count: 0 }), // warn (+20)
    blocklist: { lookup: async () => ({ evidence: { note: 'no tx' } }) } // warn (+20)
  });

  const res4Warns = await checkCounterparty({ receiver: 'alice.near', providers: allWarnProviders });
  assert.equal(res4Warns.verdict, 'warn');
  assert.equal(res4Warns.score, 80);

  // 5 warns (both age and txCount warn, plus 3 other warns) -> 5 * 20 = 100
  const now = 1_700_000_000_000;
  const fiveWarnProviders = makeProviders({
    accountHistory: async () => ({ firstSeenMs: now - 1000, txCount: 1 }), // 2 warns (+40)
    accountState: async () => ({ exists: false }), // warn (+20)
    interactions: async () => ({ count: 0 }), // warn (+20)
    blocklist: { lookup: async () => ({ evidence: { note: 'no tx' } }) } // warn (+20)
  });
  const res5Warns = await checkCounterparty({ receiver: 'alice.near', providers: fiveWarnProviders, now });
  assert.equal(res5Warns.verdict, 'warn');
  assert.equal(res5Warns.score, 100);

  // Block plus warns clamps at 100
  const blockAndWarnProviders = makeProviders({
    accountHistory: async () => ({ firstSeenMs: null }), // warn (+20)
    blocklist: { lookup: async () => ({ evidence: { txHash: VALID_TX_HASH } }) } // block (+100)
  });
  const resBlock = await checkCounterparty({ receiver: 'alice.near', providers: blockAndWarnProviders });
  assert.equal(resBlock.verdict, 'block');
  assert.equal(resBlock.score, 100);
});

test('signal 2 contract_code: codePin.set error does not override warn verdict', async () => {
  const providers = makeProviders({
    accountState: async () => ({ exists: true, codeHash: 'new-hash-xyz' }),
    codePin: {
      get: async () => null,
      set: async () => { throw new Error('write permission denied'); }
    }
  });

  const res = await checkCounterparty({ receiver: 'alice.near', providers });
  assert.equal(res.verdict, 'warn');
  const codeReason = res.reasons.find((r) => r.signal === 'contract_code');
  assert.equal(codeReason.detail, 'New contract seen for the first time');
});

test('signal 4 blocklist: base58 forbidden chars (0, O, I, l) are rejected as evidence', async () => {
  for (const badChar of ['0', 'O', 'I', 'l']) {
    const invalidHash = badChar.repeat(34);
    const providers = makeProviders({
      blocklist: {
        lookup: async () => ({
          evidence: { txHash: invalidHash },
          reportedBy: 'auditor'
        })
      }
    });
    const res = await checkCounterparty({ receiver: 'target.near', providers });
    const reason = res.reasons.find((r) => r.signal === 'blocklist');
    assert.equal(reason.level, 'warn');
    assert.equal(reason.detail, 'Blocklist entry ignored: report without evidence');
  }
});

test('property: scoring formula min(100, blocks*100 + warns*20) and verdict mapping over 100 cases', async () => {
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

  const rnd = lcg(0xc0ffee);
  for (let i = 0; i < 100; i++) {
    const ageWarn = rnd() < 0.5;
    const codeWarn = rnd() < 0.5;
    const interWarn = rnd() < 0.5;
    const blockDecision = rnd() < 0.33 ? 'block' : (rnd() < 0.5 ? 'warn' : 'info');

    const providers = makeProviders({
      accountHistory: async () => (ageWarn ? { firstSeenMs: null } : { firstSeenMs: 1_700_000_000_000 - 30 * 86400000, txCount: 10 }),
      accountState: async () => (codeWarn ? { exists: false } : { exists: true, codeHash: null }),
      interactions: async () => (interWarn ? { count: 0 } : { count: 5 }),
      blocklist: {
        lookup: async () => {
          if (blockDecision === 'block') return { evidence: { txHash: VALID_TX_HASH }, reportedBy: 'reporter' };
          if (blockDecision === 'warn') return { evidence: { note: 'rumor' }, reportedBy: 'reporter' };
          return null;
        }
      }
    });

    const res = await checkCounterparty({ receiver: `user-${i}.near`, providers, now: 1_700_000_000_000 });
    const blocks = res.reasons.filter((r) => r.level === 'block').length;
    const warns = res.reasons.filter((r) => r.level === 'warn').length;

    const expectedScore = Math.min(100, Math.max(0, blocks * 100 + warns * 20));
    assert.equal(res.score, expectedScore, `case ${i}: score mismatch`);

    if (blocks > 0) {
      assert.equal(res.verdict, 'block', `case ${i}: should be block`);
    } else if (warns > 0) {
      assert.equal(res.verdict, 'warn', `case ${i}: should be warn`);
    } else {
      assert.equal(res.verdict, 'allow', `case ${i}: should be allow`);
    }

    assert.ok(res.score >= 0 && res.score <= 100, `case ${i}: score out of bounds`);
  }
});
