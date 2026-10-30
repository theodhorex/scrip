// Wires the real provider, relayer key (from a FILE) and policy. Not used by tests.
import { readFileSync } from 'node:fs';
import { Account, JsonRpcProvider, KeyPair, KeyPairSigner } from 'near-api-js';
import { loadPolicy, checkRpcUrl } from './policy.mjs';
import { createRateLimiter } from './ratelimit.mjs';
import { makeRelayer } from './relay.mjs';
import { createServer } from './server.mjs';

const need = (name) => {
  const v = process.env[name];
  if (!v) throw new Error(`missing env ${name}`);
  return v;
};

const policy = loadPolicy(JSON.parse(readFileSync(need('POLICY_FILE'), 'utf8')));
const rpcUrl = process.env.RPC_URL ?? policy.rpcUrl ?? 'https://rpc.testnet.fastnear.com';
checkRpcUrl(rpcUrl); // re-check the effective RPC url (exact host allowlist)

// Key file holds either "ed25519:..." or JSON with private_key. Never printed or logged.
const raw = readFileSync(need('RELAYER_KEY_FILE'), 'utf8').trim();
const keyString = raw.startsWith('{') ? JSON.parse(raw).private_key : raw;
const provider = new JsonRpcProvider({ url: rpcUrl });
const relayerAccount = new Account(need('RELAYER_ACCOUNT_ID'), provider, new KeyPairSigner(KeyPair.fromString(keyString)));

const limiter = createRateLimiter({ ...policy.rateLimit });
const globalLimiter = createRateLimiter({ ...policy.globalRateLimit, maxBuckets: 1 });
const relayer = makeRelayer({
  provider,
  relayerAccount,
  policy,
  limiter,
  globalLimiter,
  dbPath: process.env.DB_PATH ?? '.facilitator.db',
  minBalance: process.env.RELAYER_MIN_BALANCE ? BigInt(process.env.RELAYER_MIN_BALANCE) : undefined,
  relayerBalance: async () => {
    const a = await relayerAccount.getAccountBalance();
    return BigInt(a.available ?? 0);
  },
});
const ipLimiter = createRateLimiter({ ...policy.ipRateLimit });
const server = createServer({ relayer, ipLimiter, maxInFlight: policy.maxInFlightRelays, trustProxy: policy.trustProxy, log: (e) => console.log(JSON.stringify({ t: new Date().toISOString(), ...e })) });
const port = Number(process.env.PORT ?? 8787);
server.listen(port, () => console.log(`facilitator listening on :${port} (testnet, rpc ${new URL(rpcUrl).host})`));

const shutdown = (signal) => {
  console.log(JSON.stringify({ t: new Date().toISOString(), event: 'shutdown', signal }));
  server.close(() => {
    try { relayer.store.close(); } catch {}
    process.exit(0);
  });
  setTimeout(() => process.exit(1), 5000).unref();
};
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('SIGINT', () => shutdown('SIGINT'));
