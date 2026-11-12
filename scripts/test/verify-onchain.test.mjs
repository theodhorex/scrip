import test from 'node:test';
import assert from 'node:assert/strict';
import {
  toBase58,
  parseClaimedTxs,
  classifyOnchainResult,
  matchClaimWithOnchain,
  summarizeResults,
  queryTxStatus,
  indexerTxToRpcResult,
  fetchIndexerBatch,
} from '../verify-onchain.mjs';

test('toBase58 encodes binary buffers correctly', () => {
  // Test with leading zeros and known test vectors
  const empty = Buffer.from([]);
  assert.equal(toBase58(empty), '');

  const zeroes = Buffer.from([0, 0, 0]);
  assert.equal(toBase58(zeroes), '111');

  // "Hello World" in base58 is "JxF12TrwUP45BMd"
  const hello = Buffer.from('Hello World');
  assert.equal(toBase58(hello), 'JxF12TrwUP45BMd');
});

test('parseClaimedTxs extracts expected transactions and claims from fixtures', () => {
  const demoFixture = {
    agents: {
      naive: {
        invoices: [
          { txHash: 'EcfKGLKMoLJgumuh9iNTTenjm8m4GYChC1zwWFTi14vE', paid: true, rejectionCode: null },
          { txHash: null, paid: false, rejectionCode: 'TRANSFER_FAILED' }
        ]
      },
      amanat: {
        invoices: [
          { txHash: '9UpU5SNwVwasrD2thdMtyoh9vdTkBcgjWLKMM7xV3k78', paid: true, rejectionCode: null },
          { txHash: '4dAYztmoCoGoCVuS38gaJPM2sskVfpeW5YH6r2mFPHL5', paid: false, rejectionCode: 'RECIPIENT_NOT_ALLOWED' }
        ]
      }
    },
    txs: {
      deploy: 'Ap3xT6w2RimLu1UkcdsjeBTKpDXgX9Pxr6SmnbreTEWY'
    },
    facilitatorLog: [
      '{"agent":"dma42992.envtest-theo-1747.testnet"}'
    ]
  };

  const gateFixture = {
    steps: {
      attacks: {
        recipientNotAllowed: {
          tx: 'BvbcY9CVG8ubdUhF9aeAhHvz8za81b1beGWZQuaZuEZY',
          rejected: ['RECIPIENT_NOT_ALLOWED']
        }
      }
    },
    txs: {
      fund: '9TjQGXFTwucnngHtkhapSebzbPqdk1byfN11oUYCep2K'
    }
  };

  const attackFixture = [
    { network: 'testnet', cases: [] }
  ];

  const items = parseClaimedTxs({
    'demo.json': demoFixture,
    'gate.json': gateFixture,
    'attack.json': attackFixture
  });

  // Verify demo txs
  const naive0 = items.find((x) => x.txHash === 'EcfKGLKMoLJgumuh9iNTTenjm8m4GYChC1zwWFTi14vE');
  assert.ok(naive0);
  assert.equal(naive0.expectedStatus, 'SUCCESS');
  assert.equal(naive0.file, 'demo.json');

  const amanatRejected = items.find((x) => x.txHash === '4dAYztmoCoGoCVuS38gaJPM2sskVfpeW5YH6r2mFPHL5');
  assert.ok(amanatRejected);
  assert.equal(amanatRejected.expectedStatus, 'REJECTED');
  assert.equal(amanatRejected.expectedCode, 'RECIPIENT_NOT_ALLOWED');

  // Verify gate txs
  const gateAttack = items.find((x) => x.txHash === 'BvbcY9CVG8ubdUhF9aeAhHvz8za81b1beGWZQuaZuEZY');
  assert.ok(gateAttack);
  assert.equal(gateAttack.expectedStatus, 'REJECTED');
  assert.equal(gateAttack.expectedCode, 'RECIPIENT_NOT_ALLOWED');

  // Verify attack.json has 0 txs
  const attackItems = items.filter((x) => x.file === 'attack.json');
  assert.equal(attackItems.length, 0);
});

test('classifyOnchainResult detects success, contract rejection, and execution failure', () => {
  // 1. Success tx
  const successRpc = {
    status: { SuccessValue: '' },
    receipts_outcome: [
      { outcome: { status: { SuccessValue: '' }, logs: [] } }
    ]
  };
  assert.deepEqual(classifyOnchainResult(successRpc), {
    status: 'SUCCESS',
    code: null,
    error: null
  });

  // 2. Rejected via SuccessValue (Base64 {"Rejected":{"code":"RECIPIENT_NOT_ALLOWED"}})
  const rejectedValueB64 = Buffer.from(JSON.stringify({ Rejected: { code: 'RECIPIENT_NOT_ALLOWED' } })).toString('base64');
  const rejectedRpcVal = {
    status: { SuccessValue: '' },
    receipts_outcome: [
      { outcome: { status: { SuccessValue: rejectedValueB64 }, logs: [] } }
    ]
  };
  assert.deepEqual(classifyOnchainResult(rejectedRpcVal), {
    status: 'REJECTED',
    code: 'RECIPIENT_NOT_ALLOWED',
    error: null
  });

  // 3. Rejected via EVENT_JSON logs
  const rejectedRpcLog = {
    status: { SuccessValue: '' },
    receipts_outcome: [
      {
        outcome: {
          status: { SuccessReceiptId: 'abc' },
          logs: [
            'EVENT_JSON:{"standard":"amanat","version":"1.0.0","event":"rejected","data":[{"code":"OVER_PER_PAYMENT_CAP"}]}'
          ]
        }
      }
    ]
  };
  assert.deepEqual(classifyOnchainResult(rejectedRpcLog), {
    status: 'REJECTED',
    code: 'OVER_PER_PAYMENT_CAP',
    error: null
  });

  // 4. Execution failure in receipt
  const failedRpc = {
    status: { SuccessValue: '' },
    receipts_outcome: [
      { outcome: { status: { Failure: { ActionError: { FunctionCallError: { ExecutionError: 'Smart contract panicked' } } } }, logs: [] } }
    ]
  };
  const classifiedFail = classifyOnchainResult(failedRpc);
  assert.equal(classifiedFail.status, 'FAILURE');
  assert.ok(classifiedFail.error.includes('ExecutionError') || classifiedFail.error.includes('panicked'));
});

test('matchClaimWithOnchain correctly compares claimed behavior with onchain result', () => {
  // Match: SUCCESS expected and SUCCESS onchain
  assert.deepEqual(
    matchClaimWithOnchain(
      { expectedStatus: 'SUCCESS', expectedCode: null },
      { status: 'SUCCESS', code: null, error: null }
    ),
    { outcome: 'VERIFIED', reason: 'matches claimed success' }
  );

  // Match: REJECTED RECIPIENT_NOT_ALLOWED expected and matching onchain
  assert.deepEqual(
    matchClaimWithOnchain(
      { expectedStatus: 'REJECTED', expectedCode: 'RECIPIENT_NOT_ALLOWED' },
      { status: 'REJECTED', code: 'RECIPIENT_NOT_ALLOWED', error: null }
    ),
    { outcome: 'VERIFIED', reason: 'rejected with expected RECIPIENT_NOT_ALLOWED' }
  );

  // Mismatch: expected REJECTED but got SUCCESS (security failure!)
  assert.deepEqual(
    matchClaimWithOnchain(
      { expectedStatus: 'REJECTED', expectedCode: 'RECIPIENT_NOT_ALLOWED' },
      { status: 'SUCCESS', code: null, error: null }
    ),
    { outcome: 'MISMATCHED', reason: 'expected REJECTED(RECIPIENT_NOT_ALLOWED) but tx succeeded' }
  );

  // Mismatch: expected SUCCESS but got FAILURE
  assert.deepEqual(
    matchClaimWithOnchain(
      { expectedStatus: 'SUCCESS', expectedCode: null },
      { status: 'FAILURE', code: null, error: 'panic' }
    ),
    { outcome: 'MISMATCHED', reason: 'expected SUCCESS but tx failed: panic' }
  );

  // Unverifiable: network error or unknown
  assert.deepEqual(
    matchClaimWithOnchain(
      { expectedStatus: 'SUCCESS', expectedCode: null },
      { status: 'UNVERIFIABLE', code: null, error: 'network timeout' }
    ),
    { outcome: 'UNVERIFIABLE', reason: 'network timeout' }
  );
});

test('summarizeResults aggregates correctly and derives proper exit code', () => {
  // All verified -> exit code 0
  const allGood = [
    { outcome: 'VERIFIED' },
    { outcome: 'VERIFIED' }
  ];
  assert.deepEqual(summarizeResults(allGood), {
    verified: 2,
    mismatched: 0,
    unverifiable: 0,
    exitCode: 0
  });

  // Any mismatched -> exit code 1
  const hasMismatch = [
    { outcome: 'VERIFIED' },
    { outcome: 'MISMATCHED' },
    { outcome: 'UNVERIFIABLE' }
  ];
  assert.deepEqual(summarizeResults(hasMismatch), {
    verified: 1,
    mismatched: 1,
    unverifiable: 1,
    exitCode: 1
  });

  // No mismatch, but some unverifiable -> exit code 2
  const hasUnverifiable = [
    { outcome: 'VERIFIED' },
    { outcome: 'UNVERIFIABLE' }
  ];
  assert.deepEqual(summarizeResults(hasUnverifiable), {
    verified: 1,
    mismatched: 0,
    unverifiable: 1,
    exitCode: 2
  });
});

test('queryTxStatus with injected fake fetch: handles 200, retry on 429/5xx, and network errors', async () => {
  // 1. Success on first try
  const fakeFetchSuccess = async () => ({
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      result: {
        status: { SuccessValue: '' },
        receipts_outcome: []
      }
    })
  });
  const res1 = await queryTxStatus('hash1', ['alice.testnet'], {
    fetchFn: fakeFetchSuccess,
    rpcUrl: 'https://rpc.example.com',
    maxRetries: 2,
    baseDelayMs: 1
  });
  assert.equal(res1.status, 'SUCCESS');

  // 2. 429 retry then success
  let attempts = 0;
  const fakeFetchRetry = async () => {
    attempts++;
    if (attempts === 1) return { status: 429, headers: new Headers() };
    return {
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: { status: { SuccessValue: '' }, receipts_outcome: [] }
      })
    };
  };
  const res2 = await queryTxStatus('hash2', ['bob.testnet'], {
    fetchFn: fakeFetchRetry,
    rpcUrl: 'https://rpc.example.com',
    maxRetries: 3,
    baseDelayMs: 1
  });
  assert.equal(res2.status, 'SUCCESS');
  assert.equal(attempts, 2);

  // 3. Network error / connection refused -> UNVERIFIABLE, NEVER PASS
  const fakeFetchError = async () => {
    throw new Error('connect ECONNREFUSED');
  };
  const res3 = await queryTxStatus('hash3', ['carol.testnet'], {
    fetchFn: fakeFetchError,
    rpcUrl: 'https://rpc.example.com',
    maxRetries: 1,
    baseDelayMs: 1
  });
  assert.equal(res3.status, 'UNVERIFIABLE');
  assert.ok(res3.error.includes('ECONNREFUSED'));

  // 4. Missing sender account ID -> UNVERIFIABLE
  const res4 = await queryTxStatus('hash4', [], {
    fetchFn: fakeFetchSuccess,
    rpcUrl: 'https://rpc.example.com'
  });
  assert.equal(res4.status, 'UNVERIFIABLE');
  assert.ok(res4.error.includes('missing sender') || res4.error.includes('no sender'));
});

test('checkContractAccount handles locked contract, full access keys, and missing accounts', async () => {
  const { checkContractAccount } = await import('../verify-onchain.mjs');

  // 1. Account with only FunctionCall keys (locked/no FullAccess)
  const fakeFetchLocked = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.params.request_type === 'view_account') {
      return {
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: { code_hash: 'Gvopaub7RSSdcdz3vMRkkidePnB6McCjh3Hv8WpLxRvd' }
        })
      };
    }
    if (body.params.request_type === 'view_access_key_list') {
      return {
        status: 200,
        json: async () => ({
          jsonrpc: '2.0',
          id: 1,
          result: {
            keys: [
              { public_key: 'ed25519:123', access_key: { permission: { FunctionCall: {} } } }
            ]
          }
        })
      };
    }
  };

  const chk1 = await checkContractAccount('scrip.testnet', 'https://rpc.example.com', fakeFetchLocked);
  assert.equal(chk1.exists, true);
  assert.equal(chk1.hasFullAccess, false);
  assert.equal(chk1.codeHash, 'Gvopaub7RSSdcdz3vMRkkidePnB6McCjh3Hv8WpLxRvd');

  // 2. Account with FullAccess key
  const fakeFetchUnlocked = async (_url, init) => {
    const body = JSON.parse(init.body);
    if (body.params.request_type === 'view_account') {
      return {
        status: 200,
        json: async () => ({ jsonrpc: '2.0', id: 1, result: { code_hash: 'abc' } })
      };
    }
    return {
      status: 200,
      json: async () => ({
        jsonrpc: '2.0',
        id: 1,
        result: {
          keys: [{ public_key: 'ed25519:admin', access_key: { permission: 'FullAccess' } }]
        }
      })
    };
  };

  const chk2 = await checkContractAccount('scrip.testnet', 'https://rpc.example.com', fakeFetchUnlocked);
  assert.equal(chk2.exists, true);
  assert.equal(chk2.hasFullAccess, true);

  // 3. Account not found
  const fakeFetchMissing = async () => ({
    status: 200,
    json: async () => ({
      jsonrpc: '2.0',
      id: 1,
      error: { cause: { name: 'UNKNOWN_ACCOUNT' }, message: 'Server error' }
    })
  });

  const chk3 = await checkContractAccount('deleted.testnet', 'https://rpc.example.com', fakeFetchMissing);
  assert.equal(chk3.exists, false);
});

const rejectedB64 = Buffer.from(JSON.stringify({ Rejected: { code: 'OVER_BUDGET' } })).toString('base64');
const indexerTx = (id, status) => ({
  execution_outcome: { id, outcome: { status: { SuccessReceiptId: 'r' } } },
  receipts: [{ execution_outcome: { outcome: { status } } }],
});

test('indexerTxToRpcResult: a Scrip refusal from the indexer classifies as REJECTED with its code', () => {
  const r = indexerTxToRpcResult(indexerTx('h1', { SuccessValue: rejectedB64 }));
  assert.deepEqual(classifyOnchainResult(r), { status: 'REJECTED', code: 'OVER_BUDGET', error: null });
  assert.equal(indexerTxToRpcResult({}), null);
});

test('fetchIndexerBatch: sends hashes in batches of 20 and keys results by hash', async () => {
  const hashes = Array.from({ length: 45 }, (_, i) => `hash${i}`);
  const sizes = [];
  const fetchFn = async (_url, init) => {
    const batch = JSON.parse(init.body).tx_hashes;
    sizes.push(batch.length);
    return { ok: true, status: 200, json: async () => ({ transactions: batch.map((h) => indexerTx(h, { SuccessValue: '' })) }) };
  };
  const map = await fetchIndexerBatch(hashes, { fetchFn, indexerUrl: 'https://indexer.test' });
  assert.deepEqual(sizes, [20, 20, 5]);
  assert.equal(map.size, 45);
  assert.equal(classifyOnchainResult(map.get('hash7')).status, 'SUCCESS');
});

test('fetchIndexerBatch: an unreachable or erroring indexer returns an empty map instead of throwing', async () => {
  assert.equal((await fetchIndexerBatch(['a'], { fetchFn: async () => { throw new Error('down'); } })).size, 0);
  assert.equal((await fetchIndexerBatch(['a'], { fetchFn: async () => ({ ok: false, status: 429, json: async () => ({}) }) })).size, 0);
});

test('parseClaimedTxs: demo-llm.json decisions are verified like invoices', async () => {
  const { parseClaimedTxs } = await import('../verify-onchain.mjs');
  const h1 = '4'.repeat(44);
  const h2 = '5'.repeat(44);
  const items = parseClaimedTxs({ 'demo-llm.json': { agents: {
    naive: { decisions: [{ paid: true, txHash: h1, rejectionCode: null }] },
    scrip: { decisions: [{ paid: false, txHash: h2, rejectionCode: 'RECIPIENT_NOT_ALLOWED' }] },
  } } });
  assert.equal(items.length, 2);
  assert.equal(items[0].expectedStatus, 'SUCCESS');
  assert.equal(items[1].expectedStatus, 'REJECTED');
  assert.equal(items[1].expectedCode, 'RECIPIENT_NOT_ALLOWED');
});
