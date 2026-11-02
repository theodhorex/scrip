import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  checkCounterparty,
  createDefaultProviders
} from '../src/counterparty.mjs';

// 34 characters, base58 alphabet only (no 0, O, I, l).
const VALID_TX_HASH = '4uQpvRwYhS3nT6kLzA8cJmB2eF9gD1xN7b';

function baseValidProviders(overrides = {}, now = Date.now()) {
  const pinStore = new Map();
  return {
    accountHistory: async (receiver) => ({
      firstSeenMs: now - 30 * 24 * 60 * 60 * 1000,
      txCount: 10
    }),
    accountState: async (receiver) => ({
      exists: true,
      codeHash: null
    }),
    codePin: {
      get: async (receiver) => pinStore.get(receiver) ?? null,
      set: async (receiver, hash) => { pinStore.set(receiver, hash); }
    },
    interactions: async (agentId, receiver) => ({
      count: 5,
      lastMs: now - 1000
    }),
    blocklist: {
      lookup: async (receiver) => null
    },
    ...overrides
  };
}

test('input validation: invalid receiver returns block verdict with input reason', async () => {
  const providers = baseValidProviders();
  const invalidReceivers = [
    '',
    'INVALID_UPPERCASE.near',
    'has space.near',
    'invalid/slash',
    'a'.repeat(65)
  ];

  for (const receiver of invalidReceivers) {
    const res = await checkCounterparty({
      receiver,
      agentId: 'agent.near',
      providers
    });
    assert.equal(res.verdict, 'block');
    assert.equal(res.score, 100);
    assert.equal(res.reasons.length, 1);
    assert.equal(res.reasons[0].signal, 'input');
    assert.equal(res.reasons[0].level, 'block');
    assert.equal(res.reasons[0].source, 'input');
  }
});

test('clean counterparty produces allow verdict and score 0', async () => {
  const now = 1_700_000_000_000;
  const providers = baseValidProviders({}, now);
  const res = await checkCounterparty({
    receiver: 'alice.near',
    agentId: 'agent.near',
    providers,
    now
  });

  assert.equal(res.verdict, 'allow');
  assert.equal(res.score, 0);
  assert.ok(res.reasons.length >= 4);
  for (const r of res.reasons) {
    assert.equal(r.level, 'info');
  }
});

test('signal 1: account_age warn on new account, young age, or low txCount', async () => {
  const now = 1_700_000_000_000;
  const sevenDaysMs = 7 * 24 * 60 * 60 * 1000;

  // Case A: never seen before (firstSeenMs is null)
  {
    const providers = baseValidProviders({
      accountHistory: async () => ({ firstSeenMs: null, txCount: 0 })
    });
    const res = await checkCounterparty({ receiver: 'bob.near', agentId: 'agent.near', providers, now });
    assert.equal(res.verdict, 'warn');
    const ageReasons = res.reasons.filter(r => r.signal === 'account_age');
    assert.ok(ageReasons.some(r => r.level === 'warn'));
  }

  // Case B: age < 7 days
  {
    const providers = baseValidProviders({
      accountHistory: async () => ({ firstSeenMs: now - (sevenDaysMs - 1000), txCount: 10 })
    });
    const res = await checkCounterparty({ receiver: 'bob.near', agentId: 'agent.near', providers, now });
    assert.equal(res.verdict, 'warn');
    const ageReasons = res.reasons.filter(r => r.signal === 'account_age');
    assert.ok(ageReasons.some(r => r.level === 'warn'));
  }

  // Case C: txCount < minTxCount (default 3)
  {
    const providers = baseValidProviders({
      accountHistory: async () => ({ firstSeenMs: now - (sevenDaysMs + 1000), txCount: 2 })
    });
    const res = await checkCounterparty({ receiver: 'bob.near', agentId: 'agent.near', providers, now });
    assert.equal(res.verdict, 'warn');
    const ageReasons = res.reasons.filter(r => r.signal === 'account_age');
    assert.ok(ageReasons.some(r => r.level === 'warn'));
  }
});

test('signal 2: contract_code checks and pin persistence', async () => {
  const now = 1_700_000_000_000;
  let pinned = null;
  const pinStore = {
    get: async () => pinned,
    set: async (rcv, hash) => { pinned = hash; }
  };

  // Case A: account does not exist -> warn
  {
    const providers = baseValidProviders({
      accountState: async () => ({ exists: false, codeHash: null }),
      codePin: pinStore
    });
    const res = await checkCounterparty({ receiver: 'ghost.near', agentId: 'agent.near', providers, now });
    assert.equal(res.verdict, 'warn');
    const codeReason = res.reasons.find(r => r.signal === 'contract_code');
    assert.equal(codeReason?.level, 'warn');
  }

  // Case B: first-time contract seen -> warn ringan & pin recorded when verdict is not block
  {
    const providers = baseValidProviders({
      accountState: async () => ({ exists: true, codeHash: 'hash-v1' }),
      codePin: pinStore
    });
    const res = await checkCounterparty({ receiver: 'contract.near', agentId: 'agent.near', providers, now });
    assert.equal(res.verdict, 'warn');
    const codeReason = res.reasons.find(r => r.signal === 'contract_code');
    assert.equal(codeReason?.level, 'warn');
    assert.equal(pinned, 'hash-v1');
  }

  // Case C: contract code matches pin -> info
  {
    const providers = baseValidProviders({
      accountState: async () => ({ exists: true, codeHash: 'hash-v1' }),
      codePin: pinStore
    });
    const res = await checkCounterparty({ receiver: 'contract.near', agentId: 'agent.near', providers, now });
    const codeReason = res.reasons.find(r => r.signal === 'contract_code');
    assert.equal(codeReason?.level, 'info');
  }

  // Case D: contract code changed -> warn
  {
    const providers = baseValidProviders({
      accountState: async () => ({ exists: true, codeHash: 'hash-v2' }),
      codePin: pinStore
    });
    const res = await checkCounterparty({ receiver: 'contract.near', agentId: 'agent.near', providers, now });
    assert.equal(res.verdict, 'warn');
    const codeReason = res.reasons.find(r => r.signal === 'contract_code');
    assert.equal(codeReason?.level, 'warn');
    assert.match(codeReason?.detail ?? '', /kode berubah|changed/i);
  }

  // Case E: new contract seen, but overall verdict is BLOCK (e.g. on blocklist) -> pin NOT recorded
  {
    let pinAttempted = false;
    const testPin = {
      get: async () => null,
      set: async () => { pinAttempted = true; }
    };
    const providers = baseValidProviders({
      accountState: async () => ({ exists: true, codeHash: 'malicious-v1' }),
      codePin: testPin,
      blocklist: {
        lookup: async () => ({
          evidence: { txHash: VALID_TX_HASH, note: 'Malicious drainer' },
          reportedBy: 'security-team',
          ts: now
        })
      }
    });
    const res = await checkCounterparty({ receiver: 'drainer.near', agentId: 'agent.near', providers, now });
    assert.equal(res.verdict, 'block');
    assert.equal(pinAttempted, false, 'pin must not be recorded when verdict is block');
  }
});

test('signal 3: prior_interaction warns on 0 interactions and infos on >= 1', async () => {
  // 0 interactions -> warn
  {
    const providers = baseValidProviders({
      interactions: async () => ({ count: 0, lastMs: null })
    });
    const res = await checkCounterparty({ receiver: 'stranger.near', agentId: 'agent.near', providers });
    const reason = res.reasons.find(r => r.signal === 'prior_interaction');
    assert.equal(reason?.level, 'warn');
  }

  // >= 1 interactions -> info
  {
    const providers = baseValidProviders({
      interactions: async () => ({ count: 2, lastMs: Date.now() - 5000 })
    });
    const res = await checkCounterparty({ receiver: 'friend.near', agentId: 'agent.near', providers });
    const reason = res.reasons.find(r => r.signal === 'prior_interaction');
    assert.equal(reason?.level, 'info');
  }
});

test('signal 4: blocklist blocks on evidence and warns on unevidenced reports', async () => {
  const now = 1_700_000_000_000;

  // With evidence -> block
  {
    const providers = baseValidProviders({
      blocklist: {
        lookup: async () => ({
          evidence: { txHash: VALID_TX_HASH, url: 'https://security.example.com', note: 'Drainer contract' },
          reportedBy: 'auditor',
          ts: now
        })
      }
    });
    const res = await checkCounterparty({ receiver: 'badactor.near', agentId: 'agent.near', providers, now });
    assert.equal(res.verdict, 'block');
    assert.equal(res.score, 100);
    const reason = res.reasons.find(r => r.signal === 'blocklist');
    assert.equal(reason?.level, 'block');
  }

  // Without evidence (empty object, null, or whitespace only) -> warn (ignored as block)
  {
    const emptyEvidences = [
      null,
      {},
      { note: '   ' },
      { txHash: '', url: '', note: '' }
    ];

    for (const evidence of emptyEvidences) {
      const providers = baseValidProviders({
        blocklist: {
          lookup: async () => ({
            evidence,
            reportedBy: 'griefer',
            ts: now
          })
        }
      });
      const res = await checkCounterparty({ receiver: 'target.near', agentId: 'agent.near', providers, now });
      assert.notEqual(res.verdict, 'block');
      assert.equal(res.verdict, 'warn');
      const reason = res.reasons.find(r => r.signal === 'blocklist');
      assert.equal(reason?.level, 'warn');
      assert.match(reason?.detail ?? '', /tanpa bukti|without evidence/i);
    }
  }
});

function blocklistProvidersWith(evidence, now) {
  return baseValidProviders({
    blocklist: {
      lookup: async () => ({ evidence, reportedBy: 'reporter', ts: now })
    }
  });
}

async function assertIgnoredWithoutEvidence(evidence, now) {
  const providers = blocklistProvidersWith(evidence, now);
  const res = await checkCounterparty({ receiver: 'target.near', agentId: 'agent.near', providers, now });
  assert.notEqual(res.verdict, 'block');
  assert.equal(res.verdict, 'warn');
  const reason = res.reasons.find(r => r.signal === 'blocklist');
  assert.equal(reason?.level, 'warn');
  assert.match(reason?.detail ?? '', /tanpa bukti|without evidence/i);
}

test('signal 4: note-only evidence is ignored as unverifiable', async () => {
  const now = 1_700_000_000_000;
  await assertIgnoredWithoutEvidence(
    { note: 'Everyone says this account is a scammer' },
    now
  );
});

test('signal 4: a valid base58 txHash blocks the receiver', async () => {
  const now = 1_700_000_000_000;
  const providers = blocklistProvidersWith({ txHash: VALID_TX_HASH, note: 'Drainer' }, now);
  const res = await checkCounterparty({ receiver: 'badactor.near', agentId: 'agent.near', providers, now });
  assert.equal(res.verdict, 'block');
  const reason = res.reasons.find(r => r.signal === 'blocklist');
  assert.equal(reason?.level, 'block');
});

test('signal 4: a valid https url blocks the receiver without a txHash', async () => {
  const now = 1_700_000_000_000;
  const providers = blocklistProvidersWith({ url: 'https://security.example.com/reports/drainer' }, now);
  const res = await checkCounterparty({ receiver: 'badactor.near', agentId: 'agent.near', providers, now });
  assert.equal(res.verdict, 'block');
  const reason = res.reasons.find(r => r.signal === 'blocklist');
  assert.equal(reason?.level, 'block');
});

test('signal 4: invalid urls (bad scheme, empty, oversized) are rejected as evidence', async () => {
  const now = 1_700_000_000_000;
  const badUrls = [
    'javascript:alert(1)',
    'ftp://example.com/report',
    '',
    '   ',
    `https://example.com/${'a'.repeat(300)}`
  ];
  for (const url of badUrls) {
    await assertIgnoredWithoutEvidence({ url, note: 'see link' }, now);
  }
});

test('signal 4: malformed txHash (too short or non-base58) is rejected as evidence', async () => {
  const now = 1_700_000_000_000;
  const badTxHashes = [
    'abc123',
    VALID_TX_HASH.slice(0, 31),
    '0'.repeat(34),
    'O'.repeat(34),
    `${VALID_TX_HASH}Invalid`,
    '4uQpvRwYhS3nT6kLzA8cJmB2eF9gD1xN7!'
  ];
  for (const txHash of badTxHashes) {
    await assertIgnoredWithoutEvidence({ txHash, note: 'trust me' }, now);
  }
});

test('fail-closed: provider throw or timeout returns warn with source unavailable', async () => {
  // Provider throws
  {
    const providers = baseValidProviders({
      accountHistory: async () => { throw new Error('indexer down'); },
      accountState: async () => { throw new Error('rpc 503'); },
      interactions: async () => { throw new Error('disk read error'); },
      blocklist: { lookup: async () => { throw new Error('blocklist db error'); } }
    });

    const res = await checkCounterparty({ receiver: 'alice.near', agentId: 'agent.near', providers });
    assert.equal(res.verdict, 'warn');
    for (const r of res.reasons) {
      assert.equal(r.level, 'warn');
      assert.equal(r.source, 'unavailable');
    }
  }

  // Provider hangs / times out
  {
    const hangingPromise = () => new Promise((resolve) => {
      const t = setTimeout(resolve, 5000);
      t.unref?.();
    });
    const providers = baseValidProviders({
      accountState: hangingPromise
    });

    const res = await checkCounterparty({
      receiver: 'alice.near',
      agentId: 'agent.near',
      providers,
      policy: { timeoutMs: 30 }
    });
    assert.equal(res.verdict, 'warn');
    const stateReason = res.reasons.find(r => r.signal === 'contract_code');
    assert.equal(stateReason?.level, 'warn');
    assert.equal(stateReason?.source, 'unavailable');
  }
});

test('aggregation, score, and deterministic reason order', async () => {
  const providers = baseValidProviders({
    accountHistory: async () => ({ firstSeenMs: null, txCount: 0 }), // warn (20)
    interactions: async () => ({ count: 0, lastMs: null }) // warn (20)
  });

  const res1 = await checkCounterparty({ receiver: 'alice.near', agentId: 'agent.near', providers });
  const res2 = await checkCounterparty({ receiver: 'alice.near', agentId: 'agent.near', providers });

  assert.equal(res1.verdict, 'warn');
  assert.equal(res1.score, 40);
  assert.deepEqual(
    res1.reasons.map(r => r.signal),
    res2.reasons.map(r => r.signal)
  );

  const order = res1.reasons.map(r => r.signal);
  const expectedOrder = ['account_age', 'contract_code', 'prior_interaction', 'blocklist'];
  assert.deepEqual(order, expectedOrder);
});

test('property-based: verdict is block iff at least one reason is block', async () => {
  // Pseudo-random generation of provider behaviors
  const levels = ['info', 'warn', 'block'];
  for (let seed = 0; seed < 50; seed++) {
    const hasBlock = seed % 3 === 0;
    const providers = baseValidProviders({
      blocklist: {
        lookup: async () => (hasBlock ? {
          evidence: { txHash: VALID_TX_HASH },
          reportedBy: 'tester',
          ts: Date.now()
        } : null)
      },
      interactions: async () => ({ count: (seed % 2), lastMs: Date.now() })
    });

    const res = await checkCounterparty({
      receiver: `user-${seed}.near`,
      agentId: 'agent.near',
      providers
    });

    const blockReasons = res.reasons.filter(r => r.level === 'block');
    if (blockReasons.length > 0) {
      assert.equal(res.verdict, 'block');
      assert.equal(res.score, 100);
    } else {
      assert.notEqual(res.verdict, 'block');
    }
  }
});

test('createDefaultProviders: handles indexerUrl, atomic codePin, blocklist, interactions', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'c3-test-'));
  try {
    const codePinPath = path.join(tmpDir, 'codepin.json');
    const blocklistPath = path.join(tmpDir, 'blocklist.json');
    const interactionLog = path.join(tmpDir, 'interactions.json');

    await fs.writeFile(blocklistPath, JSON.stringify({
      'scammer.near': {
        evidence: { txHash: VALID_TX_HASH, note: 'Phishing' },
        reportedBy: 'community',
        ts: Date.now()
      }
    }));

    await fs.writeFile(interactionLog, JSON.stringify([
      { agentId: 'agent.near', receiver: 'oldpal.near', ts: 1000 },
      { agentId: 'agent.near', receiver: 'oldpal.near', ts: 2000 }
    ]));

    const providers = createDefaultProviders({
      blocklistPath,
      interactionLog,
      codePinPath
    });

    // Without indexerUrl -> accountHistory returns null
    const history = await providers.accountHistory('alice.near');
    assert.equal(history, null);

    // blocklist lookup
    const scammer = await providers.blocklist.lookup('scammer.near');
    assert.ok(scammer);
    assert.equal(scammer.evidence.note, 'Phishing');

    const clean = await providers.blocklist.lookup('clean.near');
    assert.equal(clean, null);

    // interactions lookup
    const pals = await providers.interactions('agent.near', 'oldpal.near');
    assert.equal(pals.count, 2);
    const unknown = await providers.interactions('agent.near', 'stranger.near');
    assert.equal(unknown.count, 0);

    // atomic codePin get/set
    const pinBefore = await providers.codePin.get('contract.near');
    assert.equal(pinBefore, null);

    await providers.codePin.set('contract.near', 'hash-123');
    const pinAfter = await providers.codePin.get('contract.near');
    assert.equal(pinAfter, 'hash-123');

    // verify file exists and is valid JSON
    const content = JSON.parse(await fs.readFile(codePinPath, 'utf8'));
    assert.equal(content['contract.near'], 'hash-123');
  } finally {
    await fs.rm(tmpDir, { recursive: true, force: true });
  }
});
