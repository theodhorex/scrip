import test from 'node:test';
import assert from 'node:assert/strict';
import { loadPolicy } from '../src/policy.mjs';
import { basePolicy } from './helpers.mjs';

test('valid policy loads, is frozen, maxGas becomes bigint', () => {
  const p = loadPolicy(basePolicy);
  assert.equal(p.maxGas, 100_000_000_000_000n);
  assert.equal(p.minGas, 60_000_000_000_000n);
  assert.ok(p.globalRateLimit.capacity > 0 && Object.isFrozen(p.globalRateLimit));
  assert.ok(Object.isFrozen(p) && Object.isFrozen(p.allowedMethods) && Object.isFrozen(p.rateLimit));
});

test('rejects mainnet network, non-.testnet ids and mainnet RPC urls', () => {
  assert.throws(() => loadPolicy({ ...basePolicy, network: 'mainnet' }), /testnet/);
  assert.throws(() => loadPolicy({ ...basePolicy, contractId: 'scrip.near' }), /testnet/);
  assert.throws(() => loadPolicy({ ...basePolicy, allowedAgents: ['a.near'] }), /testnet/);
  assert.throws(() => loadPolicy({ ...basePolicy, rpcUrl: 'https://rpc.mainnet.near.org' }), /rpc/i);
  assert.throws(() => loadPolicy({ ...basePolicy, rpcUrl: 'https://rpc.example.com' }), /rpc/i);
  assert.doesNotThrow(() => loadPolicy({ ...basePolicy, rpcUrl: 'https://rpc.testnet.fastnear.com' }));
});

test('rejects malformed fields', () => {
  assert.throws(() => loadPolicy(null));
  assert.throws(() => loadPolicy({ ...basePolicy, allowedMethods: [] }));
  assert.throws(() => loadPolicy({ ...basePolicy, maxGas: '-1' }));
  assert.throws(() => loadPolicy({ ...basePolicy, maxGas: 5 }));
  assert.throws(() => loadPolicy({ ...basePolicy, maxBlockHeightWindow: 0 }));
  assert.throws(() => loadPolicy({ ...basePolicy, minBlockHeightMargin: 500 }));
  assert.throws(() => loadPolicy({ ...basePolicy, rateLimit: { capacity: 0, refillPerSecond: 1 } }));
  assert.throws(() => loadPolicy({ ...basePolicy, rateLimit: { capacity: 1, refillPerSecond: 0 } }));
});

test('F2 fail closed: allowedAgents is required and non-empty', () => {
  const { allowedAgents, ...rest } = basePolicy;
  assert.throws(() => loadPolicy(rest), /allowedAgents/);
  assert.throws(() => loadPolicy({ ...basePolicy, allowedAgents: [] }), /allowedAgents/);
});

test('minGas: default 60 Tgas, cannot be lower, must be <= maxGas', () => {
  assert.equal(loadPolicy({ ...basePolicy, minGas: '70000000000000' }).minGas, 70_000_000_000_000n);
  assert.throws(() => loadPolicy({ ...basePolicy, minGas: '59999999999999' }), /minGas/);
  assert.throws(() => loadPolicy({ ...basePolicy, minGas: 70 }), /minGas/);
  assert.throws(() => loadPolicy({ ...basePolicy, maxGas: '50000000000000' }), /minGas/);
});

test('globalRateLimit validated when given', () => {
  assert.deepEqual({ ...loadPolicy({ ...basePolicy, globalRateLimit: { capacity: 5, refillPerSecond: 0.5 } }).globalRateLimit }, { capacity: 5, refillPerSecond: 0.5 });
  assert.throws(() => loadPolicy({ ...basePolicy, globalRateLimit: { capacity: 0, refillPerSecond: 1 } }));
});

test('F9 rpcUrl is an exact host allowlist', () => {
  for (const h of ['rpc.testnet.fastnear.com', 'test.rpc.fastnear.com', 'rpc.testnet.near.org', 'rpc.testnet.pagoda.co']) {
    assert.doesNotThrow(() => loadPolicy({ ...basePolicy, rpcUrl: `https://${h}` }));
  }
  for (const u of ['https://testnet.attacker.example', 'https://rpc.testnet.fastnear.com.evil.example', 'https://evil.example/rpc.testnet.near.org',
    'http://rpc.testnet.near.org', 'https://user@testnet.attacker.example', 'https://localhost:3030', 'http://127.0.0.1:3030']) {
    assert.throws(() => loadPolicy({ ...basePolicy, rpcUrl: u }), /rpc/i, u);
  }
  assert.doesNotThrow(() => loadPolicy({ ...basePolicy, rpcUrl: 'http://127.0.0.1:3030' }, { allowLocalRpc: true }));
  assert.doesNotThrow(() => loadPolicy({ ...basePolicy, rpcUrl: 'http://localhost:3030' }, { allowLocalRpc: true }));
  assert.throws(() => loadPolicy({ ...basePolicy, rpcUrl: 'http://evil.example' }, { allowLocalRpc: true }), /rpc/i);
});

test('new defaults and validation: ipRateLimit, maxInFlightRelays, trustProxy', async () => {
  const { basePolicy } = await import('./helpers.mjs');
  const p = loadPolicy(basePolicy);
  assert.deepEqual([p.maxInFlightRelays, p.trustProxy, p.ipRateLimit.capacity], [8, false, 20]);
  assert.throws(() => loadPolicy({ ...basePolicy, maxInFlightRelays: 0 }));
  assert.throws(() => loadPolicy({ ...basePolicy, trustProxy: 'yes' }));
  assert.throws(() => loadPolicy({ ...basePolicy, ipRateLimit: { capacity: 0, refillPerSecond: 1 } }));
  assert.equal(loadPolicy({ ...basePolicy, trustProxy: true }).trustProxy, true);
});
