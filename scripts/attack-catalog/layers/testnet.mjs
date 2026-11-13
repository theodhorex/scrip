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
import { planRelayAttack, buildAttackDelegate, classifyFtOnTransfer, isLegitTokenCaller, classifyTokenCallerOutcome, buildTokenCallerMsg } from './relay_attack.mjs';

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
export const T = (n) => BigInt(n) * 1_000_000_000_000n; // Tgas

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

  // A payment that was already in flight BEFORE the case may settle during it (reserved -> spent). That is not the
  // case's doing, so allow spent/merchant balance to grow by at most the amount that was pending beforehand.
  const pending = BigInt(before.priorPendingReserved ?? before.reserved ?? '0');
  const spentDelta = BigInt(after.spent ?? '0') - BigInt(before.spent ?? '0');
  const spentDiff = spentDelta < 0n || spentDelta > pending;
  const reservedDiff = BigInt(after.reserved ?? '0') > BigInt(before.reserved ?? '0');
  const merchantDiff = (after.merchantBalance ?? 0n) - (before.merchantBalance ?? 0n) > pending;
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
  const approvals = new Map(); // key -> { expires_at_ms, used }
  const pending = new Map(); // "mandate_id:request_id" -> { recipient, amount, height }
  const MOCK_BLOCK_HEIGHT = 2000;
  let mandateCounter = 0;
  let txNonce = 1000;

  balances.set(funderId, nearToYocto('10'));
  ftBalances.set(funderId, 10_000_000n);

  return {
    accounts,
    balances,
    ftBalances,
    mandates,
    approvals,
    pending,
    async viewAccount({ accountId }) {
      if (!accounts.has(accountId) && accountId !== funderId) {
        throw new Error(`Account ${accountId} does not exist`);
      }
      return {
        amount: (balances.get(accountId) ?? nearToYocto('1')).toString(),
      };
    },
    async viewBlock() {
      return { header: { height: MOCK_BLOCK_HEIGHT, hash: 'MOCK_BLOCK_HASH' } };
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
          approval_threshold: (m.approval_threshold ?? 500_000n).toString(),
          deposited: m.deposited.toString(),
          spent: m.spent.toString(),
          reserved: m.reserved.toString(),
          open_requests: m.open_requests ?? 0,
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
          approval_threshold: BigInt(args.approval_threshold ?? 500_000),
          approvals_count: 0,
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
      if (methodName === 'request_payment') {
        const m = mandates.get(Number(args.mandate_id));
        if (m && senderId && senderId !== m.agent) {
          return { error: 'UNAUTHORIZED_AGENT', transaction: { hash }, status: { Failure: 'SCRIP_ERR:UNAUTHORIZED_AGENT' } };
        }
      }
      if (methodName === 'tighten') {
        const m = mandates.get(Number(args.mandate_id));
        if (m && senderId && senderId !== m.owner && senderId !== m.guardian) {
          return { error: 'UNAUTHORIZED', transaction: { hash }, status: { Failure: 'SCRIP_ERR:UNAUTHORIZED' } };
        }
        if (m && m.status !== 'Active') {
          return { error: 'NOT_ACTIVE', transaction: { hash }, status: { Failure: 'SCRIP_ERR:NOT_ACTIVE' } };
        }
        if (m && args.change?.ApprovalThreshold !== undefined) {
          m.approval_threshold = BigInt(args.change.ApprovalThreshold);
        }
        if (m && args.change?.Budget !== undefined) {
          const x = BigInt(args.change.Budget);
          const fail = (code) => ({ error: code, transaction: { hash }, status: { Failure: `SCRIP_ERR:${code}` } });
          if (x >= m.budget) return fail('NOT_STRICTER');
          if (x < m.spent + m.reserved) return fail('BUDGET_BELOW_COMMITTED');
          if (x < m.per_payment_cap) return fail('BUDGET_BELOW_CAP');
          m.budget = x;
        }
        return { transaction: { hash }, status: { SuccessValue: '' } };
      }
      if (methodName === 'loosen') {
        const m = mandates.get(Number(args.mandate_id));
        if (m && senderId && senderId !== m.guardian) {
          return { error: 'UNAUTHORIZED_GUARDIAN', transaction: { hash }, status: { Failure: 'SCRIP_ERR:UNAUTHORIZED_GUARDIAN' } };
        }
        if (m && m.status !== 'Active') {
          return { error: 'NOT_ACTIVE', transaction: { hash }, status: { Failure: 'SCRIP_ERR:NOT_ACTIVE' } };
        }
        // Mirror the check order of lib.rs loosen (guarded constants: MAX_RECIPIENTS = 16).
        const fail = (code) => ({ error: code, transaction: { hash }, status: { Failure: `SCRIP_ERR:${code}` } });
        const change = args.change || {};
        if (m) {
          if (change.Budget !== undefined) {
            const x = BigInt(change.Budget);
            if (x <= m.budget) return fail('NOT_LOOSER');
            if (x > m.deposited - m.withdrawn) return fail('BUDGET_ABOVE_DEPOSITED');
            m.budget = x;
          } else if (change.PerPaymentCap !== undefined) {
            const x = BigInt(change.PerPaymentCap);
            if (x <= m.per_payment_cap) return fail('NOT_LOOSER');
            if (x > m.budget) return fail('CAP_ABOVE_BUDGET');
            m.per_payment_cap = x;
          } else if (change.ApprovalThreshold !== undefined) {
            const x = BigInt(change.ApprovalThreshold);
            if (x <= (m.approval_threshold ?? 500_000n)) return fail('NOT_LOOSER');
            if (x > m.per_payment_cap) return fail('THRESHOLD_ABOVE_CAP');
            m.approval_threshold = x;
          } else if (change.AddRecipient !== undefined) {
            const r = String(change.AddRecipient);
            if (!r || !/^[a-z0-9._-]+$/.test(r)) return fail('INVALID_RECIPIENT');
            if (m.recipients.includes(r)) return fail('DUPLICATE_RECIPIENT');
            if (m.recipients.length >= 16) return fail('TOO_MANY_RECIPIENTS');
            m.recipients.push(r);
          } else if (change.RemoveRecipient !== undefined) {
            return fail('NOT_LOOSER');
          } else if (change.Expiry !== undefined) {
            if (Number(change.Expiry) <= (m.expires_at_ms ?? 0)) return fail('NOT_LOOSER');
            m.expires_at_ms = Number(change.Expiry);
          }
        }
        return { transaction: { hash }, status: { SuccessValue: '' } };
      }
      if (methodName === 'resolve_stale') {
        const m = mandates.get(Number(args.mandate_id));
        const fail = (code) => ({ error: code, transaction: { hash }, status: { Failure: `SCRIP_ERR:${code}` } });
        if (m && senderId && senderId !== m.guardian) return fail('UNAUTHORIZED_GUARDIAN');
        const key = `${Number(args.mandate_id)}:${Number(args.request_id)}`;
        const p = pending.get(key);
        if (!p) return fail('NO_SUCH_PENDING');
        if (MOCK_BLOCK_HEIGHT - p.height < 200) return fail('NOT_STALE_YET'); // STALE_BLOCKS = 200
        if (!args.transferred) return fail('STALE_REFUND_UNPROVABLE');
        pending.delete(key);
        if (m) {
          m.reserved -= p.amount;
          m.open_requests = Math.max((m.open_requests ?? 1) - 1, 0);
          m.spent += p.amount;
        }
        return { transaction: { hash }, status: { SuccessValue: '' } };
      }
      if (methodName === 'approve_intent') {
        const m = mandates.get(Number(args.mandate_id));
        const dep = BigInt(deposit || '0');
        const minDep = 2_000_000_000_000_000_000_000n; // 2 mNEAR (STORAGE_DEPOSIT_PER_APPROVAL, lib.rs:42)
        if (dep < minDep) {
          return { error: 'INSUFFICIENT_APPROVAL_DEPOSIT', transaction: { hash }, status: { Failure: 'INSUFFICIENT_APPROVAL_DEPOSIT' } };
        }
        const now = Date.now();
        if (args.approval_expires_at_ms && Number(args.approval_expires_at_ms) <= now) {
          return { error: 'APPROVAL_NOT_IN_FUTURE', transaction: { hash }, status: { Failure: 'APPROVAL_NOT_IN_FUTURE' } };
        }
        if (m && (m.approvals_count ?? 0) >= 512) {
          return { error: 'TOO_MANY_APPROVALS', transaction: { hash }, status: { Failure: 'TOO_MANY_APPROVALS' } };
        }
        const key = `${args.mandate_id}:${args.recipient}:${args.amount}:${args.nonce}`;
        if (approvals.has(key)) {
          return { error: 'ALREADY_APPROVED', transaction: { hash }, status: { Failure: 'ALREADY_APPROVED' } };
        }
        if (m) m.approvals_count = (m.approvals_count ?? 0) + 1;
        approvals.set(key, { expires_at_ms: Number(args.approval_expires_at_ms), used: false });
        return { transaction: { hash }, status: { SuccessValue: '' } };
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
        if (m && senderId && senderId !== m.owner && senderId !== m.guardian) {
          return { error: 'UNAUTHORIZED', transaction: { hash }, status: { Failure: 'SCRIP_ERR:UNAUTHORIZED' } };
        }
        if (m && m.status !== 'Active') {
          return { error: 'NOT_ACTIVE', transaction: { hash }, status: { Failure: 'SCRIP_ERR:NOT_ACTIVE' } };
        }
        if (m) m.status = 'Revoked';
        return { transaction: { hash }, status: { SuccessValue: '' } };
      }
      if (methodName === 'withdraw') {
        const m = mandates.get(Number(args.mandate_id));
        if (m && senderId && senderId !== m.owner) {
          return { error: 'UNAUTHORIZED_OWNER', transaction: { hash }, status: { Failure: 'SCRIP_ERR:UNAUTHORIZED_OWNER' } };
        }
        if (m && m.status !== 'Revoked') {
          return { error: 'MANDATE_STILL_ACTIVE', transaction: { hash }, status: { Failure: 'SCRIP_ERR:MANDATE_STILL_ACTIVE' } };
        }
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
  const keyDir = opts.keyDir ?? process.env.KEY_DIR ?? '';
  if (!dry && !keyDir && !(opts.funderKeyFile ?? process.env.FUNDER_KEY_FILE)) {
    throw new Error('Set KEY_DIR (folder holding priv_key.txt and priv_key_relayer.txt) or FUNDER_KEY_FILE and RELAYER_KEY_FILE');
  }
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
  const strangerKey = KeyPair.fromRandom('ed25519');
  const strangerId = idPrefix('amst_');

  createdAccounts.push({ id: contractId, key: contractKey });
  createdAccounts.push({ id: merchantId, key: merchantKey });
  createdAccounts.push({ id: strangerId, key: strangerKey });

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
    await mockEngine.createSubAccount({ accountOrPrefix: strangerId, nearToTransfer: nearToYocto('0.12'), key: strangerKey.getPublicKey().toString() });
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
    strangerId,
    strangerKey,
    createdAccounts,
    agentKeyPairs,
    guardianKeyPairs,
    port,
    mockEngine,
    closed: false,
    totalTopUpAmount: 0n,
    maxTopUpPerSession: opts.maxTopUpPerSession ?? MAX_SESSION_TOP_UP_YOCTO,

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

    /** Like viewMandate but an RPC/network error propagates (never masked as null), so callers can mark INFRA_ERROR. */
    async viewMandateStrict(id) {
      if (dry) return mockEngine.callFunction({ contractId, method: 'get_mandate', args: { id } });
      return provider.callFunction({ contractId, method: 'get_mandate', args: { id } });
    },

    /** Like viewFtBalance but a read error propagates instead of silently becoming 0n (used by FULL_REFUND proofs). */
    async viewFtBalanceStrict(accountId) {
      const res = await (dry ? mockEngine : provider).callFunction({ contractId: usdc, method: 'ft_balance_of', args: { account_id: accountId } });
      return BigInt(res || '0');
    },

    usdcContractId: usdc,

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
            await withRetry(() => funderAcc.callFunctionRaw({
              contractId,
              methodName: 'revoke',
              args: { mandate_id: m.id },
              gas: T(30),
              deposit: 0n,
            }), { tries: 6 });
            const s = await withRetry(async () => {
              const r = await provider.callFunction({ contractId, method: 'get_mandate', args: { id: m.id } });
              return r;
            });
            if (s) {
              const free = BigInt(s.deposited) - BigInt(s.spent) - BigInt(s.reserved) - BigInt(s.withdrawn);
              if (free > 0n) {
                await withRetry(() => funderAcc.callFunctionRaw({
                  contractId,
                  methodName: 'withdraw',
                  args: { mandate_id: m.id, amount: free.toString() },
                  gas: T(100),
                  deposit: 0n,
                }), { tries: 6 });
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
        } catch (e) {
          // Only an explicit "account does not exist" proves deletion. A network error proves nothing,
          // so the account stays on the leftover list (unverified) and the recovery file is kept.
          if (!isAccountMissingError(e)) leftoverAccounts.push(a.id);
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
        await mockEngine.createSubAccount({ accountOrPrefix: ag.id, nearToTransfer: nearToYocto('0.12'), publicKey: ag.key.getPublicKey() });
        await mockEngine.createSubAccount({ accountOrPrefix: gu.id, nearToTransfer: nearToYocto('0.12'), publicKey: gu.key.getPublicKey() });
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
      await mk(strangerId, strangerKey, '0.12');
      for (let i = 0; i < mandatesCount; i++) {
        await mk(agentKeyPairs[i].id, agentKeyPairs[i].key, '0.12');
        await mk(guardianKeyPairs[i].id, guardianKeyPairs[i].key, '0.12');
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


const INFRA_RE = /429|rate limit|502|503|504|fetch failed|ECONNRESET|ETIMEDOUT|socket hang up|UND_ERR|timed out/i;
/** True when an error/status text is an RPC/network outage (not a verdict about the contract). */
export function isInfraError(text) { return INFRA_RE.test(String(text ?? '')); }
/** Retries an idempotent read/cleanup call on infrastructure errors only, with backoff. */
export async function withRetry(fn, { tries = 5, baseMs = 1500 } = {}) {
  for (let i = 0; ; i++) {
    try { return await fn(); } catch (e) {
      if (i >= tries - 1 || !isInfraError(e?.message)) throw e;
      await new Promise((r) => setTimeout(r, baseMs * (i + 1)));
    }
  }
}

const MAX_OPEN = 32;
let relayedPaymentNonce = 9_000_000;

/** Polls get_mandate until nothing is reserved (in-flight payment callbacks settled). Dry mode settles instantly. */
export async function waitForSettlement(session, mandateId, { timeoutMs = 20_000, intervalMs = 1_000 } = {}) {
  const deadline = Date.now() + timeoutMs;
  let m = await session.viewMandate(mandateId);
  if (session.isDry) return m;
  while (m && BigInt(m.reserved ?? '0') > 0n && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, intervalMs));
    m = await session.viewMandate(mandateId);
  }
  return m;
}

/** Guardian account helper for dry mode and live testnet. */
export function getGuardianAcc(session, idx = 0) {
  const g = session.guardianKeyPairs[idx] || session.guardianKeyPairs[0];
  if (!g) throw new Error(`Guardian key pair at index ${idx} not found in session`);
  if (session.isDry) {
    return {
      accountId: g.id,
      callFunctionRaw: async ({ contractId, methodName, args, gas, deposit }) => {
        return session.mockEngine.callFunctionRaw({
          contractId,
          methodName,
          args,
          deposit,
          senderId: g.id,
        });
      },
    };
  }
  return new Account(g.id, session.provider, new KeyPairSigner(g.key));
}

/**
 * Chooses how a case method must be transmitted on the REAL path. The facilitator /relay only accepts
 * request_payment, so lifecycle methods must go straight to their authorized account instead.
 *   owner          -> session.funderAcc (mandate owner; revoke/withdraw/tighten)
 *   guardian       -> session guardian account (loosen/resolve_stale)
 *   approve_intent -> guardian account with the approval storage deposit
 *   relay          -> agent function-call key through the facilitator
 */
export function routeMethod(method = 'request_payment') {
  if (['revoke', 'withdraw', 'tighten'].includes(method)) return 'owner';
  if (['loosen', 'resolve_stale'].includes(method)) return 'guardian';
  if (method === 'approve_intent') return 'approve_intent';
  return 'relay';
}

/** Calls an owner-only method from the funder account (the owner of every session mandate). */
export async function callAsOwner(session, methodName, args, { gas = T(30), deposit = 0n } = {}) {
  return session.funderAcc.callFunctionRaw({
    contractId: session.contractId,
    methodName,
    args,
    gas,
    deposit,
  });
}

/**
 * Recursively maps occurrences of a symbolic caller string within arguments to the
 * actual signer account ID. Used so that cases with caller == agent (KAT-E-05-37) or
 * guardian == caller (KAT-E-05-38) reflect the actual signer account on the real testnet path.
 *
 * @param {object} args
 * @param {string} rawCaller
 * @param {string} actualCallerId
 * @returns {object}
 */
export function mapCallerInArgs(args, rawCaller, actualCallerId) {
  if (!args || typeof args !== 'object' || !rawCaller || !actualCallerId) return args;
  const mapValue = (val) => {
    if (val === rawCaller) return actualCallerId;
    if (Array.isArray(val)) return val.map(mapValue);
    if (val && typeof val === 'object' && Object.getPrototypeOf(val) === Object.prototype) {
      return Object.fromEntries(Object.entries(val).map(([k, v]) => [k, mapValue(v)]));
    }
    return val;
  };
  return mapValue(args);
}

/**
 * True only when the error says the account does not exist (deleted). Network errors, rate limits and
 * unknown failures return false so that cleanup never reports "deleted" for an account it could not check.
 */
export function isAccountMissingError(e) {
  const text = [e?.type, e?.name, e?.code, e?.message, e?.cause?.message].filter(Boolean).join(' ');
  return /UNKNOWN_ACCOUNT|AccountDoesNotExist|does not exist|doesn'?t exist|not exist while viewing/i.test(text);
}

/**
 * Infers rejection code purely from the call signature and on-chain facts (lib.rs),
 * never from expected. Used because release wasm builds (strip=true, opt-level="z")
 * turn near-sdk panics into silent WebAssembly traps without panic strings.
 *
 * @param {object} params
 * @param {string} params.method - Method called
 * @param {bigint|string|number} [params.deposit=0n] - Attached deposit
 * @param {boolean} [params.callerIsContractItself=false] - Whether caller is contract account
 * @param {boolean} [params.txFailedWithTrap=false] - Whether tx failed with unreachable opcode trap
 * @returns {string} - 'METHOD_IS_PRIVATE' | 'METHOD_NOT_PAYABLE' | 'TX_FAILED'
 */
export function inferVmRejection({ method, deposit = 0n, callerIsContractItself = false, txFailedWithTrap = false }) {
  if (!txFailedWithTrap) {
    return 'TX_FAILED';
  }

  // #[private] callback methods defined in contracts/scrip/src/lib.rs (lines 590, 793)
  const PRIVATE_METHODS = new Set(['on_payment_done', 'on_withdraw_done']);
  if (PRIVATE_METHODS.has(method) && !callerIsContractItself) {
    return 'METHOD_IS_PRIVATE';
  }

  // Non-payable methods defined in contracts/scrip/src/lib.rs (without #[payable])
  // #[payable] is present ONLY on create_mandate (lib.rs:385) and approve_intent (lib.rs:620).
  const NON_PAYABLE_METHODS = new Set([
    'request_payment',
    'withdraw',
    'tighten',
    'loosen',
    'revoke',
    'resolve_stale',
  ]);

  let dep = 0n;
  try {
    if (deposit !== null && deposit !== undefined) {
      dep = BigInt(deposit);
    }
  } catch {
    dep = 0n;
  }

  if (NON_PAYABLE_METHODS.has(method) && dep > 0n) {
    return 'METHOD_NOT_PAYABLE';
  }

  return 'TX_FAILED';
}

export const TOP_UP_BUFFER_YOCTO = 200_000_000_000_000_000_000_000n; // 0.2 NEAR safety buffer for gas & storage
export const MAX_SESSION_TOP_UP_YOCTO = 10_000_000_000_000_000_000_000_000n; // 10 NEAR cap per session

/**
 * Pure function: calculates the required top-up amount from funder to caller account.
 * Top-up is required if current balance < deposit + buffer (0.2 NEAR).
 * Returns 0n if deposit <= 0 or current balance is already sufficient.
 *
 * @param {bigint|string|number|object} currentBalance - Balance or { currentBalance, deposit, buffer }
 * @param {bigint|string|number} [deposit] - Attached deposit
 * @param {bigint|string|number} [buffer=TOP_UP_BUFFER_YOCTO] - Safety buffer
 * @returns {bigint} Top-up amount to transfer in yoctoNEAR (0n if none required)
 */
export function calculateTopUpAmount(currentBalance, deposit, buffer = TOP_UP_BUFFER_YOCTO) {
  let bal, dep, buf;
  if (typeof currentBalance === 'object' && currentBalance !== null && !('length' in currentBalance)) {
    bal = BigInt(currentBalance.currentBalance ?? 0n);
    dep = BigInt(currentBalance.deposit ?? 0n);
    buf = BigInt(currentBalance.buffer ?? TOP_UP_BUFFER_YOCTO);
  } else {
    bal = BigInt(currentBalance ?? 0n);
    dep = BigInt(deposit ?? 0n);
    buf = BigInt(buffer ?? TOP_UP_BUFFER_YOCTO);
  }

  if (dep <= 0n) return 0n;
  const required = dep + buf;
  if (bal < required) {
    return required - bal;
  }
  return 0n;
}

/**
 * Ensures caller account has at least deposit + 0.2 NEAR before calling the contract.
 * If balance is insufficient, funds the difference from session.funderAcc.
 * Tracks total top-up per session and enforces session limit.
 *
 * @param {object} session
 * @param {string} callerAccountId
 * @param {bigint|string} deposit
 * @returns {Promise<string|null>} Note describing the top-up or null if no top-up needed
 */
export async function ensureCallerFunded(session, callerAccountId, deposit) {
  if (!deposit || BigInt(deposit) <= 0n || !callerAccountId) return null;
  if (callerAccountId === session.funderId || callerAccountId === session.funderAcc?.accountId) {
    return null;
  }

  let acctInfo;
  try {
    acctInfo = await session.provider.viewAccount({ accountId: callerAccountId });
  } catch {
    return null;
  }

  const currentBal = BigInt(acctInfo?.amount ?? 0n);
  const topUpNeeded = calculateTopUpAmount(currentBal, deposit);
  if (topUpNeeded <= 0n) return null;

  const maxLimit = session.maxTopUpPerSession ?? MAX_SESSION_TOP_UP_YOCTO;
  const newTotal = (session.totalTopUpAmount ?? 0n) + topUpNeeded;
  if (newTotal > maxLimit) {
    throw new Error(`Total top-up per session exceeded limit (${newTotal} > ${maxLimit} yoctoNEAR)`);
  }
  session.totalTopUpAmount = newTotal;

  if (session.isDry) {
    const cur = session.mockEngine.balances.get(callerAccountId) ?? 0n;
    session.mockEngine.balances.set(callerAccountId, cur + topUpNeeded);
    const fCur = session.mockEngine.balances.get(session.funderId) ?? 0n;
    session.mockEngine.balances.set(session.funderId, fCur - topUpNeeded);
  } else {
    await withRetry(() => session.funderAcc.signAndSendTransaction({
      receiverId: callerAccountId,
      actions: [actions.transfer(topUpNeeded)],
    }));
  }

  return `top-up: ${topUpNeeded.toString()} yoctoNEAR from funder (deposit: ${deposit.toString()})`;
}

/**
 * Resolves the appropriate Account instance for a given caller role.
 */
export function getCallerAccount(session, callerName, agentIdx = 0) {
  if (callerName === 'agent.testnet') {
    const ag = session.getAgent(agentIdx);
    if (session.isDry) {
      return {
        accountId: ag.id,
        callFunctionRaw: async ({ contractId, methodName, args, gas, deposit }) => {
          return session.mockEngine.callFunctionRaw({
            contractId,
            methodName,
            args,
            deposit,
            senderId: ag.id,
          });
        },
      };
    }
    return new Account(ag.id, session.provider, new KeyPairSigner(ag.key));
  }

  if (callerName === 'owner.testnet' || callerName === 'alice.testnet') {
    return session.funderAcc;
  }

  if (callerName === 'guardian.testnet') {
    return getGuardianAcc(session, agentIdx);
  }

  // Stranger / unauthorized accounts
  const sId = session.strangerId || 'stranger.testnet';
  if (session.isDry) {
    return {
      accountId: sId,
      callFunctionRaw: async ({ contractId, methodName, args, gas, deposit }) => {
        return session.mockEngine.callFunctionRaw({
          contractId,
          methodName,
          args,
          deposit,
          senderId: sId,
        });
      },
    };
  }
  return new Account(session.strangerId, session.provider, new KeyPairSigner(session.strangerKey));
}

/**
 * Classifies a transaction result from near-api-js callFunctionRaw or RPC response.
 * Detects contract events, SCRIP_ERR in logs, or transaction Failure.
 */
export function classifyTxResult(txRes, defaultLabel = 'INERT') {
  if (!txRes) {
    return { label: defaultLabel, txHash: null, note: 'Empty transaction result' };
  }
  const txHash = txRes.transaction?.hash ?? txRes.transaction_outcome?.id ?? null;
  const logs = txRes.receipts_outcome?.flatMap((o) => o?.outcome?.logs || []) || [];

  const rejectedEvent = logs
    .filter((l) => typeof l === 'string' && l.startsWith('EVENT_JSON:'))
    .map((l) => {
      try { return JSON.parse(l.slice(11)); } catch { return null; }
    })
    .find((e) => e && e.event === 'rejected');
  if (rejectedEvent) {
    const code = rejectedEvent.data?.[0]?.code || 'REJECTED';
    return { label: 'BLOCKED', code: String(code), txHash, note: `Contract rejected: ${code}` };
  }

  const errLog = logs.find((l) => typeof l === 'string' && l.startsWith('SCRIP_ERR:'));
  if (errLog) {
    const code = errLog.slice('SCRIP_ERR:'.length).trim();
    return { label: 'BLOCKED', code, txHash, note: `SCRIP_ERR: ${code}` };
  }

  if (txRes.status?.Failure) {
    const failureStr = JSON.stringify(txRes.status.Failure);
    const match = failureStr.match(/SCRIP_ERR:([A-Za-z0-9_]+)/) || failureStr.match(/ExecutionError.*?([A-Z_]{4,})/);
    return { label: 'BLOCKED', code: match ? match[1] : 'CALL_FAILED', txHash, note: `Failure: ${failureStr}` };
  }

  return { label: defaultLabel, txHash, note: `Transaction confirmed: ${txHash}` };
}

/**
 * Classifies a transaction error thrown by near-api-js callFunctionRaw.
 * Extracts SCRIP_ERR from error messages, attached transactionResult logs, or on-chain tx lookup.
 */
export async function classifyTxError(err, session = null, signerAccountId = null, callContext = {}) {
  const msg = err?.message || '';
  const failedRes = err?.transactionResult ?? null;
  const failedHash = failedRes?.transaction_outcome?.id ?? err?.context?.transactionHash ?? err?.transactionHash ?? null;

  // near-sdk method guards are NOT SCRIP_ERR codes: a non-payable method rejects any
  // attached deposit and a #[private] method rejects external callers. The contract marks
  // these methods with the macros (lib.rs:489/589/657/701/743/792/818) but the panic text
  // comes from near-sdk (near-sdk-macros-5.30 impl_item_method_info.rs:156/187).
  if (/doesn't accept deposit/i.test(msg)) {
    return { label: 'BLOCKED', code: 'METHOD_NOT_PAYABLE', txHash: failedHash ? String(failedHash) : null, note: msg };
  }
  if (/\bis private\b/i.test(msg)) {
    return { label: 'BLOCKED', code: 'METHOD_IS_PRIVATE', txHash: failedHash ? String(failedHash) : null, note: msg };
  }

  // Release wasm builds (strip=true, opt-level="z") turn near-sdk panics into WebAssembly
  // unreachable traps without panic text. In that case, infer the rejection code purely from
  // the call signature and on-chain facts (lib.rs #[payable] / #[private]), never from expected.
  const isTrap = /WebAssembly trap|unreachable opcode/i.test(msg)
    || /WebAssembly trap|unreachable opcode/i.test(JSON.stringify(failedRes || {}));
  const method = callContext?.method;
  if (isTrap && method) {
    const contractId = callContext?.contractId || session?.contractId;
    const callerIsContractItself = Boolean(contractId && signerAccountId && signerAccountId === contractId);
    const inferred = inferVmRejection({
      method,
      deposit: callContext?.deposit ?? 0n,
      callerIsContractItself,
      txFailedWithTrap: true,
    });
    if (inferred !== 'TX_FAILED') {
      return {
        label: 'BLOCKED',
        code: inferred,
        txHash: failedHash ? String(failedHash) : null,
        note: 'code derived from the call shape because the release wasm emits no panic message',
      };
    }
  }

  let match = msg.match(/SCRIP_ERR:([A-Za-z0-9_]+)/) || msg.match(/Smart contract panicked:\s*([A-Za-z0-9_]+)/);

  if (!match && failedRes) {
    const inline = failedRes.receipts_outcome?.flatMap((o) => o?.outcome?.logs ?? []) ?? [];
    const l = inline.find((x) => typeof x === 'string' && x.startsWith('SCRIP_ERR:'));
    if (l) match = [null, l.slice('SCRIP_ERR:'.length).trim()];
  }

  if (!match && failedHash && session?.provider && signerAccountId) {
    try {
      const failedTx = await withRetry(() => session.provider.sendJsonRpc('tx', [failedHash, signerAccountId]));
      const failedLogs = failedTx?.receipts_outcome?.flatMap((o) => o.outcome.logs) || [];
      const l = failedLogs.find((x) => typeof x === 'string' && x.startsWith('SCRIP_ERR:'));
      if (l) match = [null, l.slice('SCRIP_ERR:'.length).trim()];
    } catch { /* keep generic fallback below */ }
  }

  if (match) {
    return { label: 'BLOCKED', code: match[1], txHash: failedHash ? String(failedHash) : null, note: `Panic: ${match[1]}` };
  }
  if (isInfraError(msg)) {
    return { label: 'SKIPPED', code: 'INFRA_ERROR', txHash: null, note: msg };
  }
  return { label: 'BLOCKED', code: 'TX_FAILED', txHash: failedHash ? String(failedHash) : null, note: `${msg} [errKeys=${Object.keys(err || {}).join(',')}]` };
}

/**
 * Determines the mandate index for a case to preserve status dependencies (e.g. Cat 10 revoked group)
 * and prevent cross-case state contamination.
 */
export function getMandateIndexForCase(c, session) {
  if (!session?.mandates || session.mandates.length <= 1) return 0;
  const numMandates = session.mandates.length;

  if (c.category === 10) {
    const id = c.id || '';
    const mMatch = id.match(/KAT-E-10-(\d+)/);
    const num = mMatch ? parseInt(mMatch[1], 10) : 0;

    // Group 1: 10-01 to 10-05 (revocation lifecycle)
    if (num >= 1 && num <= 5) {
      return 0;
    }
    // Group 2: 10-06 (withdraw on active mandate)
    if (num === 6) {
      return 1 % numMandates;
    }
    // Group 3: 10-07, 10-08 (withdraw on revoked mandate)
    if (num === 7 || num === 8) {
      return (numMandates > 2 ? 2 : 0) % numMandates;
    }
    // Group 4: 10-09 (insufficient gas)
    if (num === 9) {
      return 1 % numMandates;
    }
    // Seeded post-revoke checks
    if (c.expected?.code === 'NOT_ACTIVE' || c.params?.mandateRevoked) {
      return 0;
    }
    if (c.expected?.code === 'MANDATE_STILL_ACTIVE') {
      return 1 % numMandates;
    }
    // Active lifecycle modifications (tighten 10-14, loosen 15-20, seeded 21-60)
    const activeOffset = numMandates > 3 ? 3 : 1;
    const activeSpan = numMandates > 3 ? numMandates - 3 : 1;
    return (activeOffset + (num % activeSpan)) % numMandates;
  }

  const seq = session.caseSeq ?? 0;
  return seq % numMandates;
}

/** Reads a mandate so that an RPC/network error throws (never null); a null would let prep skip steps silently. */
function readMandateStrict(session, id) {
  return (session.viewMandateStrict ?? session.viewMandate).call(session, id);
}

/** One legitimate payment through the facilitator relay, signed by the mandate's own agent function-call key. */
async function relayLegitPayment(session, agent, mandateId, recipient, amount, customNonce) {
  const signer = new KeyPairSigner(agent.fcKey);
  const head = await withRetry(() => session.provider.viewBlock({ finality: 'optimistic' }));
  const pub = await signer.getPublicKey();
  let onChain = 0n;
  try {
    const k = await withRetry(() => session.provider.viewAccessKey({ accountId: agent.id, publicKey: pub.toString() }));
    onChain = BigInt(k?.nonce ?? 0);
  } catch { onChain = 0n; }
  const paymentNonce = customNonce !== undefined ? customNonce : ++relayedPaymentNonce;
  const delegate = buildDelegateAction({
    senderId: agent.id,
    receiverId: session.contractId,
    nonce: onChain + 1n,
    maxBlockHeight: BigInt(head.header.height) + 100n,
    publicKey: pub,
    actions: [actions.functionCall('request_payment',
      { mandate_id: mandateId, recipient, amount: String(amount), nonce: paymentNonce }, T(100), 0n)],
  });
  const signed = await signer.signDelegateAction(delegate);
  const b64 = Buffer.from(encodeSignedDelegate(signed.signedDelegate)).toString('base64');
  const res = await fetch(`http://127.0.0.1:${session.port}/relay`, {
    method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: b64 }),
  });
  const json = await res.json().catch(() => null);
  if (res.status >= 400) throw new Error(`prep payment rejected: HTTP ${res.status} ${json?.code ?? ''}`);
  return json?.tx_hash;
}

/**
 * Brings the case's mandate into the state the case is written against (catalog metadata the harness used to
 * ignore). Returns { ok: true } or { ok: false, reason }; an unsupported or failed preparation must NOT run the
 * case (it would give a meaningless PASS/FAIL/BREACH), the caller records SKIPPED with the reason.
 *   remainingBudget      free budget left = R (valid payments up to the cap)
 *   openRequestsCount    N: N-1 requests already open, the case itself is the Nth
 *   hasValidApproval / approvalAlreadyUsed / approvalExpired   approval state
 */
export async function prepareCaseState(c, session) {
  const p = c.params || {};
  if (p.skipStatePrep) return { ok: true };
  const mandateId = p.mandate_id ?? session.mandates[0]?.id ?? 1;
  const agentIdx = p.agentIndex ?? 0;
  const expectedCode = c.expected?.code;
  const method = p.method || 'request_payment';
  const amount = BigInt(p.args?.amount || p.amount || '0');

  // Handle mandate revocation state if needed by the case
  const needsRevoked = p.mandateRevoked
    || (c.category === 10 && (expectedCode === 'NOT_ACTIVE' || expectedCode === 'ALREADY_REVOKED'));
  const isInitialRevoke = method === 'revoke' && (c.expected?.label === 'INERT' || !expectedCode);

  if (needsRevoked && !isInitialRevoke) {
    if (session.isDry) {
      const m = session.mockEngine?.mandates?.get(mandateId);
      if (m && m.status !== 'Revoked') {
        m.status = 'Revoked';
      }
    } else {
      const m = await readMandateStrict(session, mandateId);
      if (m && m.status !== 'Revoked') {
        try {
          const res = await withRetry(() => session.funderAcc.callFunctionRaw({
            contractId: session.contractId,
            methodName: 'revoke',
            args: { mandate_id: mandateId },
            gas: T(30),
          }));
          if (res?.status?.Failure || res?.error) {
            return { ok: false, reason: `prep revoke failed: ${JSON.stringify(res?.status?.Failure || res?.error)}` };
          }
        } catch (e) {
          return { ok: false, reason: `prep revoke failed: ${e.message}` };
        }
      }
    }
  }

  // 1. TOO_MANY_APPROVALS (Family 7)
  // MAX_APPROVALS_PER_MANDATE is 512 (contracts/scrip/src/lib.rs:45).
  // Creating 512 prior approvals on testnet is prohibitively slow and expensive; skip with reason.
  if (expectedCode === 'TOO_MANY_APPROVALS') {
    return {
      ok: false,
      reason: 'MAX_APPROVALS_PER_MANDATE is 512 (lib.rs:45); creating 512 approvals on testnet is prohibitively expensive; covered by unit tests',
    };
  }

  // 2. ALREADY_APPROVED via request_payment (Family 6)
  // Contracts/scrip/src/lib.rs:632 shows ALREADY_APPROVED is only generated by approve_intent.
  // request_payment cannot return ALREADY_APPROVED (RejectCode has only ApprovalUsed/ApprovalExpired/NeedsApproval).
  if (expectedCode === 'ALREADY_APPROVED' && method === 'request_payment') {
    return {
      ok: false,
      reason: 'ALREADY_APPROVED can only be produced by approve_intent (lib.rs:632); request_payment cannot return ALREADY_APPROVED; inconsistent with contract spec',
    };
  }

  // 3. Direct approve_intent expecting ALREADY_APPROVED (Family 7, e.g. KAT-E-04-10)
  // Need 1 initial approve_intent so the case execution triggers ALREADY_APPROVED.
  if (expectedCode === 'ALREADY_APPROVED' && method === 'approve_intent') {
    const recipient = (p.args?.recipient === 'merchant.testnet' || !p.args?.recipient) ? session.merchantId : p.args.recipient;
    const gAcc = getGuardianAcc(session, agentIdx);
    const nonce = Number(p.args?.nonce ?? 0);
    const expiresAt = p.args?.approval_expires_at_ms || (Date.now() + 600_000);
    try {
      const res = await withRetry(() => gAcc.callFunctionRaw({
        contractId: session.contractId,
        methodName: 'approve_intent',
        args: {
          mandate_id: mandateId,
          recipient,
          amount: String(amount),
          nonce,
          approval_expires_at_ms: expiresAt,
        },
        gas: T(30),
        deposit: 2_000_000_000_000_000_000_000n, // 2 mNEAR (STORAGE_DEPOSIT_PER_APPROVAL, lib.rs:42)
      }));
      if (res?.status?.Failure || res?.error) {
        return { ok: false, reason: `prep approve_intent failed: ${JSON.stringify(res?.status?.Failure || res?.error)}` };
      }
    } catch (e) {
      return { ok: false, reason: `prep approve_intent failed: ${e.message}` };
    }
    return { ok: true };
  }

  // 4. NEEDS_APPROVAL (Family 3)
  // Needs approval_threshold < amount. Mandates start with threshold = cap (500000).
  // If amount > cap (e.g. 500001 or 501000), Step 4 (cap check) rejects BEFORE Step 7 (approval check),
  // making NEEDS_APPROVAL impossible; skip with reason.
  // Otherwise tighten ApprovalThreshold to amount - 1.
  if (expectedCode === 'NEEDS_APPROVAL' && method === 'request_payment') {
    const m0 = await readMandateStrict(session, mandateId);
    const cap = BigInt(m0?.per_payment_cap ?? 500_000n);
    if (amount > cap) {
      return {
        ok: false,
        reason: `amount (${amount}) > per_payment_cap (${cap}) so cap check (lib.rs:514) rejects before approval check (lib.rs:533); NEEDS_APPROVAL impossible; covered by layer A/D`,
      };
    }
    const newThreshold = amount > 0n ? amount - 1n : 0n;
    const curThreshold = BigInt(m0?.approval_threshold ?? 500_000n);
    if (newThreshold < curThreshold) {
      try {
        const res = await withRetry(() => session.funderAcc.callFunctionRaw({
          contractId: session.contractId,
          methodName: 'tighten',
          args: {
            mandate_id: mandateId,
            change: { ApprovalThreshold: String(newThreshold) },
          },
          gas: T(30),
        }));
        if (res?.status?.Failure || res?.error) {
          return { ok: false, reason: `tighten threshold failed: ${JSON.stringify(res?.status?.Failure || res?.error)}` };
        }
      } catch (e) {
        return { ok: false, reason: `tighten threshold failed: ${e.message}` };
      }
    }
    return { ok: true };
  }

  // 5. APPROVAL_USED (Family 4)
  // Tighten threshold, guardian approve_intent, agent pays ONCE with that nonce via relay,
  // so the approval is consumed and case payment triggers APPROVAL_USED.
  if (expectedCode === 'APPROVAL_USED' || p.approvalAlreadyUsed) {
    const m0 = await readMandateStrict(session, mandateId);
    const cap = BigInt(m0?.per_payment_cap ?? 500_000n);
    if (amount > cap) {
      return { ok: false, reason: `amount (${amount}) > per_payment_cap (${cap})` };
    }
    const newThreshold = amount > 0n ? amount - 1n : 0n;
    const curThreshold = BigInt(m0?.approval_threshold ?? 500_000n);
    if (newThreshold < curThreshold) {
      try {
        const res = await withRetry(() => session.funderAcc.callFunctionRaw({
          contractId: session.contractId,
          methodName: 'tighten',
          args: {
            mandate_id: mandateId,
            change: { ApprovalThreshold: String(newThreshold) },
          },
          gas: T(30),
        }));
        if (res?.status?.Failure || res?.error) {
          return { ok: false, reason: `tighten threshold failed: ${JSON.stringify(res?.status?.Failure || res?.error)}` };
        }
      } catch (e) {
        return { ok: false, reason: `tighten threshold failed: ${e.message}` };
      }
    }
    const recipient = (p.args?.recipient === 'merchant.testnet' || !p.args?.recipient) ? session.merchantId : p.args.recipient;
    const nonce = Number(p.args?.nonce ?? 0);
    const expiresAt = Date.now() + 600_000;
    const gAcc = getGuardianAcc(session, agentIdx);
    try {
      const res = await withRetry(() => gAcc.callFunctionRaw({
        contractId: session.contractId,
        methodName: 'approve_intent',
        args: {
          mandate_id: mandateId,
          recipient,
          amount: String(amount),
          nonce,
          approval_expires_at_ms: expiresAt,
        },
        gas: T(30),
        deposit: 2_000_000_000_000_000_000_000n, // 2 mNEAR
      }));
      if (res?.status?.Failure || res?.error) {
        return { ok: false, reason: `approve_intent failed: ${JSON.stringify(res?.status?.Failure || res?.error)}` };
      }
    } catch (e) {
      return { ok: false, reason: `approve_intent failed: ${e.message}` };
    }

    if (session.isDry) {
      const key = `${mandateId}:${recipient}:${amount}:${nonce}`;
      const app = session.mockEngine.approvals.get(key);
      if (app) app.used = true;
      return { ok: true };
    }

    const agent = session.getAgent(agentIdx);
    try {
      await relayLegitPayment(session, agent, mandateId, recipient, amount, nonce);
      const mSettle = await waitForSettlement(session, mandateId);
      if (!mSettle || BigInt(mSettle.reserved ?? '0') > 0n) {
        return { ok: false, reason: 'initial approved payment did not settle in time' };
      }
    } catch (e) {
      return { ok: false, reason: `initial payment failed: ${e.message}` };
    }
    return { ok: true };
  }

  // 6. APPROVAL_EXPIRED (Family 5)
  // Tighten threshold, guardian approve_intent with expiry = now + 15s (> block timestamp),
  // wait until expired (poll viewBlock or clock + 10s margin).
  if (expectedCode === 'APPROVAL_EXPIRED' || p.approvalExpired) {
    const m0 = await readMandateStrict(session, mandateId);
    const cap = BigInt(m0?.per_payment_cap ?? 500_000n);
    if (amount > cap) {
      return { ok: false, reason: `amount (${amount}) > per_payment_cap (${cap})` };
    }
    const newThreshold = amount > 0n ? amount - 1n : 0n;
    const curThreshold = BigInt(m0?.approval_threshold ?? 500_000n);
    if (newThreshold < curThreshold) {
      try {
        const res = await withRetry(() => session.funderAcc.callFunctionRaw({
          contractId: session.contractId,
          methodName: 'tighten',
          args: {
            mandate_id: mandateId,
            change: { ApprovalThreshold: String(newThreshold) },
          },
          gas: T(30),
        }));
        if (res?.status?.Failure || res?.error) {
          return { ok: false, reason: `tighten threshold failed: ${JSON.stringify(res?.status?.Failure || res?.error)}` };
        }
      } catch (e) {
        return { ok: false, reason: `tighten threshold failed: ${e.message}` };
      }
    }
    const recipient = (p.args?.recipient === 'merchant.testnet' || !p.args?.recipient) ? session.merchantId : p.args.recipient;
    const nonce = Number(p.args?.nonce ?? 0);
    const expiresAt = Date.now() + 15_000;
    const gAcc = getGuardianAcc(session, agentIdx);
    try {
      const res = await withRetry(() => gAcc.callFunctionRaw({
        contractId: session.contractId,
        methodName: 'approve_intent',
        args: {
          mandate_id: mandateId,
          recipient,
          amount: String(amount),
          nonce,
          approval_expires_at_ms: expiresAt,
        },
        gas: T(30),
        deposit: 2_000_000_000_000_000_000_000n, // 2 mNEAR
      }));
      if (res?.status?.Failure || res?.error) {
        return { ok: false, reason: `approve_intent failed: ${JSON.stringify(res?.status?.Failure || res?.error)}` };
      }
    } catch (e) {
      return { ok: false, reason: `approve_intent failed: ${e.message}` };
    }

    if (session.isDry) {
      const key = `${mandateId}:${recipient}:${amount}:${nonce}`;
      const app = session.mockEngine.approvals.get(key);
      if (app) app.expires_at_ms = Date.now() - 1000;
      return { ok: true };
    }

    const deadline = expiresAt + 10_000;
    while (Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 1000));
    }
    return { ok: true };
  }

  // 7. hasValidApproval
  if (p.hasValidApproval) {
    const m0 = await readMandateStrict(session, mandateId);
    const newThreshold = amount > 0n ? amount - 1n : 0n;
    const curThreshold = BigInt(m0?.approval_threshold ?? 500_000n);
    if (newThreshold < curThreshold) {
      try {
        const res = await withRetry(() => session.funderAcc.callFunctionRaw({
          contractId: session.contractId,
          methodName: 'tighten',
          args: {
            mandate_id: mandateId,
            change: { ApprovalThreshold: String(newThreshold) },
          },
          gas: T(30),
        }));
        if (res?.status?.Failure || res?.error) {
          return { ok: false, reason: `tighten threshold failed: ${JSON.stringify(res?.status?.Failure || res?.error)}` };
        }
      } catch (e) {
        return { ok: false, reason: `tighten threshold failed: ${e.message}` };
      }
    }
    const recipient = (p.args?.recipient === 'merchant.testnet' || !p.args?.recipient) ? session.merchantId : p.args.recipient;
    const nonce = Number(p.args?.nonce ?? 0);
    const expiresAt = Date.now() + 600_000;
    const gAcc = getGuardianAcc(session, agentIdx);
    try {
      const res = await withRetry(() => gAcc.callFunctionRaw({
        contractId: session.contractId,
        methodName: 'approve_intent',
        args: {
          mandate_id: mandateId,
          recipient,
          amount: String(amount),
          nonce,
          approval_expires_at_ms: expiresAt,
        },
        gas: T(30),
        deposit: 2_000_000_000_000_000_000_000n,
      }));
      if (res?.status?.Failure || res?.error) {
        return { ok: false, reason: `approve_intent failed: ${JSON.stringify(res?.status?.Failure || res?.error)}` };
      }
    } catch (e) {
      return { ok: false, reason: `approve_intent failed: ${e.message}` };
    }
    return { ok: true };
  }

  // 8. openRequestsCount (existing)
  if (p.openRequestsCount !== undefined) {
    const open = Math.min(Math.max(Number(p.openRequestsCount) - 1, 0), MAX_OPEN);
    if (session.isDry) {
      const m = session.mockEngine.mandates.get(mandateId);
      if (!m) return { ok: false, reason: `mandate ${mandateId} not found` };
      m.open_requests = open;
      return { ok: true };
    }
    return { ok: false, reason: 'open requests settle within a few blocks on real testnet, so a queue of 31-32 open requests cannot be held; covered by layer A/D' };
  }

  // 9. remainingBudget (existing)
  if (p.remainingBudget !== undefined) {
    const target = BigInt(p.remainingBudget);
    const m0 = await readMandateStrict(session, mandateId);
    if (!m0) return { ok: false, reason: `mandate ${mandateId} not found` };
    const free = (mm) => {
      const ceil = BigInt(mm.budget) < BigInt(mm.deposited) - BigInt(mm.withdrawn) ? BigInt(mm.budget) : BigInt(mm.deposited) - BigInt(mm.withdrawn);
      return ceil - BigInt(mm.spent) - BigInt(mm.reserved);
    };
    if (session.isDry) {
      const m = session.mockEngine.mandates.get(mandateId);
      const ceil = m.budget < m.deposited - m.withdrawn ? m.budget : m.deposited - m.withdrawn;
      if (target > ceil) return { ok: false, reason: `target budget ${target} exceeds ceiling ${ceil}` };
      m.spent = ceil - target;
      return { ok: true };
    }
    let toSpend = free(m0) - target;
    if (toSpend < 0n) return { ok: false, reason: `free budget ${free(m0)} already below target ${target}` };
    const cap = BigInt(m0.per_payment_cap);
    const agent = session.getAgent(p.agentIndex ?? 0);
    while (toSpend > 0n) {
      const chunk = toSpend < cap ? toSpend : cap;
      try {
        await relayLegitPayment(session, agent, mandateId, session.merchantId, chunk);
      } catch (e) {
        return { ok: false, reason: e.message };
      }
      const m = await waitForSettlement(session, mandateId);
      if (!m || BigInt(m.reserved) > 0n) return { ok: false, reason: 'prep payment did not settle in time' };
      toSpend = free(m) - target;
    }
    const mEnd = await readMandateStrict(session, mandateId);
    if (!mEnd || free(mEnd) !== target) return { ok: false, reason: `prep ended with free ${mEnd && free(mEnd)} != target ${target}` };
    return { ok: true };
  }
  // 10. loosenBudgetPrep (H3, KAT-E-05-09)
  // Budget starts equal to deposited, so `loosen(Budget)` has no legal target: the contract needs
  // budget < x <= deposited - withdrawn (lib.rs:709-712). Tighten first so the case's loosen is real.
  if (p.loosenBudgetPrep !== undefined) {
    const target = BigInt(p.loosenBudgetPrep);
    const m0 = await readMandateStrict(session, mandateId);
    if (!m0) return { ok: false, reason: `mandate ${mandateId} not found` };
    const cur = BigInt(m0.budget);
    if (target > cur) return { ok: false, reason: `loosenBudgetPrep ${target} is above current budget ${cur}` };
    if (target < BigInt(m0.per_payment_cap)) {
      return { ok: false, reason: `loosenBudgetPrep ${target} is below per_payment_cap ${m0.per_payment_cap}` };
    }
    if (target < cur) {
      const args = { mandate_id: mandateId, change: { Budget: String(target) } };
      if (session.isDry) {
        const res = await session.mockEngine.callFunctionRaw({
          contractId: session.contractId, methodName: 'tighten', args, deposit: 0n, senderId: session.funderId,
        });
        if (res.error) return { ok: false, reason: `prep tighten failed: ${res.error}` };
      } else {
        try {
          const res = await withRetry(() => session.funderAcc.callFunctionRaw({
            contractId: session.contractId, methodName: 'tighten', args, gas: T(30),
          }));
          if (res?.status?.Failure || res?.error) {
            return { ok: false, reason: `prep tighten failed: ${JSON.stringify(res?.status?.Failure || res?.error)}` };
          }
        } catch (e) {
          return { ok: false, reason: `prep tighten failed: ${e.message}` };
        }
      }
    }
  }

  // 11. recipientsCount (H3, KAT-E-10-20)
  // MAX_RECIPIENTS = 16 (lib.rs:23). Fill the allowlist with real guardian `loosen(AddRecipient)`
  // calls so the case's own AddRecipient is the 17th and hits TOO_MANY_RECIPIENTS (lib.rs:727).
  if (p.recipientsCount !== undefined) {
    const target = Number(p.recipientsCount);
    const m0 = await readMandateStrict(session, mandateId);
    if (!m0) return { ok: false, reason: `mandate ${mandateId} not found` };
    const have = m0.recipients.length;
    if (have >= target) return { ok: true };
    const gAcc = getGuardianAcc(session, agentIdx);
    for (let i = have + 1; i <= target; i++) {
      const recipient = `prep-r${i}.testnet`;
      const args = { mandate_id: mandateId, change: { AddRecipient: recipient } };
      let res;
      try {
        res = session.isDry
          ? await session.mockEngine.callFunctionRaw({ contractId: session.contractId, methodName: 'loosen', args, deposit: 0n, senderId: gAcc.accountId })
          : await gAcc.callFunctionRaw({ contractId: session.contractId, methodName: 'loosen', args, gas: T(30) });
      } catch (e) {
        return { ok: false, reason: `prep AddRecipient ${recipient} failed: ${e.message}` };
      }
      if (res?.error || res?.status?.Failure) {
        return { ok: false, reason: `prep AddRecipient ${recipient} failed: ${res.error || JSON.stringify(res.status.Failure)}` };
      }
    }
  }

  // 12. pendingRequest: 'fresh' | 'stale' (H3, KAT-E-10-21 and KAT-E-05-25)
  // resolve_stale needs a real Pending entry; STALE_BLOCKS = 200 (lib.rs:21). Dry mode can hold one
  // deterministically. On testnet `on_payment_done` removes it after ~1-2 blocks, so only a stuck
  // callback is stale; report the case as SKIPPED instead of faking a verdict.
  if (p.pendingRequest !== undefined || p.isStale) {
    const stale = p.pendingRequest === 'stale' || p.isStale === true;
    if (!session.isDry) {
      return {
        ok: false,
        reason: `Pending exists only until on_payment_done settles it (~1-2 blocks), so a ${stale ? 'stale' : 'fresh'} Pending cannot be held on testnet; needs a stuck callback; covered offline`,
      };
    }
    const m = session.mockEngine.mandates.get(mandateId);
    if (!m) return { ok: false, reason: `mandate ${mandateId} not found` };
    const requestId = Number(p.args?.request_id ?? 1);
    const key = `${mandateId}:${requestId}`;
    if (!session.mockEngine.pending.has(key)) {
      const amount = BigInt(p.amount || p.args?.amount || '1000');
      const head = await session.provider.viewBlock({ finality: 'optimistic' });
      session.mockEngine.pending.set(key, {
        recipient: p.args?.recipient || m.recipients[0] || session.merchantId,
        amount,
        height: stale ? Math.max(head.header.height - 200, 0) : head.header.height,
      });
      m.reserved += amount;
      m.open_requests = (m.open_requests ?? 0) + 1;
    } else {
      const entry = session.mockEngine.pending.get(key);
      if (m.reserved < entry.amount) {
        m.reserved = entry.amount;
      }
      if ((m.open_requests ?? 0) === 0) {
        m.open_requests = 1;
      }
    }
  }

  return { ok: true };
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

  // Isolation: every catalog case is an independent scenario written against a FRESH mandate (budget 1250000,
  // cap 500000). Sharing mandate 1 made earlier cases spend its budget, so later expectations failed with
  // OVER_BUDGET (waves 1-3). Give each case its own mandate AND that mandate's own agent, in run order.
  // Cases that name an agent (agentIndex) or another mandate on purpose (cross-agent / cross-mandate attacks)
  // keep their explicit targets.
  const seq = session.caseSeq ?? 0;
  session.caseSeq = seq + 1;
  if (
    c.params &&
    session.mandates.length > 1 &&
    c.params.agentIndex === undefined &&
    (c.params.mandate_id === undefined || c.params.mandate_id === 1)
  ) {
    // Use the pre-increment sequence: getMandateIndexForCase reads session.caseSeq, and the
    // increment above must not shift the first case onto a different mandate (regression:
    // state-prep tests for mandate 1 were landing on mandate 2).
    const idx = getMandateIndexForCase(c, { ...session, caseSeq: seq });
    const own = session.mandates[idx].id;
    c = {
      ...c,
      params: {
        ...c.params,
        mandate_id: own,
        agentIndex: idx,
        ...(c.params.args && typeof c.params.args === 'object' ? { args: { ...c.params.args, mandate_id: own } } : {}),
      },
    };
  }

  const mandateId = c.params?.mandate_id ?? session.mandates[0]?.id ?? 1;
  const targetRecipient = c.params?.recipient || session.merchantId;

  // In dry mode, ensure fresh mandate baseline before case prep runs
  if (session.isDry && !c.params?.skipStatePrep) {
    const m = session.mockEngine?.mandates?.get(mandateId);
    if (m) {
      m.open_requests = 0;
      m.spent = 0n;
      m.reserved = 0n;
      m.approval_threshold = m.per_payment_cap;
      const needsRevoked = c.params?.mandateRevoked
        || (c.category === 10 && (c.expected?.code === 'NOT_ACTIVE' || c.expected?.code === 'ALREADY_REVOKED'));
      if (!needsRevoked && m.status === 'Revoked') {
        m.status = 'Active';
      }
    }
  }

  // Bring the mandate into the state this case is written against; if that is impossible, do not fake a verdict.
  // A network error while preparing (or reading the baseline) is infrastructure, not a verdict: the case is NOT executed.
  const infraSkip = (e) => ({ label: 'SKIPPED', code: 'INFRA_ERROR', txHash: null, note: `state preparation hit RPC/network error: ${String(e?.message ?? e).slice(0, 160)}; case not executed, not a verdict, rerun` });
  let prep;
  try {
    prep = await prepareCaseState(c, session);
  } catch (e) {
    if (isInfraError(e?.message)) return infraSkip(e);
    throw e;
  }
  if (!prep.ok) {
    const txHash = session.isDry ? `TX_E_DRY_${c.id}_${Date.now()}` : null;
    if (isInfraError(prep.reason)) return infraSkip({ message: prep.reason });
    return { label: 'SKIPPED', code: 'STATE_PREP_UNAVAILABLE', txHash, note: prep.reason };
  }
  try {
    await waitForSettlement(session, mandateId);
  } catch (e) {
    if (isInfraError(e?.message)) return infraSkip(e);
    throw e;
  }

  // Snapshot before
  let beforeMandate;
  let beforeMerchBal;
  try {
    beforeMandate = await readMandateStrict(session, mandateId);
    beforeMerchBal = await session.viewFtBalance(targetRecipient);
  } catch (e) {
    if (isInfraError(e?.message)) return infraSkip(e);
    throw e;
  }
  const stateBefore = beforeMandate ? {
    ...beforeMandate,
    merchantBalance: beforeMerchBal,
  } : null;

  let actual;
  let topUpNote = null;

  if (session.isDry) {
    // Simulated mock execution
    let txHash = `TX_E_DRY_${c.id}_${Date.now()}`;
    const p = c.params || {};

    if ((p.method || 'request_payment') === 'approve_intent') {
      const gId = session.guardianKeyPairs[c.params?.agentIndex ?? 0]?.id;
      const res = await session.mockEngine.callFunctionRaw({
        contractId: session.contractId,
        methodName: 'approve_intent',
        args: p.args || {},
        deposit: p.deposit ? BigInt(p.deposit) : 2_000_000_000_000_000_000_000n,
        senderId: gId,
      });
      if (res.error) {
        actual = { label: 'BLOCKED', code: res.error, txHash, note: `Mock SCRIP_ERR: ${res.error}` };
      } else {
        actual = { label: 'INERT', txHash, note: 'Mock approve_intent accepted' };
      }
    } else if (p.invalidSignature || p.forgedKey) {
      actual = {
        label: 'BLOCKED',
        code: p.forgedKey ? 'KEY_NOT_ALLOWED' : 'BAD_SIGNATURE',
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
    } else if ((p.method || 'request_payment') === 'request_payment' && session.mockEngine.mandates.get(mandateId)
      && (p.remainingBudget !== undefined || p.openRequestsCount !== undefined
          || c.expected?.code === 'NEEDS_APPROVAL' || c.expected?.code === 'APPROVAL_USED' || p.approvalAlreadyUsed
          || c.expected?.code === 'APPROVAL_EXPIRED' || p.approvalExpired || p.hasValidApproval)) {
      // Real rules for prepared-state families, so skipping preparation changes the outcome.
      const m = session.mockEngine.mandates.get(mandateId);
      const amt = BigInt(p.amount || p.args?.amount || '0');
      const ceil = m.budget < m.deposited - m.withdrawn ? m.budget : m.deposited - m.withdrawn;
      const now = Date.now();

      if (amt === 0n || amt > m.per_payment_cap) {
        actual = { label: 'BLOCKED', code: 'OVER_PER_PAYMENT_CAP', txHash, note: 'Mock: cap exceeded' };
      } else if ((m.open_requests ?? 0) >= MAX_OPEN) {
        actual = { label: 'BLOCKED', code: 'TOO_MANY_OPEN', txHash, note: 'Mock: queue full' };
      } else if (m.spent + m.reserved + amt > ceil) {
        actual = { label: 'BLOCKED', code: 'OVER_BUDGET', txHash, note: 'Mock: over remaining budget' };
      } else if (amt > m.approval_threshold) {
        const recipient = (p.args?.recipient === 'merchant.testnet' || !p.args?.recipient) ? session.merchantId : p.args.recipient;
        const nonce = Number(p.args?.nonce ?? 0);
        const key = `${mandateId}:${recipient}:${amt}:${nonce}`;
        const app = session.mockEngine.approvals.get(key);
        if (!app) {
          actual = { label: 'BLOCKED', code: 'NEEDS_APPROVAL', txHash, note: 'Mock: needs approval' };
        } else if (app.used) {
          actual = { label: 'BLOCKED', code: 'APPROVAL_USED', txHash, note: 'Mock: approval already used' };
        } else if (now >= app.expires_at_ms) {
          actual = { label: 'BLOCKED', code: 'APPROVAL_EXPIRED', txHash, note: 'Mock: approval expired' };
        } else {
          app.used = true;
          actual = { label: 'INERT', txHash, note: `Mock payment accepted for ${c.id}` };
        }
      } else {
        actual = { label: 'INERT', txHash, note: `Mock payment accepted for ${c.id}` };
      }
    } else if ((p.method || 'request_payment') === 'loosen'
      && (p.loosenBudgetPrep !== undefined || p.recipientsCount !== undefined)) {
      const gId = session.guardianKeyPairs[p.agentIndex ?? 0]?.id;
      const res = await session.mockEngine.callFunctionRaw({
        contractId: session.contractId,
        methodName: 'loosen',
        args: p.args || {},
        deposit: p.deposit ? BigInt(p.deposit) : 0n,
        senderId: gId,
      });
      actual = res.error
        ? { label: 'BLOCKED', code: res.error, txHash, note: `Mock SCRIP_ERR: ${res.error}` }
        : { label: 'INERT', code: null, txHash, note: `Mock loosen accepted for ${c.id}` };
    } else if (p.method === 'resolve_stale' && (p.pendingRequest !== undefined || p.isStale)) {
      const gId = session.guardianKeyPairs[p.agentIndex ?? 0]?.id;
      const res = await session.mockEngine.callFunctionRaw({
        contractId: session.contractId,
        methodName: 'resolve_stale',
        args: p.args || {},
        deposit: p.deposit ? BigInt(p.deposit) : 0n,
        senderId: gId,
      });
      actual = res.error
        ? { label: 'BLOCKED', code: res.error, txHash, note: `Mock SCRIP_ERR: ${res.error}` }
        : { label: 'INERT', code: null, txHash, note: `Mock resolve_stale accepted for ${c.id}` };
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
      const method = c.params?.method || 'request_payment';
      const route = routeMethod(method);

      if (c.params?.transport === 'rpc') {
        // Direct RPC transmission using the appropriate caller account
        const callerName = c.params?.senderId || c.params?.caller;
        // ft_on_transfer must be called by the TOKEN contract (lib.rs:467 predecessor == mandate.token). The legit token
        // cannot be impersonated from here, so those rows are not run (covered by the Rust tests, never counted as pass).
        if (method === 'ft_on_transfer' && isLegitTokenCaller(callerName)) {
          // REAL token caller: the funder calls ft_transfer_call on the USDC contract, so the token itself is the
          // predecessor of ft_on_transfer (lib.rs:463-473). The refund is proven from balances, logs and mandate state.
          const tcArgs = { ...(c.params?.args || {}) };
          const amountStr = String(tcArgs.amount ?? '0');
          if (!/^[1-9][0-9]*$/.test(amountStr)) {
            throw Object.assign(new Error('the USDC token rejects a zero or malformed amount before the contract is reached, so this row cannot prove the contract behaviour; covered by the Rust tests'), { skipCode: 'TOKEN_REJECTS_INPUT' });
          }
          const tokenId = session.usdcContractId;
          const readAll = async () => ({
            sender: await session.viewFtBalanceStrict(session.funderId),
            contract: await session.viewFtBalanceStrict(session.contractId),
            mandate: await session.viewMandateStrict(mandateId),
          });
          let before; let after; let txRes;
          try {
            await waitForSettlement(session, mandateId);
            before = await readAll();
            txRes = await withRetry(() => session.funderAcc.callFunctionRaw({
              contractId: tokenId,
              methodName: 'ft_transfer_call',
              args: { receiver_id: session.contractId, amount: amountStr, msg: buildTokenCallerMsg(tcArgs, c.params, mandateId) },
              gas: T(150),
              deposit: 1n,
            }), { tries: 3 });
            await new Promise((r) => setTimeout(r, 3000));
            await waitForSettlement(session, mandateId);
            after = await readAll();
          } catch (e) {
            if (isInfraError(e?.message)) {
              actual = { label: 'SKIPPED', code: 'INFRA_ERROR', txHash: null, note: `token-caller proof hit RPC/network error: ${String(e?.message ?? e).slice(0, 160)}; not a verdict, rerun` };
            } else {
              actual = await classifyTxError(e, session, session.funderId, { method: 'ft_transfer_call', deposit: 1n, contractId: tokenId });
            }
            txHash = actual.txHash ?? null;
          }
          if (!actual) {
            const logs = (txRes?.receipts_outcome ?? []).flatMap((o) => o?.outcome?.logs ?? []);
            actual = {
              ...classifyTokenCallerOutcome({
                amount: amountStr,
                senderBefore: before.sender, senderAfter: after.sender,
                contractBefore: before.contract, contractAfter: after.contract,
                logs, mandateBefore: before.mandate, mandateAfter: after.mandate,
              }),
              txHash: txRes?.transaction?.hash ?? txRes?.transaction_outcome?.id ?? null,
            };
            txHash = actual.txHash;
          }
          return actual;
        }
        const callerAcc = getCallerAccount(session, callerName, c.params?.agentIndex ?? 0);
        let mappedArgs = { ...(c.params?.args || {}) };
        if (mappedArgs.mandate_id !== undefined) mappedArgs.mandate_id = mandateId;

        // Map symbolic caller name in args to actual signer accountId so that
        // owner == agent (05-37) or guardian == owner (05-38) matches the actual signer
        if (callerName && callerAcc?.accountId) {
          mappedArgs = mapCallerInArgs(mappedArgs, callerName, callerAcc.accountId);
        }

        // Direct RPC calls (category 5) have no facilitator default; 60 Tgas covers withdraw's minimum.
        const gas = c.params?.gas ? BigInt(c.params.gas) : T(60);
        const deposit = c.params?.deposit ? BigInt(c.params.deposit) : 0n;
        topUpNote = await ensureCallerFunded(session, callerAcc.accountId, deposit);

        try {
          const res = await callerAcc.callFunctionRaw({
            contractId: session.contractId,
            methodName: method,
            args: mappedArgs,
            gas,
            deposit,
          });
          if (method === 'ft_on_transfer') {
            // Non-token account calls ft_on_transfer directly: only a full refund with unchanged state counts as blocked.
            const snap = (m) => (m ? JSON.stringify(m, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)) : null);
            await waitForSettlement(session, mandateId);
            const mandateAfter = await session.viewMandate(mandateId);
            const stateUnchanged = beforeMandate !== null && snap(beforeMandate) === snap(mandateAfter);
            actual = {
              ...classifyFtOnTransfer(res, mappedArgs.amount, { stateUnchanged }),
              txHash: res?.transaction?.hash ?? res?.transaction_outcome?.id ?? null,
            };
          } else {
            actual = classifyTxResult(res);
          }
          txHash = actual.txHash;
        } catch (err) {
          actual = await classifyTxError(err, session, callerAcc.accountId, {
            method,
            deposit,
            contractId: session.contractId,
          });
          txHash = actual.txHash;
        }
      } else if (route === 'approve_intent') {
        const gAcc = getGuardianAcc(session, c.params?.agentIndex ?? 0);
        const deposit = c.params.deposit !== undefined ? BigInt(c.params.deposit) : 2_000_000_000_000_000_000_000n;
        const mappedArgs = { ...(c.params?.args || {}) };
        if (mappedArgs.mandate_id !== undefined) mappedArgs.mandate_id = mandateId;
        topUpNote = await ensureCallerFunded(session, gAcc.accountId, deposit);

        try {
          const txRes = await gAcc.callFunctionRaw({
            contractId: session.contractId,
            methodName: 'approve_intent',
            args: mappedArgs,
            gas: c.params.gas ? BigInt(c.params.gas) : T(30),
            deposit,
          });
          actual = classifyTxResult(txRes);
          txHash = actual.txHash;
        } catch (err) {
          actual = await classifyTxError(err, session, gAcc.accountId, {
            method: 'approve_intent',
            deposit,
            contractId: session.contractId,
          });
          txHash = actual.txHash;
        }
      } else if (route === 'owner') {
        // Owner methods (revoke, withdraw, tighten) called directly via funderAcc.
        const mappedArgs = { ...(c.params?.args || {}) };
        if (mappedArgs.mandate_id !== undefined) mappedArgs.mandate_id = mandateId;

        const gas = c.params?.gas
          ? BigInt(c.params.gas)
          : (method === 'withdraw' ? T(60) : T(30));
        const deposit = c.params?.deposit ? BigInt(c.params.deposit) : 0n;

        try {
          const txRes = await callAsOwner(session, method, mappedArgs, { gas, deposit });
          actual = classifyTxResult(txRes);
          txHash = actual.txHash;
        } catch (err) {
          actual = await classifyTxError(err, session, session.funderAcc.accountId, {
            method,
            deposit,
            contractId: session.contractId,
          });
          txHash = actual.txHash;
        }
      } else if (route === 'guardian') {
        // Guardian methods (loosen, resolve_stale) called directly via guardianAcc
        const gAcc = getGuardianAcc(session, c.params?.agentIndex ?? 0);
        const mappedArgs = { ...(c.params?.args || {}) };
        if (mappedArgs.mandate_id !== undefined) mappedArgs.mandate_id = mandateId;

        const gas = c.params?.gas ? BigInt(c.params.gas) : T(30);
        const deposit = c.params?.deposit ? BigInt(c.params.deposit) : 0n;
        topUpNote = await ensureCallerFunded(session, gAcc.accountId, deposit);

        try {
          const txRes = await gAcc.callFunctionRaw({
            contractId: session.contractId,
            methodName: method,
            args: mappedArgs,
            gas,
            deposit,
          });
          actual = classifyTxResult(txRes);
          txHash = actual.txHash;
        } catch (err) {
          actual = await classifyTxError(err, session, gAcc.accountId, {
            method,
            deposit,
            contractId: session.contractId,
          });
          txHash = actual.txHash;
        }
      } else {
        // Facilitator /relay transmission
        let b64;
        if (c.params?.signed_delegate) {
          b64 = c.params.signed_delegate;
        } else {
          // Every attack parameter (key spec, receiver, nonce, maxBlockHeight, action count, tampering) is applied
          // for real by planRelayAttack/buildAttackDelegate; the facilitator alone decides the verdict.
          const skip = (skipCode, note) => Object.assign(new Error(note), { skipCode });
          let plan;
          try {
            plan = planRelayAttack(c.params);
          } catch (e) {
            throw skip('BAD_ATTACK_PARAMS', e.message);
          }
          const delegateSender = c.params?.senderId || agent.id;
          let keyPair = plan.forgedKey ? KeyPair.fromRandom('ed25519') : agent.fcKey;
          if (plan.keySpec) {
            // The key under attack is a NEW key on the agent account (restricted differently, full access, ...).
            keyPair = KeyPair.fromRandom('ed25519');
            const admin = new Account(delegateSender, session.provider, new KeyPairSigner(agent.key));
            try {
              if (plan.keySpec.kind === 'FullAccess') {
                await withRetry(() => admin.addFullAccessKey(keyPair.getPublicKey()));
              } else {
                await withRetry(() => admin.addFunctionCallAccessKey({
                  publicKey: keyPair.getPublicKey(),
                  contractId: plan.keySpec.receiverId ?? session.contractId,
                  methodNames: plan.keySpec.methodNames,
                  allowance: plan.keySpec.allowance ?? nearToYocto('0.25'),
                }));
              }
            } catch (e) {
              throw skip('KEY_SETUP_FAILED', `could not add the attacked key on-chain, attack not sent: ${String(e.message).slice(0, 120)}`);
            }
          }
          const head = await withRetry(() => session.provider.viewBlock({ finality: 'optimistic' }));
          const pub = keyPair.getPublicKey();
          let onChainNonce = 0n;
          try {
            const k = await withRetry(() => session.provider.viewAccessKey({ accountId: delegateSender, publicKey: pub.toString() }));
            onChainNonce = BigInt(k?.nonce ?? 0);
          } catch (e) {
            // A forged key legitimately has no access key; for every other key a failed lookup would fake NONCE_TOO_LOW.
            if (!plan.forgedKey) throw skip('KEY_NONCE_UNAVAILABLE', `access key nonce lookup failed: ${String(e.message).slice(0, 120)}`);
          }
          const built = await buildAttackDelegate({
            plan,
            keyPair,
            senderId: delegateSender,
            contractId: session.contractId,
            onChainNonce,
            headHeight: head.header.height,
            method: c.params?.method || 'request_payment',
            args: c.params?.args || {
              mandate_id: mandateId,
              recipient: targetRecipient,
              amount: c.params?.amount || '100000',
              nonce: c.params?.paymentNonce || 1,
            },
            gas: c.params?.gas ? BigInt(c.params.gas) : T(100),
          });
          b64 = built.b64;
        }

        const res = await fetch(url, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ signed_delegate: b64 }),
        });

        const status = res.status;
        const json = await res.json().catch(() => null);
        txHash = json?.tx_hash;

        if (status === 429 || status === 502 || status === 503 || status === 504) {
          actual = { label: 'SKIPPED', code: 'INFRA_ERROR', txHash, note: `RPC/upstream outage (HTTP ${status}); not a verdict, rerun` };
        } else if (status >= 400) {
          actual = {
            label: 'BLOCKED',
            code: json?.code || json?.invalidReason || `HTTP_${status}`,
            txHash,
            note: json?.message || `HTTP ${status}`,
          };
        } else if (txHash) {
          // Read transaction events without retries on failure (tanpa retry untuk TX_FAILED)
          const txRes = await withRetry(() => session.provider.sendJsonRpc('tx', [txHash, session.relayerId]));
          actual = classifyTxResult(txRes);
          txHash = actual.txHash;
        } else {
          actual = {
            label: 'INERT',
            note: `Relayed with status ${status}`,
          };
        }
      }
    } catch (err) {
      actual = err.skipCode
        ? { label: 'SKIPPED', code: err.skipCode, txHash, note: `${err.message}; not a verdict` }
        : isInfraError(err.message)
        ? { label: 'SKIPPED', code: 'INFRA_ERROR', txHash, note: `RPC/network outage: ${String(err.message).slice(0, 120)}; not a verdict, rerun` }
        : {
        label: 'BLOCKED',
        code: 'TX_FAILED',
        txHash,
        note: `Transaction failed: ${err.message}`,
      };
    }
  }

  // Snapshot after & state breach verification (let in-flight payment callbacks settle first)
  await waitForSettlement(session, mandateId);
  const afterMandate = await session.viewMandate(mandateId);
  const afterMerchBal = await session.viewFtBalance(targetRecipient);
  const stateAfter = afterMandate ? {
    ...afterMandate,
    merchantBalance: afterMerchBal,
  } : null;

  if (stateBefore && stateAfter && actual.label !== 'SKIPPED') {
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

  if (topUpNote) actual = { ...actual, note: `${actual.note ? actual.note + '; ' : ''}${topUpNote}` };
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
