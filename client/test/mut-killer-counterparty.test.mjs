// @ts-nocheck
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import path from 'node:path';
import os from 'node:os';

import {
  checkCounterparty,
  createDefaultProviders
} from '../src/counterparty.mjs';

test('mut-killer: contract_code changed vs matched exact details', async () => {
  const pinStore = new Map([
    ['changed.near', 'old_hash_123'],
    ['matched.near', 'same_hash_456']
  ]);

  const providers = {
    accountHistory: async () => ({ firstSeenMs: 1_700_000_000_000 - 10 * 86400000, txCount: 10 }),
    accountState: async (receiver) => {
      if (receiver === 'changed.near') return { exists: true, codeHash: 'new_hash_999' };
      if (receiver === 'matched.near') return { exists: true, codeHash: 'same_hash_456' };
      return { exists: false, codeHash: null };
    },
    codePin: {
      get: async (r) => pinStore.get(r) ?? null,
      set: async (r, h) => { pinStore.set(r, h); }
    },
    interactions: async () => ({ count: 5 }),
    blocklist: { lookup: async () => null }
  };

  // 1. Changed code triggers warn and exact detail string
  const resChanged = await checkCounterparty({
    receiver: 'changed.near',
    providers,
    now: 1_700_000_000_000
  });
  const changedReason = resChanged.reasons.find((r) => r.signal === 'contract_code');
  assert.equal(changedReason.level, 'warn');
  assert.equal(changedReason.detail, 'Contract code changed since last seen (kode berubah sejak terakhir dilihat)');
  assert.equal(changedReason.source, 'state');

  // 2. Matched code triggers info and exact detail string
  const resMatched = await checkCounterparty({
    receiver: 'matched.near',
    providers,
    now: 1_700_000_000_000
  });
  const matchedReason = resMatched.reasons.find((r) => r.signal === 'contract_code');
  assert.equal(matchedReason.level, 'info');
  assert.equal(matchedReason.detail, 'Contract code matches pinned hash');
  assert.equal(matchedReason.source, 'state');
});

test('mut-killer: account_age info vs warn and exact meet policy message', async () => {
  const now = 1_700_000_000_000;
  const minAgeMs = 7 * 86400000;

  // Case A: Age ok (10d), but txCount low (1 < 3) -> warn only, NO info
  const resTxLow = await checkCounterparty({
    receiver: 'bob.near',
    providers: {
      accountHistory: async () => ({ firstSeenMs: now - 10 * 86400000, txCount: 1 }),
      accountState: async () => ({ exists: false, codeHash: null }),
      interactions: async () => ({ count: 1 }),
      blocklist: { lookup: async () => null }
    },
    now
  });
  const reasonsTxLow = resTxLow.reasons.filter((r) => r.signal === 'account_age');
  assert.equal(reasonsTxLow.length, 1);
  assert.equal(reasonsTxLow[0].level, 'warn');
  assert.ok(reasonsTxLow[0].detail.includes('Transaction count (1) is below required threshold (3)'));

  // Case B: Age young (2d < 7d), but txCount ok (10 >= 3) -> warn only, NO info
  const resAgeLow = await checkCounterparty({
    receiver: 'charlie.near',
    providers: {
      accountHistory: async () => ({ firstSeenMs: now - 2 * 86400000, txCount: 10 }),
      accountState: async () => ({ exists: false, codeHash: null }),
      interactions: async () => ({ count: 1 }),
      blocklist: { lookup: async () => null }
    },
    now
  });
  const reasonsAgeLow = resAgeLow.reasons.filter((r) => r.signal === 'account_age');
  assert.equal(reasonsAgeLow.length, 1);
  assert.equal(reasonsAgeLow[0].level, 'warn');
  assert.ok(reasonsAgeLow[0].detail.includes('Account age'));

  // Case C: Both ok (10d, 10 tx) -> exactly one info reason with exact message
  const resAllOk = await checkCounterparty({
    receiver: 'dave.near',
    providers: {
      accountHistory: async () => ({ firstSeenMs: now - 10 * 86400000, txCount: 10 }),
      accountState: async () => ({ exists: false, codeHash: null }),
      interactions: async () => ({ count: 1 }),
      blocklist: { lookup: async () => null }
    },
    now
  });
  const reasonsAllOk = resAllOk.reasons.filter((r) => r.signal === 'account_age');
  assert.equal(reasonsAllOk.length, 1);
  assert.equal(reasonsAllOk[0].level, 'info');
  assert.equal(reasonsAllOk[0].detail, 'Account age and transaction history meet policy');
});

test('mut-killer: evidence validation trimming and URL error handling', async () => {
  const baseValidTx = '3vPBG5nB5q3yWk8k3Xg5z7k9m2p4r6t8v1x3y5z7a9b';

  // 1. txHash with whitespace is trimmed and accepted as evidence (kills value.trim mutant)
  const resTrimTx = await checkCounterparty({
    receiver: 'victim1.near',
    providers: {
      accountHistory: async () => ({ firstSeenMs: 1_700_000_000_000 - 10 * 86400000, txCount: 10 }),
      accountState: async () => ({ exists: false, codeHash: null }),
      interactions: async () => ({ count: 1 }),
      blocklist: {
        lookup: async () => ({
          reportedBy: 'security-team',
          evidence: { txHash: `  ${baseValidTx}  ` }
        })
      }
    },
    now: 1_700_000_000_000
  });
  assert.equal(resTrimTx.verdict, 'block');
  assert.ok(resTrimTx.reasons.some((r) => r.signal === 'blocklist' && r.level === 'block'));

  // 2. URL with whitespace is trimmed and accepted as evidence (kills value.trim mutant)
  const resTrimUrl = await checkCounterparty({
    receiver: 'victim2.near',
    providers: {
      accountHistory: async () => ({ firstSeenMs: 1_700_000_000_000 - 10 * 86400000, txCount: 10 }),
      accountState: async () => ({ exists: false, codeHash: null }),
      interactions: async () => ({ count: 1 }),
      blocklist: {
        lookup: async () => ({
          reportedBy: 'security-team',
          evidence: { url: '  https://explorer.near.org/tx/123  ' }
        })
      }
    },
    now: 1_700_000_000_000
  });
  assert.equal(resTrimUrl.verdict, 'block');
  assert.ok(resTrimUrl.reasons.some((r) => r.signal === 'blocklist' && r.level === 'block'));

  // 3. Evidence url that causes URL constructor to throw must be caught and treated as invalid evidence
  const resBadUrl = await checkCounterparty({
    receiver: 'victim3.near',
    providers: {
      accountHistory: async () => ({ firstSeenMs: 1_700_000_000_000 - 10 * 86400000, txCount: 10 }),
      accountState: async () => ({ exists: false, codeHash: null }),
      interactions: async () => ({ count: 1 }),
      blocklist: {
        lookup: async () => ({
          reportedBy: 'anon',
          evidence: { url: 'http://' } // malformed url throws in new URL()
        })
      }
    },
    now: 1_700_000_000_000
  });
  // Unverified evidence emits warn, not block
  assert.equal(resBadUrl.verdict, 'warn');
  const blReason = resBadUrl.reasons.find((r) => r.signal === 'blocklist');
  assert.equal(blReason.level, 'warn');
  assert.equal(blReason.detail, 'Blocklist entry ignored: report without evidence');
});

test('mut-killer: default providers accountState RPC behavior', async () => {
  const originalFetch = globalThis.fetch;

  // 1. No rpcUrl returns exists: false, codeHash: null
  const noRpcProviders = createDefaultProviders();
  const st0 = await noRpcProviders.accountState('alice.near');
  assert.deepEqual(st0, { exists: false, codeHash: null });

  // 2. HTTP failure throws
  globalThis.fetch = async () => ({
    ok: false,
    status: 503
  });
  const rpcProviders = createDefaultProviders({ rpcUrl: 'https://rpc.mainnet.near.org' });
  await assert.rejects(
    async () => rpcProviders.accountState('alice.near'),
    /RPC returned HTTP status 503/
  );

  // 3. RPC returned error (e.g. UNKNOWN_ACCOUNT) returns exists: false
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      error: { cause: { name: 'UNKNOWN_ACCOUNT' } }
    })
  });
  const stError = await rpcProviders.accountState('missing.near');
  assert.deepEqual(stError, { exists: false, codeHash: null });

  // 4. Empty code hash (32 ones) returns exists: true, codeHash: null
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      result: { code_hash: '11111111111111111111111111111111' }
    })
  });
  const stEmpty = await rpcProviders.accountState('eoa.near');
  assert.deepEqual(stEmpty, { exists: true, codeHash: null });

  // 5. Valid code hash returns exists: true, codeHash: rawHash
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      result: { code_hash: '2k8B8...valid' }
    })
  });
  const stContract = await rpcProviders.accountState('contract.near');
  assert.deepEqual(stContract, { exists: true, codeHash: '2k8B8...valid' });

  globalThis.fetch = originalFetch;
});

test('mut-killer: default providers accountHistory indexer behavior', async () => {
  const originalFetch = globalThis.fetch;

  // 1. No indexerUrl returns null
  const noIdx = createDefaultProviders();
  assert.equal(await noIdx.accountHistory('alice.near'), null);

  // 2. HTTP error throws
  globalThis.fetch = async () => ({
    ok: false,
    status: 500
  });
  const idx = createDefaultProviders({ indexerUrl: 'https://indexer.example.com/api' });
  await assert.rejects(
    async () => idx.accountHistory('alice.near'),
    /Indexer returned HTTP status 500/
  );

  // 3. Success with fields
  globalThis.fetch = async (url) => {
    assert.ok(url.includes('account_id=alice.near'));
    return {
      ok: true,
      json: async () => ({ firstSeenMs: 1_234_567, txCount: 42 })
    };
  };
  const res = await idx.accountHistory('alice.near');
  assert.deepEqual(res, { firstSeenMs: 1_234_567, txCount: 42 });

  // 4. Success with missing fields fallbacks
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({})
  });
  const resEmpty = await idx.accountHistory('alice.near');
  assert.deepEqual(resEmpty, { firstSeenMs: null, txCount: 0 });

  globalThis.fetch = originalFetch;
});

test('mut-killer: default providers blocklist variations and error handling', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'bl-test-'));
  const blPath = path.join(tmpDir, 'blocklist.json');

  // 1. No path returns null
  const noBl = createDefaultProviders();
  assert.equal(await noBl.blocklist.lookup('bob.near'), null);

  // 2. ENOENT returns null
  const bl = createDefaultProviders({ blocklistPath: path.join(tmpDir, 'nonexistent.json') });
  assert.equal(await bl.blocklist.lookup('bob.near'), null);

  // 3. Array format matching accountId property
  await fs.writeFile(blPath, JSON.stringify([
    { accountId: 'scam1.near', evidence: { txHash: '3vPBG5nB5q3yWk8k3Xg5z7k9m2p4r6t8v1x3y5z7a9b' } },
    { receiver: 'scam2.near', evidence: { url: 'https://scam.org' } }
  ]), 'utf8');

  const prov = createDefaultProviders({ blocklistPath: blPath });
  const hit1 = await prov.blocklist.lookup('scam1.near');
  assert.equal(hit1.accountId, 'scam1.near');
  const hit2 = await prov.blocklist.lookup('scam2.near');
  assert.equal(hit2.receiver, 'scam2.near');
  const miss = await prov.blocklist.lookup('clean.near');
  assert.equal(miss, null);

  // 4. Object dictionary format data[receiver]
  await fs.writeFile(blPath, JSON.stringify({
    'dict-scam.near': { reportedBy: 'community', evidence: { txHash: '3vPBG5nB5q3yWk8k3Xg5z7k9m2p4r6t8v1x3y5z7a9b' } }
  }), 'utf8');
  const hitDict = await prov.blocklist.lookup('dict-scam.near');
  assert.equal(hitDict.reportedBy, 'community');
  const missDict = await prov.blocklist.lookup('clean.near');
  assert.equal(missDict, null);

  // 5. Corrupted JSON throws (non-ENOENT)
  await fs.writeFile(blPath, '{ invalid json', 'utf8');
  await assert.rejects(async () => prov.blocklist.lookup('scam.near'));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('mut-killer: default providers codePin edge cases and errors', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'pin-test-'));
  const pinPath = path.join(tmpDir, 'pins.json');

  // 1. No path
  const noPin = createDefaultProviders();
  assert.equal(await noPin.codePin.get('contract.near'), null);
  await noPin.codePin.set('contract.near', 'hash123'); // No-op, should not throw

  // 2. Corrupted file throws on set and get
  await fs.writeFile(pinPath, '{ broken json', 'utf8');
  const pinProv = createDefaultProviders({ codePinPath: pinPath });
  await assert.rejects(async () => pinProv.codePin.get('contract.near'));
  await assert.rejects(async () => pinProv.codePin.set('contract.near', 'newhash'));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('mut-killer: default providers interactions log formats', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'int-test-'));
  const logPath = path.join(tmpDir, 'interactions.json');

  // 1. No path returns count 0, lastMs null
  const noInt = createDefaultProviders();
  assert.deepEqual(await noInt.interactions('agent1', 'user1'), { count: 0, lastMs: null });

  // 2. ENOENT returns count 0, lastMs null
  const intProv = createDefaultProviders({ interactionLog: path.join(tmpDir, 'notfound.json') });
  assert.deepEqual(await intProv.interactions('agent1', 'user1'), { count: 0, lastMs: null });

  // 3. Array format with recipient and timestamp / ts
  await fs.writeFile(logPath, JSON.stringify([
    { agentId: 'agent1', recipient: 'bob.near', timestamp: 100 },
    { recipient: 'bob.near', ts: 200 }, // no agentId matches any agent
    { agentId: 'agent2', receiver: 'bob.near', ts: 300 }
  ]), 'utf8');

  const p = createDefaultProviders({ interactionLog: logPath });
  const resBob = await p.interactions('agent1', 'bob.near');
  assert.equal(resBob.count, 2);
  assert.equal(resBob.lastMs, 200);

  // 4. Object format: number direct
  await fs.writeFile(logPath, JSON.stringify({
    'agent1:alice.near': 7
  }), 'utf8');
  const resNum = await p.interactions('agent1', 'alice.near');
  assert.deepEqual(resNum, { count: 7, lastMs: null });

  // 5. Object format: nested object
  await fs.writeFile(logPath, JSON.stringify({
    'agent1': { 'charlie.near': { count: 12, lastMs: 9999 } }
  }), 'utf8');
  const resObj = await p.interactions('agent1', 'charlie.near');
  assert.deepEqual(resObj, { count: 12, lastMs: 9999 });

  // 6. Object format: receiver direct key
  await fs.writeFile(logPath, JSON.stringify({
    'dave.near': { count: 3 }
  }), 'utf8');
  const resRecv = await p.interactions('agentX', 'dave.near');
  assert.deepEqual(resRecv, { count: 3, lastMs: null });

  // 7. Non-matching key in object format
  const resNone = await p.interactions('agentX', 'nobody.near');
  assert.deepEqual(resNone, { count: 0, lastMs: null });

  // 8. Corrupted JSON throws
  await fs.writeFile(logPath, 'corrupted', 'utf8');
  await assert.rejects(async () => p.interactions('agent1', 'alice.near'));

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('mut-killer: null policy and null providers do not crash optional chaining', async () => {
  // policy: null
  const resNullPolicy = await checkCounterparty({
    receiver: 'alice.near',
    policy: null,
    now: 1_700_000_000_000
  });
  assert.equal(resNullPolicy.verdict, 'warn');

  // providers: null
  const resNullProviders = await checkCounterparty({
    receiver: 'alice.near',
    providers: null,
    now: 1_700_000_000_000
  });
  assert.equal(resNullProviders.verdict, 'warn');
});

test('mut-killer: default agentId is empty string in interactions provider call', async () => {
  let capturedAgentId = null;
  await checkCounterparty({
    receiver: 'alice.near',
    providers: {
      interactions: async (agentId) => {
        capturedAgentId = agentId;
        return { count: 1 };
      }
    },
    now: 1_700_000_000_000
  });
  assert.equal(capturedAgentId, '');
});

test('mut-killer: undefined now uses Date.now() for account age check', async () => {
  // Account firstSeenMs is 1 second before current real time, so age is ~1s < 7 days minAgeMs
  const res = await checkCounterparty({
    receiver: 'young.near',
    providers: {
      accountHistory: async () => ({
        firstSeenMs: Date.now() - 1000,
        txCount: 10
      })
    }
  });
  const ageReason = res.reasons.find((r) => r.signal === 'account_age');
  assert.ok(ageReason, 'Should have account_age reason');
  assert.equal(ageReason.level, 'warn');
  assert.ok(ageReason.detail.includes('is below required threshold'));
});

test('mut-killer: codePin undefined and blocklist undefined are handled as fresh and clean', async () => {
  const res = await checkCounterparty({
    receiver: 'contract.near',
    providers: {
      accountState: async () => ({ exists: true, codeHash: 'some_hash' }),
      codePin: {
        get: async () => undefined,
        set: async () => {}
      },
      blocklist: {
        lookup: async () => undefined
      }
    },
    now: 1_700_000_000_000
  });

  const codeReason = res.reasons.find((r) => r.signal === 'contract_code');
  assert.equal(codeReason.level, 'warn');
  assert.equal(codeReason.detail, 'New contract seen for the first time');

  const blReason = res.reasons.find((r) => r.signal === 'blocklist');
  assert.equal(blReason.level, 'info');
  assert.equal(blReason.detail, 'Receiver is not on blocklist');
  assert.equal(blReason.source, 'blocklist');

  // Also check source on unevidenced blocklist entry
  const resUnevidenced = await checkCounterparty({
    receiver: 'suspect.near',
    providers: {
      blocklist: {
        lookup: async () => ({ reportedBy: 'alice', evidence: null })
      }
    },
    now: 1_700_000_000_000
  });
  const blWarn = resUnevidenced.reasons.find((r) => r.signal === 'blocklist');
  assert.equal(blWarn.source, 'blocklist');
});

test('mut-killer: URL length validation trims before checking MAX_EVIDENCE_URL_LENGTH', async () => {
  // A 50-character URL padded with whitespace to 305 characters
  const rawUrl = 'https://explorer.near.org/transactions/1234567890';
  const paddedUrl = rawUrl.padStart(200, ' ').padEnd(305, ' ');
  assert.ok(paddedUrl.length > 300, 'Padded length must exceed 300');
  assert.ok(paddedUrl.trim().length <= 300, 'Trimmed length must be within 300');

  const res = await checkCounterparty({
    receiver: 'scam.near',
    providers: {
      blocklist: {
        lookup: async () => ({
          reportedBy: 'security',
          evidence: { url: paddedUrl }
        })
      }
    },
    now: 1_700_000_000_000
  });
  assert.equal(res.verdict, 'block');
});

test('mut-killer: default providers accountState RPC verifies exact HTTP method, headers, and request body', async () => {
  const originalFetch = globalThis.fetch;
  let interceptedCall = null;

  globalThis.fetch = async (url, options) => {
    interceptedCall = { url, options, body: JSON.parse(options.body) };
    return {
      ok: true,
      json: async () => ({
        jsonrpc: '2.0',
        result: { code_hash: 'test_hash_val' }
      })
    };
  };

  const providers = createDefaultProviders({ rpcUrl: 'https://rpc.mainnet.near.org' });
  const st = await providers.accountState('alice.near');

  assert.equal(st.exists, true);
  assert.equal(st.codeHash, 'test_hash_val');
  assert.equal(interceptedCall.options.method, 'POST');
  assert.equal(interceptedCall.options.headers['content-type'], 'application/json');
  assert.equal(interceptedCall.body.jsonrpc, '2.0');
  assert.equal(interceptedCall.body.id, 'counterparty-check');
  assert.equal(interceptedCall.body.method, 'query');
  assert.deepEqual(interceptedCall.body.params, {
    request_type: 'view_account',
    finality: 'final',
    account_id: 'alice.near'
  });

  globalThis.fetch = originalFetch;
});

test('mut-killer: default providers accountHistory verifies exact HTTP method and accept header', async () => {
  const originalFetch = globalThis.fetch;
  let interceptedOptions = null;

  globalThis.fetch = async (url, options) => {
    interceptedOptions = options;
    return {
      ok: true,
      json: async () => ({ firstSeenMs: 12345, txCount: 99 })
    };
  };

  const providers = createDefaultProviders({ indexerUrl: 'https://indexer.example.com/api' });
  const res = await providers.accountHistory('bob.near');

  assert.deepEqual(res, { firstSeenMs: 12345, txCount: 99 });
  assert.equal(interceptedOptions.method, 'GET');
  assert.equal(interceptedOptions.headers.accept, 'application/json');

  globalThis.fetch = originalFetch;
});

test('mut-killer: default providers interactions array format with 0 count has null lastMs', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'int-zero-'));
  const logPath = path.join(tmpDir, 'interactions.json');

  await fs.writeFile(logPath, JSON.stringify([
    { agentId: 'agent1', recipient: 'other.near', timestamp: 100 }
  ]), 'utf8');

  const p = createDefaultProviders({ interactionLog: logPath });
  const res = await p.interactions('agent1', 'nomatch.near');
  assert.equal(res.count, 0);
  assert.equal(res.lastMs, null);

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('mut-killer: default providers interactions handles null and non-object direct entries', async () => {
  const tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'int-null-'));
  const logPath = path.join(tmpDir, 'interactions.json');

  await fs.writeFile(logPath, JSON.stringify({
    'agent1:null_val.near': null,
    'agent1:string_val.near': 'not-an-object'
  }), 'utf8');

  const p = createDefaultProviders({ interactionLog: logPath });
  const resNull = await p.interactions('agent1', 'null_val.near');
  assert.deepEqual(resNull, { count: 0, lastMs: null });

  const resStr = await p.interactions('agent1', 'string_val.near');
  assert.deepEqual(resStr, { count: 0, lastMs: null });

  // Direct null value at top-level receiver key kills LogicalOperator mutant
  await fs.writeFile(logPath, JSON.stringify({
    'direct_null.near': null
  }), 'utf8');
  const resDirectNull = await p.interactions('agent1', 'direct_null.near');
  assert.deepEqual(resDirectNull, { count: 0, lastMs: null });

  await fs.rm(tmpDir, { recursive: true, force: true });
});

test('mut-killer: provider timeout error message includes timeoutMs value', async () => {
  const res = await checkCounterparty({
    receiver: 'slow.near',
    providers: {
      accountHistory: () => new Promise(() => {}) // never resolves
    },
    policy: { timeoutMs: 50 },
    now: 1_700_000_000_000
  });

  const ageReason = res.reasons.find((r) => r.signal === 'account_age');
  assert.ok(ageReason);
  assert.equal(ageReason.level, 'warn');
  assert.equal(ageReason.source, 'unavailable');
  assert.equal(ageReason.detail, 'Account history provider unavailable: Provider timed out after 50ms');
});

test('mut-killer: omitted provider functions produce proper signals instead of throwing unavailable', async () => {
  // When providers are omitted or undefined, checkCounterparty must use safe defaults
  // and NOT throw TypeError or produce 'unavailable' source.
  const res = await checkCounterparty({
    receiver: 'fresh.near',
    providers: {
      // accountHistory omitted -> history: 'Account has never been seen before'
      // accountState omitted -> state: 'Account does not exist on-chain'
      // interactions omitted -> interactions: 'New receiver for this agent...'
      // blocklist omitted -> blocklist: 'Receiver is not on blocklist'
    },
    now: 1_700_000_000_000
  });

  const ageReason = res.reasons.find((r) => r.signal === 'account_age');
  assert.equal(ageReason.source, 'history');
  assert.equal(ageReason.detail, 'Account has never been seen before');

  const stateReason = res.reasons.find((r) => r.signal === 'contract_code');
  assert.equal(stateReason.source, 'state');
  assert.equal(stateReason.detail, 'Account does not exist on-chain');

  const interReason = res.reasons.find((r) => r.signal === 'prior_interaction');
  assert.equal(interReason.source, 'interactions');
  assert.equal(interReason.detail, 'New receiver for this agent');

  const blReason = res.reasons.find((r) => r.signal === 'blocklist');
  assert.equal(blReason.source, 'blocklist');
  assert.equal(blReason.detail, 'Receiver is not on blocklist');
});

test('mut-killer: interactions provider returning null or count null defaults count to 0 with interactions source', async () => {
  const resNull = await checkCounterparty({
    receiver: 'alice.near',
    providers: {
      interactions: async () => null
    },
    now: 1_700_000_000_000
  });
  const rNull = resNull.reasons.find((r) => r.signal === 'prior_interaction');
  assert.equal(rNull.source, 'interactions');
  assert.equal(rNull.level, 'warn');

  const resCountNull = await checkCounterparty({
    receiver: 'bob.near',
    providers: {
      interactions: async () => ({ count: null })
    },
    now: 1_700_000_000_000
  });
  const rCountNull = resCountNull.reasons.find((r) => r.signal === 'prior_interaction');
  assert.equal(rCountNull.source, 'interactions');
  assert.equal(rCountNull.level, 'warn');
});

test('mut-killer: default providers accountState handles RPC response without result field', async () => {
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      jsonrpc: '2.0',
      id: 'counterparty-check'
      // result missing
    })
  });

  const p = createDefaultProviders({ rpcUrl: 'https://rpc.mainnet.near.org' });
  const st = await p.accountState('alice.near');
  assert.deepEqual(st, { exists: true, codeHash: null });

  globalThis.fetch = originalFetch;
});

