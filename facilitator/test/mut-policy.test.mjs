// Tests added to kill surviving mutants in src/policy.mjs (Stryker run 2026-10-31).
// Each test names the mutant ids it is meant to kill; ids come from
// .stryker-out/mutation-policy-before.json. Assertions target observable policy
// behaviour (returned policy, thrown message) at real boundaries.
import test from 'node:test';
import assert from 'node:assert/strict';
import { isTestnetId, checkRpcUrl, loadPolicy, MIN_GAS, RPC_HOSTS } from '../src/policy.mjs';
import { basePolicy } from './helpers.mjs';

const messageOf = (fn) => {
  try {
    fn();
  } catch (e) {
    return e.message;
  }
  throw new Error('expected a throw');
};

// Deterministic PRNG so property tests are reproducible and dependency-free.
function rng(seed) {
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6d2b79f5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

test('loadPolicy: non-objects are rejected with the policy-object contract message (kills 108-118)', () => {
  for (const input of [null, undefined, [], 'policy', 7, true, () => {}]) {
    assert.throws(() => loadPolicy(input), /policy must be an object/, String(input));
  }
  // Array argument: must fail at the object guard, not later on a missing field.
  assert.match(messageOf(() => loadPolicy([])), /policy must be an object/);
});

test('loadPolicy: allowedMethods element validation (kills 137,139-141,145,146,151)', () => {
  assert.throws(() => loadPolicy({ ...basePolicy, allowedMethods: [] }), /allowedMethods must be a non-empty array/);
  // Non-string that stringifies to a valid method name must still be rejected.
  assert.throws(() => loadPolicy({ ...basePolicy, allowedMethods: [['request_payment']] }), /bad method name/);
  // Leading digit exercises the ^ anchor; trailing punctuation exercises the $ anchor.
  assert.throws(() => loadPolicy({ ...basePolicy, allowedMethods: ['1request_payment'] }), /bad method name/);
  assert.throws(() => loadPolicy({ ...basePolicy, allowedMethods: ['request_payment!'] }), /bad method name/);
});

test('loadPolicy: maxGas/minGas type and anchor boundaries (kills 167-169,173,174,179,185-187,191,192)', () => {
  // A number bypasses typeof-based mutants; they then reach BigInt() and fail
  // with a different (wrong) message, which this exact assertion detects.
  assert.throws(() => loadPolicy({ ...basePolicy, maxGas: 5 }), /maxGas must be a positive integer string/);
  assert.throws(() => loadPolicy({ ...basePolicy, minGas: 5 }), /minGas must be a positive integer string/);
  // Leading '+' matches only when the ^ anchor is dropped.
  assert.throws(() => loadPolicy({ ...basePolicy, maxGas: '+60000000000000', minGas: '60000000000000' }), /maxGas/);
  assert.throws(() => loadPolicy({ ...basePolicy, minGas: '+60000000000000' }), /minGas/);
  // Trailing junk matches only when the $ anchor is dropped.
  assert.throws(() => loadPolicy({ ...basePolicy, maxGas: '60000000000000x' }), /maxGas/);
  assert.throws(() => loadPolicy({ ...basePolicy, minGas: '60000000000000x' }), /minGas/);
});

test('loadPolicy: gas boundaries are inclusive at MIN_GAS and at minGas == maxGas (kills 200,206)', () => {
  const atFloor = loadPolicy({ ...basePolicy, minGas: MIN_GAS.toString() });
  assert.equal(atFloor.minGas, MIN_GAS);

  const equal = loadPolicy({ ...basePolicy, minGas: '60000000000000', maxGas: '60000000000000' });
  assert.equal(equal.minGas, MIN_GAS);
  assert.equal(equal.maxGas, MIN_GAS);

  assert.throws(() => loadPolicy({ ...basePolicy, minGas: '59999999999999' }), /minGas must be >=/);
  assert.throws(() => loadPolicy({ ...basePolicy, minGas: '60000000000001', maxGas: '60000000000000' }), /minGas must be <= maxGas/);
});

test('loadPolicy: block-height window and margin boundaries (kills 43,210,211,214,217)', () => {
  assert.throws(() => loadPolicy({ ...basePolicy, maxBlockHeightWindow: 0 }), /maxBlockHeightWindow must be an integer >= 1/);
  assert.throws(() => loadPolicy({ ...basePolicy, minBlockHeightMargin: 1.5 }), /minBlockHeightMargin must be an integer >= 0/);
  // Equality is invalid: margin must stay strictly below the window.
  assert.throws(
    () => loadPolicy({ ...basePolicy, maxBlockHeightWindow: 10, minBlockHeightMargin: 10 }),
    /minBlockHeightMargin must be < maxBlockHeightWindow/,
  );
  assert.equal(loadPolicy({ ...basePolicy, maxBlockHeightWindow: 10, minBlockHeightMargin: 9 }).minBlockHeightMargin, 9);
});

test('loadPolicy: rateLimit is mandatory (kills 219,220,221,223,227)', () => {
  assert.throws(() => loadPolicy({ ...basePolicy, rateLimit: null }), /rateLimit is required/);
  assert.throws(() => loadPolicy({ ...basePolicy, rateLimit: 'bucket' }), /rateLimit is required/);
});

test('loadPolicy: globalRateLimit and ipRateLimit object contract (kills 231,232,235,239,243,244,247,251)', () => {
  // null is nullish and therefore replaced by the documented default.
  const defaults = loadPolicy({ ...basePolicy, globalRateLimit: null, ipRateLimit: null });
  assert.deepEqual({ ...defaults.globalRateLimit }, { capacity: 30, refillPerSecond: 0.5 });
  assert.deepEqual({ ...defaults.ipRateLimit }, { capacity: 20, refillPerSecond: 1 });

  assert.throws(() => loadPolicy({ ...basePolicy, globalRateLimit: 'bucket' }), /globalRateLimit must be an object/);
  assert.throws(() => loadPolicy({ ...basePolicy, ipRateLimit: 'bucket' }), /ipRateLimit must be an object/);
});

test('loadPolicy: maxInFlightRelays and trustProxy contract (kills 255,265)', () => {
  assert.throws(() => loadPolicy({ ...basePolicy, maxInFlightRelays: 0 }), /maxInFlightRelays must be an integer >= 1/);
  assert.throws(() => loadPolicy({ ...basePolicy, trustProxy: 'yes' }), /trustProxy must be a boolean/);
});

test('loadPolicy: refillPerSecond must be a real number, not a numeric string (kills 48,49,50)', () => {
  // A string passes `v <= 0` and every typeof/isfinite short-circuit mutant,
  // so only the unmutated guard rejects it.
  assert.throws(
    () => loadPolicy({ ...basePolicy, rateLimit: { capacity: 1, refillPerSecond: '5' } }),
    /rateLimit\.refillPerSecond must be a number > 0/,
  );
  assert.throws(
    () => loadPolicy({ ...basePolicy, globalRateLimit: { capacity: 1, refillPerSecond: Number.NaN } }),
    /globalRateLimit\.refillPerSecond must be a number > 0/,
  );
  assert.throws(
    () => loadPolicy({ ...basePolicy, ipRateLimit: { capacity: 1, refillPerSecond: Number.POSITIVE_INFINITY } }),
    /ipRateLimit\.refillPerSecond must be a number > 0/,
  );
});

test('loadPolicy: nested rate-limit field names appear in errors (kills 270,271,273,274,276,277)', () => {
  assert.throws(() => loadPolicy({ ...basePolicy, rateLimit: { capacity: 0, refillPerSecond: 1 } }), /rateLimit\.capacity/);
  assert.throws(() => loadPolicy({ ...basePolicy, rateLimit: { capacity: 1, refillPerSecond: 0 } }), /rateLimit\.refillPerSecond/);
  assert.throws(() => loadPolicy({ ...basePolicy, globalRateLimit: { capacity: 0, refillPerSecond: 1 } }), /globalRateLimit\.capacity/);
  assert.throws(() => loadPolicy({ ...basePolicy, globalRateLimit: { capacity: 1, refillPerSecond: 0 } }), /globalRateLimit\.refillPerSecond/);
  assert.throws(() => loadPolicy({ ...basePolicy, ipRateLimit: { capacity: 0, refillPerSecond: 1 } }), /ipRateLimit\.capacity/);
  assert.throws(() => loadPolicy({ ...basePolicy, ipRateLimit: { capacity: 1, refillPerSecond: 0 } }), /ipRateLimit\.refillPerSecond/);
});

test('loadPolicy: normalizes network to "testnet" and rejects mainnet (kills 267)', () => {
  assert.equal(loadPolicy(basePolicy).network, 'testnet');
  assert.throws(() => loadPolicy({ ...basePolicy, network: 'mainnet' }), /network must be "testnet"/);
});

test('isTestnetId: exact regex boundaries — anchors, labels, max length (kills 0,1,3,4,5,6,11,12,13,14,15,16,17,18)', () => {
  const valid = [
    'a.testnet',
    'ab-cd.testnet', // two chars before a separator
    'a-b.testnet', // hyphen separator inside the first label
    'a_b.testnet', // underscore separator
    'a-b-c.testnet', // repeated separator groups
    'x.ab-c.testnet', // separator group in a non-first label
    'x.a-b.testnet', // hyphen inside a later label
    'x.ab.testnet', // label longer than one char
  ];
  for (const id of valid) assert.equal(isTestnetId(id), true, id);

  const invalid = [
    '\na.testnet', // leading newline: ^ anchor
    'a.testnet\n', // trailing newline: $ anchor
    'A-b.testnet', // uppercase is outside [a-z\d]
    'x.A-b.testnet', // uppercase inside a later label
    'a.AB.testnet', // uppercase in the final label
    'a.testnetx',
    '.testnet',
    'a..testnet',
    '-a.testnet',
    'a-.testnet',
    'a b.testnet',
  ];
  for (const id of invalid) assert.equal(isTestnetId(id), false, JSON.stringify(id));
});

test('isTestnetId: the 64-char cap is inclusive (kills 28,29)', () => {
  const id64 = `${'a'.repeat(64 - '.testnet'.length)}.testnet`;
  const id65 = `${'a'.repeat(65 - '.testnet'.length)}.testnet`;
  assert.equal(id64.length, 64);
  assert.equal(id65.length, 65);
  assert.equal(isTestnetId(id64), true);
  assert.equal(isTestnetId(id65), false);
});

test('isTestnetId: non-strings are rejected even if they stringify like a valid id (kills 23,24,25)', () => {
  const impostor = { length: 0, toString: () => 'a.testnet' };
  assert.equal(isTestnetId(impostor), false);
  assert.equal(isTestnetId(['a.testnet']), false);
  assert.equal(isTestnetId(undefined), false);
  assert.equal(isTestnetId(123), false);
});

test('isTestnetId property: generated valid ids accepted, corrupted variants rejected', () => {
  const rand = rng(0x5eed);
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  const pick = (s) => s[Math.floor(rand() * s.length)];
  const label = () => {
    const len = 1 + Math.floor(rand() * 6);
    let out = '';
    for (let i = 0; i < len; i++) out += pick(alphabet);
    return out;
  };
  const validId = () => {
    const labels = [label(), label()];
    if (rand() < 0.5) labels.splice(1, 0, `${label()}${pick('-_')}${label()}`);
    return `${labels.join('.')}.testnet`;
  };

  let checked = 0;
  for (let i = 0; i < 60; i++) {
    const id = validId();
    assert.equal(isTestnetId(id), true, id);
    // Corruption families: any one of these must invalidate the id.
    const corruptions = [
      id.toUpperCase(),
      id.replace('.testnet', '') + ' testnet',
      `x.${id}`.replace('x.', 'x..'),
      `${id}x`,
      ` ${id}`,
      id.replace('.testnet', '.mainnet'),
    ];
    for (const bad of corruptions) assert.equal(isTestnetId(bad), false, bad);
    checked += 1 + corruptions.length;
  }
  assert.ok(checked >= 60 * 7, 'property exercised a broad input set');
});

test('checkRpcUrl: default denies local hosts (kills 67)', () => {
  assert.throws(() => checkRpcUrl('http://127.0.0.1:3030'), /rpcUrl must be an https rpc url/);
  assert.throws(() => checkRpcUrl('https://localhost:3030'), /rpcUrl must be an https rpc url/);
  assert.equal(checkRpcUrl('https://rpc.testnet.near.org'), 'https://rpc.testnet.near.org');
});

test('checkRpcUrl: syntactically invalid URLs fail closed with the rpc message (kills 70,71)', () => {
  for (const bad of ['not a url', 'https://', '://missing-scheme', 'http://[::1']) {
    assert.throws(() => checkRpcUrl(bad), /rpcUrl is not a valid rpc url/, bad);
  }
});

test('checkRpcUrl: local hosts only for http(s) and only with allowLocalRpc (kills 86,91,92,93)', () => {
  assert.throws(() => checkRpcUrl('ftp://localhost:3030', { allowLocalRpc: true }), /rpcUrl must be an https rpc url/);
  assert.throws(() => checkRpcUrl('file:///etc/passwd', { allowLocalRpc: true }), /rpcUrl must be an https rpc url/);
  // Both schemes are permitted for local hosts, not just http.
  assert.equal(checkRpcUrl('http://localhost:3030', { allowLocalRpc: true }), 'http://localhost:3030');
  assert.equal(checkRpcUrl('https://localhost:3030', { allowLocalRpc: true }), 'https://localhost:3030');
  assert.equal(checkRpcUrl('https://127.0.0.1:3030', { allowLocalRpc: true }), 'https://127.0.0.1:3030');
});

test('checkRpcUrl property: exact host allowlist cannot be bypassed by suffix, scheme, port or userinfo', () => {
  const rand = rng(0xc0ffee);
  const paths = ['', '/', '/v1', '/rpc?x=1', '/a/b'];
  let checked = 0;
  for (const host of RPC_HOSTS) {
    for (const p of paths) {
      const url = `https://${host}:443${p}`;
      assert.equal(checkRpcUrl(url), url);
      checked++;
    }
    for (const bad of [
      `http://${host}/`,
      `https://${host}.evil.example/`,
      `https://evil.example/${host}`,
      `https://user:pw@${host}/`,
      `https://${host}@evil.example/`,
    ]) {
      assert.throws(() => checkRpcUrl(bad), /rpcUrl must be an https rpc url/, bad);
      checked++;
    }
  }
  assert.ok(checked >= RPC_HOSTS.length * 5);
  assert.ok(rand() < 1);
});

test('loadPolicy property: gas integers below the 60 Tgas floor are always rejected, at/above are accepted', () => {
  const rand = rng(0x9a5);
  let below = 0;
  let above = 0;
  const maxGas = 100_000_000_000_000n;
  for (let i = 0; i < 40; i++) {
    const delta = BigInt(Math.floor(rand() * 5_000_000_000_000));
    const low = MIN_GAS - 1n - delta;
    assert.throws(() => loadPolicy({ ...basePolicy, minGas: low.toString(), maxGas: maxGas.toString() }), /minGas/);
    below++;

    const high = MIN_GAS + delta;
    const policy = loadPolicy({ ...basePolicy, minGas: high.toString(), maxGas: maxGas.toString() });
    assert.equal(policy.minGas, high);
    assert.equal(policy.maxGas, maxGas);
    above++;
  }
  // A minGas above maxGas is rejected regardless of the floor.
  assert.throws(() => loadPolicy({ ...basePolicy, minGas: (maxGas + 1n).toString(), maxGas: maxGas.toString() }), /minGas must be <= maxGas/);
  assert.ok(below === 40 && above === 40, 'both sides of the boundary were exercised');
});
