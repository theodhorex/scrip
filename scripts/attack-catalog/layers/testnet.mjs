// Layer E (Testnet) Harness for Attack Catalog
// Strictly enforces safety rules:
// - Rate limited to <= 8 rps via Token-Bucket
// - Mode 0600 recovery file created BEFORE any account is created
// - Private keys loaded without printing or logging
// - Strict state verification before/after: BLOCKED cases with state mutation -> BREACH
// - Offline --dry mode with dynamic state simulation (prohibited from writing to results/)
// - Waves of <= 60 cases with partial result writes

import { readFileSync, writeFileSync, existsSync, unlinkSync, chmodSync, mkdirSync } from 'node:fs';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join, resolve, isAbsolute } from 'node:path';
import * as nearApi from 'near-api-js';

const {
  Account,
  JsonRpcProvider,
  KeyPair,
  KeyPairSigner,
  actions,
  buildDelegateAction,
  encodeSignedDelegate,
  nearToYocto,
  formatNearAmount,
} = nearApi;

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = resolve(HERE, '../../..');
const SCRIPTS_DIR = resolve(ROOT, 'scripts');
const DEFAULT_USDC = '3e2210e1184b45b64c8a434c0a7e7b23cc04ea7eb7a6c3c32520d03d4afcb8af';
const DEFAULT_WASM = join(ROOT, 'contracts/scrip/target/wasm32-unknown-unknown/release/scrip.wasm');
const T = (n) => BigInt(n) * 1_000_000_000_000n; // Tgas

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * Loads private key from file without printing or leaking secret material.
 * Follows gate.mjs pattern.
 */
export function keyOf(filePath) {
  const raw = readFileSync(filePath, 'utf8').trim();
  return raw.startsWith('{') ? JSON.parse(raw).private_key : raw;
}

/**
 * Checks if a given path falls inside the protected `results/` directory.
 */
export function isResultsPath(targetPath) {
  if (!targetPath) return false;
  const absTarget = resolve(process.cwd(), targetPath);
  const absResults = resolve(ROOT, 'results');
  return absTarget === absResults || absTarget.startsWith(absResults + '/');
}

/**
 * Token-Bucket rate limiter enforcing <= 8 rps.
 */
export class TokenBucketLimiter {
  constructor(options = {}) {
    this.capacity = options.capacity !== undefined ? options.capacity : 8;
    this.refillPerSecond = options.refillPerSecond !== undefined ? options.refillPerSecond : 8;
    this.now = typeof options.now === 'function' ? options.now : () => Date.now();
    this.sleepFn = typeof options.sleep === 'function' ? options.sleep : sleep;

    this.tokens = this.capacity;
    this.lastRefill = this.now();
  }

  _refill() {
    const current = this.now();
    const elapsed = Math.max(0, current - this.lastRefill);
    const added = elapsed * (this.refillPerSecond / 1000);
    this.tokens = Math.min(this.capacity, this.tokens + added);
    this.lastRefill = current;
  }

  async acquire() {
    while (true) {
      this._refill();
      if (this.tokens >= 1) {
        this.tokens -= 1;
        return;
      }
      const needed = 1 - this.tokens;
      const msNeeded = Math.max(1, Math.ceil(needed / (this.refillPerSecond / 1000)));
      await this.sleepFn(msNeeded);
    }
  }
}

/**
 * Compares mandate and recipient state before and after execution.
 * If a case was marked BLOCKED but state changed unexpectedly, flags BREACH.
 */
export function detectMandateBreach(before, after, expectedOrActualLabel) {
  if (!before || !after) {
    return { isBreach: false };
  }

  const spentDiff = BigInt(after.spent ?? '0') !== BigInt(before.spent ?? '0');
  const reservedDiff = BigInt(after.reserved ?? '0') !== BigInt(before.reserved ?? '0');
  const merchantDiff = (after.merchantBalance ?? 0n) > (before.merchantBalance ?? 0n);
  const statusDiff = before.status && after.status && before.status !== after.status;

  if (expectedOrActualLabel === 'BLOCKED') {
    if (spentDiff) {
      return {
        isBreach: true,
        reason: `Mandate spent changed on BLOCKED case: ${before.spent} -> ${after.spent}`,
      };
    }
    if (reservedDiff) {
      return {
        isBreach: true,
        reason: `Mandate reserved changed on BLOCKED case: ${before.reserved} -> ${after.reserved}`,
      };
    }
    if (merchantDiff) {
      return {
        isBreach: true,
        reason: `Merchant token balance (merchantBalance) increased on BLOCKED case: ${before.merchantBalance} -> ${after.merchantBalance}`,
      };
    }
    if (statusDiff && after.status !== 'Active') {
      return {
        isBreach: true,
        reason: `Mandate status changed on BLOCKED case: ${before.status} -> ${after.status}`,
      };
    }
  }

  return { isBreach: false };
}

/**
 * Creates dynamic in-memory testnet mock provider & accounts for --dry mode.
 * Satisfies rule: "Tidak ada mode mock yang mengeluarkan angka tetap."
 */
export function createMockTestnetEngine(funderId) {
  const accounts = new Map();
  const balances = new Map(); // id -> yoctoNEAR
  const ftBalances = new Map(); // id -> bigint USDC
  const mandates = new Map(); // id -> mandate object
  let mandateCounter = 0;
  let txNonce = 1000;

  balances.set(funderId, nearToYocto('10'));
  ftBalances.set(funderId, 10_000_000n);

  return {
    accounts,
    balances,
    ftBalances,
    mandates,
    async viewAccount({ accountId }) {
      if (!accounts.has(accountId) && accountId !== funderId) {
        throw new Error(`Account ${accountId} does not exist`);
      }
      return {
        amount: (balances.get(accountId) ?? nearToYocto('1')).toString(),
      };
    },
    async viewBlock() {
      return { header: { height: 2000, hash: 'MOCK_BLOCK_HASH' } };
    },
    async viewAccessKey() {
      return { nonce: 0n, permission: 'FullAccess' };
    },
    async callFunction({ contractId, method, args }) {
      if (method === 'ft_balance_of') {
        const id = args.account_id;
        return (ftBalances.get(id) ?? 0n).toString();
      }
      if (method === 'get_mandate') {
        const m = mandates.get(Number(args.id));
        if (!m) return null;
        return {
          id: m.id,
          owner: m.owner,
          agent: m.agent,
          guardian: m.guardian,
          token: m.token,
          budget: m.budget.toString(),
          per_payment_cap: m.per_payment_cap.toString(),
          deposited: m.deposited.toString(),
          spent: m.spent.toString(),
          reserved: m.reserved.toString(),
          withdrawn: m.withdrawn.toString(),
          status: m.status,
          recipients: [...m.recipients],
        };
      }
      return null;
    },
    async callFunctionRaw({ contractId, methodName, args, deposit, senderId }) {
      txNonce++;
      const hash = `TX_MOCK_${txNonce}_${methodName}`;

      if (methodName === 'new') {
        return { transaction: { hash }, status: { SuccessValue: '' } };
      }
      if (methodName === 'storage_deposit') {
        return { transaction: { hash }, status: { SuccessValue: '' } };
      }
      if (methodName === 'create_mandate') {
        mandateCounter++;
        const id = mandateCounter;
        mandates.set(id, {
          id,
          owner: senderId || funderId,
          agent: args.agent,
          guardian: args.guardian,
          token: args.token,
          budget: BigInt(args.budget),
          per_payment_cap: BigInt(args.per_payment_cap),
          deposited: 0n,
          spent: 0n,
          reserved: 0n,
          withdrawn: 0n,
          status: 'Active',
          recipients: args.recipients || [],
        });
        const val = Buffer.from(JSON.stringify(id)).toString('base64');
        return { transaction: { hash }, status: { SuccessValue: val } };
      }
      if (methodName === 'ft_transfer_call') {
        const receiver = args.receiver_id;
        const amount = BigInt(args.amount);
        const parsed = JSON.parse(args.msg || '{}');
        const mid = Number(parsed.mandate_id);
        const m = mandates.get(mid);
        if (m) {
          m.deposited += amount;
          const funderBal = ftBalances.get(funderId) ?? 0n;
          ftBalances.set(funderId, funderBal > amount ? funderBal - amount : 0n);
          const cBal = ftBalances.get(receiver) ?? 0n;
          ftBalances.set(receiver, cBal + amount);
        }
        return { transaction: { hash }, status: { SuccessValue: '' } };
      }
      if (methodName === 'revoke') {
        const m = mandates.get(Number(args.mandate_id));
        if (m) m.status = 'Revoked';
        return { transaction: { hash }, status: { SuccessValue: '' } };
      }
      if (methodName === 'withdraw') {
        const m = mandates.get(Number(args.mandate_id));
        const amount = BigInt(args.amount);
        if (m) {
          m.withdrawn += amount;
          const fBal = ftBalances.get(funderId) ?? 0n;
          ftBalances.set(funderId, fBal + amount);
          const cBal = ftBalances.get(contractId) ?? 0n;
          ftBalances.set(contractId, cBal > amount ? cBal - amount : 0n);
        }
        return { transaction: { hash }, status: { SuccessValue: '' } };
      }
      if (methodName === 'ft_transfer') {
        const receiver = args.receiver_id;
        const amount = BigInt(args.amount);
        const fromBal = ftBalances.get(senderId) ?? 0n;
        ftBalances.set(senderId, fromBal > amount ? fromBal - amount : 0n);
        const toBal = ftBalances.get(receiver) ?? 0n;
        ftBalances.set(receiver, toBal + amount);
        return { transaction: { hash }, status: { SuccessValue: '' } };
      }

      return { transaction: { hash }, status: { SuccessValue: '' } };
    },
    async createSubAccount({ accountOrPrefix, nearToTransfer, key }) {
      accounts.set(accountOrPrefix, key);
      balances.set(accountOrPrefix, nearToTransfer);
      return { transaction: { hash: `TX_MOCK_MK_${accountOrPrefix}` } };
    },
    async deleteAccount(accountId, beneficiaryId) {
      accounts.delete(accountId);
      const rem = balances.get(accountId) ?? 0n;
      balances.delete(accountId);
      const ben = balances.get(beneficiaryId) ?? 0n;
      balances.set(beneficiaryId, ben + rem);
      return { transaction: { hash: `TX_MOCK_DEL_${accountId}` } };
    },
  };
}

/**
 * Initializes a Testnet execution session.
 *
 * @param {object} [opts]
 * @param {boolean} [opts.dry] - Dry run mode without network access
 * @param {number} [opts.mandatesCount=40] - Number of mandates to initialize
 * @param {string} [opts.rpcUrl]
 * @param {string} [opts.funderId]
 * @param {string} [opts.relayerId]
 * @param {string} [opts.recoveryDir]
 * @returns {Promise<object>} Session controller
 */
export async function createTestnetSession(opts = {}) {
  const dry = Boolean(opts.dry);
  const mandatesCount = typeof opts.mandatesCount === 'number' && opts.mandatesCount > 0
    ? opts.mandatesCount
    : 40;

  const rpcUrl = opts.rpcUrl ?? process.env.RPC_URL ?? 'https://rpc.testnet.fastnear.com';
  const funderId = opts.funderId ?? process.env.FUNDER_ID ?? 'envtest-theo-1747.testnet';
  const relayerId = opts.relayerId ?? process.env.RELAYER_ID ?? 'relayer-theo-1747.testnet';
  const keyDir = opts.keyDir ?? process.env.KEY_DIR ?? '/home/theo/Documents/dev/hackathon/NEAR';
  const funderKeyFile = opts.funderKeyFile ?? process.env.FUNDER_KEY_FILE ?? join(keyDir, 'priv_key.txt');
  const relayerKeyFile = opts.relayerKeyFile ?? process.env.RELAYER_KEY_FILE ?? join(keyDir, 'priv_key_relayer.txt');
  const usdc = opts.usdcContractId ?? DEFAULT_USDC;
  const wasmPath = opts.wasmPath ?? DEFAULT_WASM;
  const recoveryDir = opts.recoveryDir ?? SCRIPTS_DIR;
  const port = opts.port ?? (8792 + (Math.floor(Math.random() * 500)));

  if (!dry) {
    if (!funderId.endsWith('.testnet') || !relayerId.endsWith('.testnet')) {
      throw new Error('Testnet only: funder and relayer must end with .testnet');
    }
  }

  const ts = Date.now() % 1000000;
  const idPrefix = (p) => `${p}${ts}.${funderId}`;
  const contractId = idPrefix('amce');
  const merchantId = idPrefix('amme');

  const createdAccounts = [];
  const agentKeyPairs = [];
  const guardianKeyPairs = [];
  const agentFcKeyPairs = [];

  const contractKey = KeyPair.fromRandom('ed25519');
  const merchantKey = KeyPair.fromRandom('ed25519');

  createdAccounts.push({ id: contractId, key: contractKey });
  createdAccounts.push({ id: merchantId, key: merchantKey });

  for (let i = 0; i < mandatesCount; i++) {
    const aKey = KeyPair.fromRandom('ed25519');
    const gKey = KeyPair.fromRandom('ed25519');
    const fcKey = KeyPair.fromRandom('ed25519');
    const aId = `${idPrefix(`ama${i}_`)}`;
    const gId = `${idPrefix(`amg${i}_`)}`;

    agentKeyPairs.push({ id: aId, key: aKey, fcKey });
    guardianKeyPairs.push({ id: gId, key: gKey });
    createdAccounts.push({ id: aId, key: aKey });
    createdAccounts.push({ id: gId, key: gKey });
  }

  // ATURAN KERAS: Recovery file created BEFORE any account exists (mode 0600)
  mkdirSync(recoveryDir, { recursive: true });
  const recoveryFile = join(recoveryDir, `.recovery-catalog-${ts}.json`);
  const recoveryPayload = JSON.stringify({
    accounts: createdAccounts.map((a) => ({
      id: a.id,
      key: a.key.toString(),
    })),
  });
  writeFileSync(recoveryFile, recoveryPayload, { mode: 0o600 });
  chmodSync(recoveryFile, 0o600);

  let provider;
  let funderAcc;
  let mockEngine = null;

  if (dry) {
    mockEngine = createMockTestnetEngine(funderId);
    provider = {
      viewAccount: (a) => mockEngine.viewAccount(a),
      viewBlock: (a) => mockEngine.viewBlock(a),
      viewAccessKey: (a) => mockEngine.viewAccessKey(a),
      callFunction: (a) => mockEngine.callFunction(a),
    };
    funderAcc = {
      accountId: funderId,
      createSubAccount: async ({ accountOrPrefix, nearToTransfer, publicKey }) => {
        return mockEngine.createSubAccount({ accountOrPrefix, nearToTransfer, key: publicKey });
      },
      callFunctionRaw: async ({ contractId, methodName, args, gas, deposit }) => {
        return mockEngine.callFunctionRaw({ contractId, methodName, args, deposit, senderId: funderId });
      },
    };
  } else {
    // Real testnet initialization
    provider = new JsonRpcProvider({ url: rpcUrl });
    const funderSigner = new KeyPairSigner(KeyPair.fromString(keyOf(funderKeyFile)));
    funderAcc = new Account(funderId, provider, funderSigner);
  }

  const mandates = [];
  let facilitatorProcess = null;
  let policyFileForCleanup = null;
  const limiter = opts.limiter || new TokenBucketLimiter({
    capacity: opts.rateLimitCapacity !== undefined ? opts.rateLimitCapacity : 8,
    refillPerSecond: opts.rateLimitRps !== undefined ? opts.rateLimitRps : 8,
  });

  // Session object construction
  const session = {
    isDry: dry,
    contractId,
    merchantId,
    funderId,
    relayerId,
    recoveryFile,
    mandates,
    limiter,
    provider,
    funderAcc,
    createdAccounts,
    agentKeyPairs,
    guardianKeyPairs,
    port,
    mockEngine,
    closed: false,

    async viewMandate(id) {
      if (dry) {
        return mockEngine.callFunction({ contractId, method: 'get_mandate', args: { id } });
      }
      try {
        return await provider.callFunction({ contractId, method: 'get_mandate', args: { id } });
      } catch {
        return null;
      }
    },

    async viewFtBalance(accountId) {
      if (dry) {
        const balStr = await mockEngine.callFunction({ contractId: usdc, method: 'ft_balance_of', args: { account_id: accountId } });
        return BigInt(balStr || '0');
      }
      try {
        const res = await provider.callFunction({ contractId: usdc, method: 'ft_balance_of', args: { account_id: accountId } });
        return BigInt(res || '0');
      } catch {
        return 0n;
      }
    },

    getAgent(indexOrId) {
      if (typeof indexOrId === 'number') {
        return agentKeyPairs[indexOrId % agentKeyPairs.length];
      }
      return agentKeyPairs.find((a) => a.id === indexOrId) || agentKeyPairs[0];
    },

    async closeSession() {
      if (session.closed) return { clean: true, leftoverAccounts: [] };
      session.closed = true;

      // 1. Kill facilitator if started
      if (facilitatorProcess && facilitatorProcess.pid) {
        try {
          process.kill(facilitatorProcess.pid, 'SIGTERM');
        } catch {}
      }
      if (policyFileForCleanup && existsSync(policyFileForCleanup)) {
        try { unlinkSync(policyFileForCleanup); } catch {}
      }

      let clean = true;

      // 2. Revoke and withdraw all mandates
      for (const m of session.mandates) {
        try {
          if (dry) {
            await mockEngine.callFunctionRaw({
              contractId,
              methodName: 'revoke',
              args: { mandate_id: m.id },
              deposit: 0n,
            });
            const s = await mockEngine.callFunction({ contractId, method: 'get_mandate', args: { id: m.id } });
            const free = BigInt(s.deposited) - BigInt(s.spent) - BigInt(s.reserved) - BigInt(s.withdrawn);
            if (free > 0n) {
              await mockEngine.callFunctionRaw({
                contractId,
                methodName: 'withdraw',
                args: { mandate_id: m.id, amount: free.toString() },
                deposit: 0n,
              });
            }
          } else {
            await funderAcc.callFunctionRaw({
              contractId,
              methodName: 'revoke',
              args: { mandate_id: m.id },
              gas: T(30),
              deposit: 0n,
            });
            const s = await session.viewMandate(m.id);
            if (s) {
              const free = BigInt(s.deposited) - BigInt(s.spent) - BigInt(s.reserved) - BigInt(s.withdrawn);
              if (free > 0n) {
                await funderAcc.callFunctionRaw({
                  contractId,
                  methodName: 'withdraw',
                  args: { mandate_id: m.id, amount: free.toString() },
                  gas: T(100),
                  deposit: 0n,
                });
              }
            }
          }
        } catch (e) {
          clean = false;
        }
      }

      // 3. Sweep USDC balances to funder
      for (const a of createdAccounts) {
        try {
          const bal = await session.viewFtBalance(a.id);
          if (bal > 0n) {
            if (dry) {
              await mockEngine.callFunctionRaw({
                contractId: usdc,
                methodName: 'ft_transfer',
                args: { receiver_id: funderId, amount: bal.toString() },
                deposit: 1n,
                senderId: a.id,
              });
            } else {
              const acct = new Account(a.id, provider, new KeyPairSigner(a.key));
              await acct.callFunctionRaw({
                contractId: usdc,
                methodName: 'ft_transfer',
                args: { receiver_id: funderId, amount: bal.toString() },
                gas: T(50),
                deposit: 1n,
              });
            }
          }
        } catch (e) {
          clean = false;
        }
      }

      // 4. Delete accounts with funder as beneficiary
      for (const a of createdAccounts) {
        try {
          if (dry) {
            await mockEngine.deleteAccount(a.id, funderId);
          } else {
            const acct = new Account(a.id, provider, new KeyPairSigner(a.key));
            await acct.deleteAccount(funderId);
          }
        } catch (e) {
          clean = false;
        }
      }

      // 5. Verify leftover accounts
      const leftoverAccounts = [];
      for (const a of createdAccounts) {
        try {
          if (dry) {
            await mockEngine.viewAccount({ accountId: a.id });
            leftoverAccounts.push(a.id);
          } else {
            await provider.viewAccount({ accountId: a.id });
            leftoverAccounts.push(a.id);
          }
        } catch {
          // Account confirmed deleted
        }
      }

      // 6. Delete recovery file only if clean and leftover is []
      if (clean && leftoverAccounts.length === 0 && existsSync(recoveryFile)) {
        try {
          unlinkSync(recoveryFile);
        } catch {}
      }

      return {
        clean: clean && leftoverAccounts.length === 0,
        leftoverAccounts,
      };
    },
  };

  try {
    // Account creation on chain / mock
    if (dry) {
      await mockEngine.createSubAccount({ accountOrPrefix: contractId, nearToTransfer: nearToYocto('3.5'), publicKey: contractKey.getPublicKey() });
      await mockEngine.createSubAccount({ accountOrPrefix: merchantId, nearToTransfer: nearToYocto('0.15'), publicKey: merchantKey.getPublicKey() });
      for (let i = 0; i < mandatesCount; i++) {
        const ag = agentKeyPairs[i];
        const gu = guardianKeyPairs[i];
        await mockEngine.createSubAccount({ accountOrPrefix: ag.id, nearToTransfer: nearToYocto('0.05'), publicKey: ag.key.getPublicKey() });
        await mockEngine.createSubAccount({ accountOrPrefix: gu.id, nearToTransfer: nearToYocto('0.05'), publicKey: gu.key.getPublicKey() });
      }

      // Initialize contract
      await mockEngine.callFunctionRaw({ contractId, methodName: 'new', args: {}, deposit: 0n, senderId: funderId });

      // USDC storage deposit
      await mockEngine.callFunctionRaw({ contractId: usdc, methodName: 'storage_deposit', args: { account_id: contractId }, deposit: 0n });
      await mockEngine.callFunctionRaw({ contractId: usdc, methodName: 'storage_deposit', args: { account_id: merchantId }, deposit: 0n });

      // Create and fund mandates
      for (let i = 0; i < mandatesCount; i++) {
        const ag = agentKeyPairs[i];
        const gu = guardianKeyPairs[i];
        const cmRes = await mockEngine.callFunctionRaw({
          contractId,
          methodName: 'create_mandate',
          args: {
            agent: ag.id,
            guardian: gu.id,
            token: usdc,
            budget: '1250000',
            per_payment_cap: '500000',
            approval_threshold: '500000',
            recipients: [merchantId],
            expires_at_ms: Date.now() + 3600 * 1000,
          },
          deposit: nearToYocto('0.05'),
          senderId: funderId,
        });
        const mid = JSON.parse(Buffer.from(cmRes.status.SuccessValue, 'base64').toString());

        // Fund mandate via ft_transfer_call
        await mockEngine.callFunctionRaw({
          contractId: usdc,
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: contractId,
            amount: '1250000',
            msg: JSON.stringify({ mandate_id: mid }),
          },
          deposit: 1n,
          senderId: funderId,
        });

        mandates.push({
          id: mid,
          agentId: ag.id,
          guardianId: gu.id,
          merchantId,
          budget: '1250000',
        });
      }
    } else {
      // Real testnet creation
      const mk = async (acct, key, near_) => {
        await funderAcc.createSubAccount({
          accountOrPrefix: acct,
          publicKey: key.getPublicKey().toString(),
          nearToTransfer: nearToYocto(near_),
        });
        await sleep(400);
      };

      await mk(contractId, contractKey, '3.5');
      await mk(merchantId, merchantKey, '0.15');
      for (let i = 0; i < mandatesCount; i++) {
        await mk(agentKeyPairs[i].id, agentKeyPairs[i].key, '0.05');
        await mk(guardianKeyPairs[i].id, guardianKeyPairs[i].key, '0.05');
      }

      // Deploy WASM & init
      const wasmBytes = readFileSync(wasmPath);
      const contractAcc = new Account(contractId, provider, new KeyPairSigner(contractKey));
      await contractAcc.deployContract(wasmBytes);
      await funderAcc.callFunctionRaw({
        contractId,
        methodName: 'new',
        args: {},
        gas: T(30),
        deposit: 0n,
      });

      // Storage deposits for USDC
      for (const who of [contractId, merchantId]) {
        await funderAcc.callFunctionRaw({
          contractId: usdc,
          methodName: 'storage_deposit',
          args: { account_id: who, registration_only: true },
          gas: T(30),
          deposit: nearToYocto('0.00125'),
        });
        await sleep(300);
      }

      // Create mandates & add FC keys
      for (let i = 0; i < mandatesCount; i++) {
        const ag = agentKeyPairs[i];
        const gu = guardianKeyPairs[i];
        const cm = await funderAcc.callFunctionRaw({
          contractId,
          methodName: 'create_mandate',
          gas: T(60),
          deposit: nearToYocto('0.05'),
          args: {
            agent: ag.id,
            guardian: gu.id,
            token: usdc,
            budget: '1250000',
            per_payment_cap: '500000',
            approval_threshold: '500000',
            recipients: [merchantId],
            expires_at_ms: Date.now() + 2 * 3600 * 1000,
          },
        });
        const mid = JSON.parse(Buffer.from(cm.status.SuccessValue, 'base64').toString());

        // Fund with USDC
        await funderAcc.callFunctionRaw({
          contractId: usdc,
          methodName: 'ft_transfer_call',
          args: {
            receiver_id: contractId,
            amount: '1250000',
            msg: JSON.stringify({ mandate_id: mid }),
          },
          gas: T(100),
          deposit: 1n,
        });

        // Add FC key to agent account
        const agentAdmin = new Account(ag.id, provider, new KeyPairSigner(ag.key));
        await agentAdmin.addFunctionCallAccessKey({
          publicKey: ag.fcKey.getPublicKey(),
          contractId,
          methodNames: ['request_payment'],
          allowance: nearToYocto('0.25'),
        });

        mandates.push({
          id: mid,
          agentId: ag.id,
          guardianId: gu.id,
          merchantId,
          budget: '1250000',
        });
        await sleep(300);
      }

      // Start local facilitator against testnet RPC
      policyFileForCleanup = join(SCRIPTS_DIR, `.policy-catalog-${ts}.json`);
      writeFileSync(policyFileForCleanup, JSON.stringify({
        network: 'testnet',
        contractId,
        allowedMethods: ['request_payment'],
        allowedAgents: agentKeyPairs.map((a) => a.id),
        maxGas: '150000000000000',
        maxBlockHeightWindow: 300,
        minBlockHeightMargin: 5,
        rateLimit: { capacity: 8, refillPerSecond: 8 },
        rpcUrl,
      }));

      facilitatorProcess = spawn('node', [join(ROOT, 'facilitator/src/main.mjs')], {
        env: {
          ...process.env,
          POLICY_FILE: policyFileForCleanup,
          RELAYER_ACCOUNT_ID: relayerId,
          RELAYER_KEY_FILE: relayerKeyFile,
          PORT: String(port),
          RPC_URL: rpcUrl,
        },
        stdio: ['ignore', 'pipe', 'pipe'],
      });

      // Wait for health
      let up = false;
      for (let i = 0; i < 30; i++) {
        try {
          const res = await fetch(`http://127.0.0.1:${port}/health`);
          if (res.status === 200) {
            up = true;
            break;
          }
        } catch {}
        await sleep(300);
      }
      if (!up) {
        throw new Error('Local facilitator failed to start');
      }
    }
  } catch (err) {
    // If creation fails midway, ensure cleanup is invoked immediately
    await session.closeSession();
    throw err;
  }

  return session;
}

/**
 * Executes a single Attack Case under Layer E (Testnet).
 *
 * @param {object} c - Case definition
 * @param {object} session - Testnet session controller
 * @returns {Promise<{label: string, code?: string, txHash?: string, note?: string}>}
 */
export async function executeLayerE(c, session) {
  if (!session) {
    throw new Error('Session is required for executeLayerE');
  }

  // Token-bucket limiter: rate <= 8 rps
  await session.limiter.acquire();

  // Catalog cases name the legitimate recipient with the literal placeholder 'merchant.testnet'. On the real
  // testnet the mandates allowlist the session's own merchant account, so map ONLY that exact string to it
  // (lookalikes such as ' merchant.testnet ' or 'shop.merchant.testnet' stay as they are: they are attacks).
  if (c.params && session.merchantId) {
    const subst = (v) => {
      if (v === 'merchant.testnet') return session.merchantId;
      if (Array.isArray(v)) return v.map(subst);
      if (v && Object.getPrototypeOf(v) === Object.prototype) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, subst(x)]));
      return v;
    };
    c = { ...c, params: subst(c.params) };
  }

  // Category 2 (payment amounts/budget) cases are independent single payments, each written against a FRESH
  // mandate (budget 1250000). Sharing mandate 1 let earlier cases spend its budget, so later INERT expectations
  // hit OVER_BUDGET (wave 1: KAT-E-02-13/14/57). Give each such case its own mandate, by id suffix.
  if (String(c.category) === '2' && c.params && c.params.mandate_id === 1 && session.mandates.length > 1) {
    const n = Number(/(\d+)$/.exec(String(c.id))?.[1]);
    if (Number.isInteger(n) && n > 0) {
      const idx = (n - 1) % session.mandates.length;
      const own = session.mandates[idx].id;
      c = {
        ...c,
        params: {
          ...c.params,
          mandate_id: own,
          // each mandate has its own agent (and function-call key): sign with the owner of this mandate
          agentIndex: c.params.agentIndex ?? idx,
          ...(c.params.args && typeof c.params.args === 'object' ? { args: { ...c.params.args, mandate_id: own } } : {}),
        },
      };
    }
  }

  const mandateId = c.params?.mandate_id ?? session.mandates[0]?.id ?? 1;
  const targetRecipient = c.params?.recipient || session.merchantId;

  // Snapshot before
  const beforeMandate = await session.viewMandate(mandateId);
  const beforeMerchBal = await session.viewFtBalance(targetRecipient);
  const stateBefore = beforeMandate ? {
    ...beforeMandate,
    merchantBalance: beforeMerchBal,
  } : null;

  let actual;

  if (session.isDry) {
    // Simulated mock execution
    let txHash = `TX_E_DRY_${c.id}_${Date.now()}`;
    const p = c.params || {};

    if (p.invalidSignature || p.forgedKey) {
      actual = {
        label: 'BLOCKED',
        code: 'INVALID_SIGNATURE',
        txHash,
        note: 'Mock: signature verification rejected',
      };
    } else if (p.recipientNotAllowed || (p.recipient && p.recipient !== session.merchantId)) {
      actual = {
        label: 'BLOCKED',
        code: 'RECIPIENT_NOT_ALLOWED',
        txHash,
        note: 'Mock: recipient not in mandate allowlist',
      };
    } else if (p.overCap || (p.amount && BigInt(p.amount) > 500_000n)) {
      actual = {
        label: 'BLOCKED',
        code: 'AMOUNT_EXCEEDS_CAP',
        txHash,
        note: 'Mock: requested amount exceeds per-payment cap',
      };
    } else if (p.lowGas || (p.gas && BigInt(p.gas) < 60_000_000_000_000n)) {
      actual = {
        label: 'BLOCKED',
        code: 'GAS_BELOW_MINIMUM',
        txHash,
        note: 'Mock: gas below 60 Tgas',
      };
    } else if (p.expiredMandate) {
      actual = {
        label: 'BLOCKED',
        code: 'MANDATE_EXPIRED',
        txHash,
        note: 'Mock: mandate expired',
      };
    } else if (p.simulateBreach) {
      // Simulated breach: mutates state unexpectedly
      const m = session.mockEngine.mandates.get(mandateId);
      if (m) m.spent += 100_000n;
      actual = {
        label: 'BLOCKED', // claimed blocked, but mutated state
        code: 'REJECTED_UNKNOWN',
        txHash,
        note: 'Simulated breach with mutated state',
      };
    } else {
      actual = {
        label: c.expected?.label || 'INERT',
        code: c.expected?.code,
        txHash,
        note: `Mock Layer E execution for ${c.id}`,
      };
    }
  } else {
    // Real Testnet execution via Facilitator / RPC
    const port = session.port;
    const url = `http://127.0.0.1:${port}/relay`;
    const agent = session.getAgent(c.params?.agentIndex ?? 0);

    let txHash = null;

    try {
      if (c.params?.transport === 'rpc') {
        // Direct RPC transmission without facilitator
        const contractAcc = new Account(session.contractId, session.provider, new KeyPairSigner(agent.key));
        const res = await contractAcc.callFunctionRaw({
          contractId: session.contractId,
          methodName: c.params.method || 'request_payment',
          args: c.params.args || {},
          gas: c.params.gas ? BigInt(c.params.gas) : T(60),
          deposit: c.params.deposit ? BigInt(c.params.deposit) : 0n,
        });
        txHash = res.transaction?.hash;
        actual = {
          label: 'INERT',
          txHash,
          note: `RPC tx executed: ${txHash}`,
        };
      } else {
        // Facilitator /relay transmission
        let b64;
        if (c.params?.signed_delegate) {
          b64 = c.params.signed_delegate;
        } else {
          const signerKey = c.params?.forgedKey ? KeyPair.fromRandom('ed25519') : agent.fcKey;
          const signer = new KeyPairSigner(signerKey);
          const head = await session.provider.viewBlock({ finality: 'optimistic' });
          const delegateSender = c.params?.senderId || agent.id;
          const delegatePub = await signer.getPublicKey();
          // NEAR access-key nonces are block-height based, so a literal nonce of 1 is always NONCE_TOO_LOW.
          // Unless the case sets a nonce on purpose (nonce attacks), use the key's on-chain nonce + 1.
          let delegateNonce;
          if (c.params?.nonce !== undefined) {
            delegateNonce = BigInt(c.params.nonce);
          } else {
            let onChain = 0n;
            try {
              const k = await session.provider.viewAccessKey({
                accountId: delegateSender,
                publicKey: delegatePub.toString(),
              });
              onChain = BigInt(k?.nonce ?? 0);
            } catch {
              onChain = 0n; // missing key (forged/unknown): the facilitator rejects it for another reason
            }
            delegateNonce = onChain + 1n;
          }
          const delegate = buildDelegateAction({
            senderId: delegateSender,
            receiverId: session.contractId,
            nonce: delegateNonce,
            maxBlockHeight: BigInt(head.header.height) + 100n,
            publicKey: await signer.getPublicKey(),
            actions: [
              actions.functionCall(
                c.params?.method || 'request_payment',
                c.params?.args || {
                  mandate_id: mandateId,
                  recipient: targetRecipient,
                  amount: c.params?.amount || '100000',
                  nonce: c.params?.paymentNonce || 1,
                },
                c.params?.gas ? BigInt(c.params.gas) : T(100),
                0n
              ),
            ],
          });
          const signed = await signer.signDelegateAction(delegate);
          b64 = Buffer.from(encodeSignedDelegate(signed.signedDelegate)).toString('base64');
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ signed_delegate: b64 }),
        });

        const status = res.status;
        const json = await res.json().catch(() => null);
        txHash = json?.tx_hash;

        if (status >= 400) {
          actual = {
            label: 'BLOCKED',
            code: json?.code || json?.invalidReason || `HTTP_${status}`,
            txHash,
            note: json?.message || `HTTP ${status}`,
          };
        } else if (txHash) {
          // Read transaction events without retries on failure (tanpa retry untuk TX_FAILED)
          const txRes = await session.provider.sendJsonRpc('tx', [txHash, session.relayerId]);
          const logs = txRes?.receipts_outcome?.flatMap((o) => o.outcome.logs) || [];
          const rejectedEvent = logs
            .filter((l) => l.startsWith('EVENT_JSON:'))
            .map((l) => {
              try { return JSON.parse(l.slice(11)); } catch { return null; }
            })
            .find((e) => e && e.event === 'rejected');
          const errLog = logs.find((l) => l.startsWith('SCRIP_ERR:'));

          if (rejectedEvent) {
            const code = rejectedEvent.data?.[0]?.code || 'REJECTED';
            actual = {
              label: 'BLOCKED',
              code: String(code),
              txHash,
              note: `Contract rejected: ${code}`,
            };
          } else if (errLog) {
            const code = errLog.slice('SCRIP_ERR:'.length).trim();
            actual = {
              label: 'BLOCKED',
              code,
              txHash,
              note: `SCRIP_ERR: ${code}`,
            };
          } else {
            actual = {
              label: 'INERT',
              txHash,
              note: `Transaction confirmed on chain: ${txHash}`,
            };
          }
        } else {
          actual = {
            label: 'INERT',
            note: `Relayed with status ${status}`,
          };
        }
      }
    } catch (err) {
      actual = {
        label: 'BLOCKED',
        code: 'TX_FAILED',
        txHash,
        note: `Transaction failed: ${err.message}`,
      };
    }
  }

  // Snapshot after & state breach verification
  const afterMandate = await session.viewMandate(mandateId);
  const afterMerchBal = await session.viewFtBalance(targetRecipient);
  const stateAfter = afterMandate ? {
    ...afterMandate,
    merchantBalance: afterMerchBal,
  } : null;

  if (stateBefore && stateAfter) {
    const breachCheck = detectMandateBreach(stateBefore, stateAfter, actual.label);
    if (breachCheck.isBreach) {
      actual = {
        label: 'BREACH',
        code: 'UNAUTHORIZED_STATE_MUTATION',
        txHash: actual.txHash,
        note: breachCheck.reason,
      };
    }
  }

  return actual;
}

/**
 * Runs Layer E cases in batches/waves of <= 60 cases.
 * Writes partial results after each wave to prevent progress loss from timeouts.
 *
 * @param {Array<object>} cases
 * @param {object} session
 * @param {object} [options]
 * @param {number} [options.waveSize=50] - Maximum 60
 * @param {string} [options.partialOutPath] - Destination file for partial results
 * @param {Function} [options.onWaveComplete] - Callback on wave finish
 * @returns {Promise<{results: Array<object>, summary: object}>}
 */
export async function runLayerEInWaves(cases, session, options = {}) {
  const waveSize = Math.min(Number(options.waveSize || 50), 60);
  const partialOutPath = options.partialOutPath;

  // Strict rule: Dry mode is NOT permitted to write to results/
  if (session.isDry && partialOutPath && isResultsPath(partialOutPath)) {
    throw new Error('ATURAN KERAS: Mode dry TIDAK boleh dipakai untuk menulis ke results/');
  }

  const allResults = [];
  const totalWaves = Math.ceil(cases.length / waveSize);

  for (let waveIndex = 0; waveIndex < totalWaves; waveIndex++) {
    const start = waveIndex * waveSize;
    const end = Math.min(start + waveSize, cases.length);
    const waveSlice = cases.slice(start, end);

    const waveResults = [];
    for (const c of waveSlice) {
      const evaluated = {
        ...c,
        params: { ...c.params },
        expected: { ...c.expected },
      };

      try {
        const actual = await executeLayerE(c, session);
        evaluated.actual = actual;

        if (actual.label === 'BREACH') {
          evaluated.verdict = 'BREACH';
        } else if (actual.label === c.expected.label) {
          if (c.expected.code !== undefined && c.expected.code !== null) {
            evaluated.verdict = actual.code === c.expected.code ? 'PASS' : 'FAIL';
          } else {
            evaluated.verdict = 'PASS';
          }
        } else {
          evaluated.verdict = 'FAIL';
        }
      } catch (err) {
        evaluated.actual = {
          label: 'INERT',
          code: 'EXECUTION_ERROR',
          note: err.message,
        };
        evaluated.verdict = 'FAIL';
      }

      waveResults.push(evaluated);
      allResults.push(evaluated);
    }

    // Write partial results after each wave
    if (partialOutPath) {
      const absPath = resolve(process.cwd(), partialOutPath);
      mkdirSync(dirname(absPath), { recursive: true });
      const partialPayload = JSON.stringify({
        generatedAt: new Date().toISOString(),
        wave: waveIndex + 1,
        totalWaves,
        processedCount: allResults.length,
        totalCases: cases.length,
        cases: allResults,
      }, null, 2);
      writeFileSync(absPath, partialPayload, 'utf8');
    }

    if (typeof options.onWaveComplete === 'function') {
      options.onWaveComplete({
        waveIndex: waveIndex + 1,
        totalWaves,
        waveResults,
        accumulatedCount: allResults.length,
      });
    }
  }

  return {
    results: allResults,
    count: allResults.length,
  };
}
