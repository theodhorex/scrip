// Policy: strict, frozen, testnet-only configuration for the facilitator.
const TESTNET_ID = /^(?:[a-z\d]+[-_])*[a-z\d]+(?:\.(?:[a-z\d]+[-_])*[a-z\d]+)*\.testnet$/;

export const isTestnetId = (s) => typeof s === 'string' && s.length <= 64 && TESTNET_ID.test(s);

const fail = (msg) => {
  throw new Error(`invalid policy: ${msg}`);
};
const posInt = (v, name, min = 1) => {
  if (!Number.isSafeInteger(v) || v < min) fail(`${name} must be an integer >= ${min}`);
  return v;
};
const posNum = (v, name) => {
  if (typeof v !== 'number' || !Number.isFinite(v) || v <= 0) fail(`${name} must be a number > 0`);
  return v;
};

export const RPC_HOSTS = Object.freeze(['rpc.testnet.fastnear.com', 'test.rpc.fastnear.com', 'rpc.testnet.near.org', 'rpc.testnet.pagoda.co']);
const LOCAL_HOSTS = ['localhost', '127.0.0.1'];
export const MIN_GAS = 60_000_000_000_000n;

/** Exact host allowlist (F9). Local hosts (http or https) only with allowLocalRpc, for tests. */
export function checkRpcUrl(url, { allowLocalRpc = false } = {}) {
  let u;
  try {
    u = new URL(url);
  } catch {
    return fail('rpcUrl is not a valid rpc url');
  }
  const remoteOk = u.protocol === 'https:' && RPC_HOSTS.includes(u.hostname);
  const localOk = allowLocalRpc === true && (u.protocol === 'http:' || u.protocol === 'https:') && LOCAL_HOSTS.includes(u.hostname);
  if (!(remoteOk || localOk) || u.username || u.password) fail('rpcUrl must be an https rpc url on the testnet host allowlist');
  return url;
}

/** Validates and deep-freezes a policy object. Throws on any problem. */
export function loadPolicy(obj, { allowLocalRpc = false } = {}) {
  if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) fail('policy must be an object');
  if (obj.network !== 'testnet') fail('network must be "testnet" (testnet only)');
  if (!isTestnetId(obj.contractId)) fail('contractId must be a .testnet account id (testnet only)');

  if (!Array.isArray(obj.allowedMethods) || obj.allowedMethods.length === 0) fail('allowedMethods must be a non-empty array');
  for (const m of obj.allowedMethods) if (typeof m !== 'string' || !/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(m)) fail('bad method name');

  // Fail closed: an explicit, non-empty agent allowlist is mandatory.
  if (!Array.isArray(obj.allowedAgents) || obj.allowedAgents.length === 0) fail('allowedAgents must be a non-empty array of .testnet ids (required)');
  for (const a of obj.allowedAgents) if (!isTestnetId(a)) fail('allowedAgents entries must be .testnet account ids (testnet only)');
  const allowedAgents = Object.freeze([...obj.allowedAgents]);

  if (typeof obj.maxGas !== 'string' || !/^[1-9]\d*$/.test(obj.maxGas)) fail('maxGas must be a positive integer string');
  let minGas = MIN_GAS;
  if (obj.minGas !== undefined) {
    if (typeof obj.minGas !== 'string' || !/^[1-9]\d*$/.test(obj.minGas)) fail('minGas must be a positive integer string');
    minGas = BigInt(obj.minGas);
    if (minGas < MIN_GAS) fail('minGas must be >= 60000000000000 (60 Tgas)');
  }
  const maxGas = BigInt(obj.maxGas);
  if (minGas > maxGas) fail('minGas must be <= maxGas');
  const maxBlockHeightWindow = posInt(obj.maxBlockHeightWindow, 'maxBlockHeightWindow');
  const minBlockHeightMargin = posInt(obj.minBlockHeightMargin, 'minBlockHeightMargin', 0);
  if (minBlockHeightMargin >= maxBlockHeightWindow) fail('minBlockHeightMargin must be < maxBlockHeightWindow');

  const rl = obj.rateLimit;
  if (rl === null || typeof rl !== 'object') fail('rateLimit is required');
  const grl = obj.globalRateLimit ?? { capacity: 30, refillPerSecond: 0.5 };
  if (grl === null || typeof grl !== 'object') fail('globalRateLimit must be an object');

  const irl = obj.ipRateLimit ?? { capacity: 20, refillPerSecond: 1 };
  if (irl === null || typeof irl !== 'object') fail('ipRateLimit must be an object');
  const maxInFlight = obj.maxInFlightRelays === undefined ? 8 : posInt(obj.maxInFlightRelays, 'maxInFlightRelays');
  if (obj.trustProxy !== undefined && typeof obj.trustProxy !== 'boolean') fail('trustProxy must be a boolean');

  const policy = {
    network: 'testnet',
    contractId: obj.contractId,
    allowedMethods: Object.freeze([...obj.allowedMethods]),
    allowedAgents,
    minGas,
    maxGas,
    maxBlockHeightWindow,
    minBlockHeightMargin,
    rateLimit: Object.freeze({ capacity: posInt(rl.capacity, 'rateLimit.capacity'), refillPerSecond: posNum(rl.refillPerSecond, 'rateLimit.refillPerSecond') }),
    globalRateLimit: Object.freeze({ capacity: posInt(grl.capacity, 'globalRateLimit.capacity'), refillPerSecond: posNum(grl.refillPerSecond, 'globalRateLimit.refillPerSecond') }),
    ipRateLimit: Object.freeze({ capacity: posInt(irl.capacity, 'ipRateLimit.capacity'), refillPerSecond: posNum(irl.refillPerSecond, 'ipRateLimit.refillPerSecond') }),
    maxInFlightRelays: maxInFlight,
    trustProxy: obj.trustProxy === true,
  };
  if (obj.rpcUrl !== undefined) policy.rpcUrl = checkRpcUrl(obj.rpcUrl, { allowLocalRpc });
  return Object.freeze(policy);
}
