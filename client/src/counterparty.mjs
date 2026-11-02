// Counterparty evaluation module per track 'security' NEAR Hackathon.
// Pure function, Node built-ins only, no env reads, no console logging, no secrets.

import fs from 'node:fs/promises';
import { checkRecipient } from './intent.mjs';

const DEFAULT_TIMEOUT_MS = 4000;
const DEFAULT_MIN_AGE_MS = 7 * 24 * 60 * 60 * 1000; // 7 days
const DEFAULT_MIN_TX_COUNT = 3;
const NEAR_EMPTY_CODE_HASH = '11111111111111111111111111111111';
const BASE58_TX_HASH_PATTERN = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const MAX_EVIDENCE_URL_LENGTH = 300;

/**
 * Safely executes a provider function with timeout and fail-closed error handling.
 * @template T
 * @param {() => Promise<T>} fn
 * @param {number} timeoutMs
 * @returns {Promise<T>}
 */
async function callWithTimeout(fn, timeoutMs) {
  if (typeof fn !== 'function') {
    throw new Error('Provider function not found or not callable');
  }
  let timer;
  const timeoutPromise = new Promise((_, reject) => {
    timer = setTimeout(() => reject(new Error(`Provider timed out after ${timeoutMs}ms`)), timeoutMs);
  });
  try {
    return await Promise.race([fn(), timeoutPromise]);
  } finally {
    clearTimeout(timer);
  }
}

/**
 * Validates whether an evidence object carries at least one verifiable
 * reference: a base58 transaction hash (32-44 chars) or an http(s) URL
 * (max 300 chars). A free-text note is not evidence on its own.
 * @param {any} evidence
 * @returns {boolean}
 */
function isValidEvidence(evidence) {
  if (!evidence || typeof evidence !== 'object') {
    return false;
  }
  return isValidTxHash(evidence.txHash) || isValidEvidenceUrl(evidence.url);
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isValidTxHash(value) {
  return typeof value === 'string' && BASE58_TX_HASH_PATTERN.test(value.trim());
}

/**
 * @param {any} value
 * @returns {boolean}
 */
function isValidEvidenceUrl(value) {
  if (typeof value !== 'string') {
    return false;
  }
  const trimmed = value.trim();
  if (trimmed.length === 0 || trimmed.length > MAX_EVIDENCE_URL_LENGTH) {
    return false;
  }
  let parsed;
  try {
    parsed = new URL(trimmed);
  } catch (_) {
    return false;
  }
  return parsed.protocol === 'http:' || parsed.protocol === 'https:';
}

/**
 * Evaluates a counterparty receiver before payment.
 *
 * @param {object} input
 * @param {string} input.receiver       Recipient account ID
 * @param {string} [input.agentId]      Calling agent account ID
 * @param {object} [input.providers]    Injected data providers
 * @param {object} [input.policy]       Policy options
 * @param {number} [input.now]          Current timestamp override
 * @returns {Promise<{ verdict: 'allow'|'warn'|'block', score: number, reasons: Array<{ signal: string, level: 'info'|'warn'|'block', detail: string, source: string }> }>}
 */
export async function checkCounterparty({
  receiver,
  agentId = '',
  providers = {},
  policy = {},
  now
}) {
  // Validate recipient input first
  try {
    checkRecipient(receiver);
  } catch (err) {
    return {
      verdict: 'block',
      score: 100,
      reasons: [
        {
          signal: 'input',
          level: 'block',
          detail: `Invalid recipient: ${err.message}`,
          source: 'input'
        }
      ]
    };
  }

  const currentTime = typeof now === 'number' ? now : Date.now();
  const timeoutMs = policy?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const minAgeMs = policy?.minAgeMs ?? DEFAULT_MIN_AGE_MS;
  const minTxCount = policy?.minTxCount ?? DEFAULT_MIN_TX_COUNT;

  const reasons = [];
  let pendingPinAction = null;

  // 1. Signal: account_age
  try {
    const history = await callWithTimeout(
      () => providers?.accountHistory?.(receiver),
      timeoutMs
    );

    if (history === null || history === undefined || history.firstSeenMs === null || history.firstSeenMs === undefined) {
      reasons.push({
        signal: 'account_age',
        level: 'warn',
        detail: 'Account has never been seen before',
        source: 'history'
      });
    } else {
      const ageMs = currentTime - history.firstSeenMs;
      let ageWarn = false;
      if (ageMs < minAgeMs) {
        ageWarn = true;
        reasons.push({
          signal: 'account_age',
          level: 'warn',
          detail: `Account age (${Math.floor(ageMs / 1000)}s) is below required threshold (${Math.floor(minAgeMs / 1000)}s)`,
          source: 'history'
        });
      }
      const txCount = history.txCount ?? 0;
      if (txCount < minTxCount) {
        ageWarn = true;
        reasons.push({
          signal: 'account_age',
          level: 'warn',
          detail: `Transaction count (${txCount}) is below required threshold (${minTxCount})`,
          source: 'history'
        });
      }
      if (!ageWarn) {
        reasons.push({
          signal: 'account_age',
          level: 'info',
          detail: 'Account age and transaction history meet policy',
          source: 'history'
        });
      }
    }
  } catch (err) {
    reasons.push({
      signal: 'account_age',
      level: 'warn',
      detail: `Account history provider unavailable: ${err.message}`,
      source: 'unavailable'
    });
  }

  // 2. Signal: contract_code
  try {
    const state = await callWithTimeout(
      () => providers?.accountState?.(receiver),
      timeoutMs
    );

    if (!state || !state.exists) {
      reasons.push({
        signal: 'contract_code',
        level: 'warn',
        detail: 'Account does not exist on-chain',
        source: 'state'
      });
    } else if (!state.codeHash || state.codeHash === NEAR_EMPTY_CODE_HASH) {
      reasons.push({
        signal: 'contract_code',
        level: 'info',
        detail: 'Account is not a contract (no code hash)',
        source: 'state'
      });
    } else {
      let pinnedHash = null;
      try {
        pinnedHash = await callWithTimeout(
          () => providers?.codePin?.get?.(receiver),
          timeoutMs
        );
      } catch (_) {
        pinnedHash = null;
      }

      if (pinnedHash === null || pinnedHash === undefined) {
        reasons.push({
          signal: 'contract_code',
          level: 'warn',
          detail: 'New contract seen for the first time',
          source: 'state'
        });
        pendingPinAction = async () => {
          if (typeof providers?.codePin?.set === 'function') {
            await providers.codePin.set(receiver, state.codeHash);
          }
        };
      } else if (pinnedHash !== state.codeHash) {
        reasons.push({
          signal: 'contract_code',
          level: 'warn',
          detail: 'Contract code changed since last seen (kode berubah sejak terakhir dilihat)',
          source: 'state'
        });
      } else {
        reasons.push({
          signal: 'contract_code',
          level: 'info',
          detail: 'Contract code matches pinned hash',
          source: 'state'
        });
      }
    }
  } catch (err) {
    reasons.push({
      signal: 'contract_code',
      level: 'warn',
      detail: `Account state provider unavailable: ${err.message}`,
      source: 'unavailable'
    });
  }

  // 3. Signal: prior_interaction
  try {
    const interaction = await callWithTimeout(
      () => providers?.interactions?.(agentId, receiver),
      timeoutMs
    );

    const count = interaction?.count ?? 0;
    if (count <= 0) {
      reasons.push({
        signal: 'prior_interaction',
        level: 'warn',
        detail: 'New receiver for this agent (penerima baru bagi agen ini)',
        source: 'interactions'
      });
    } else {
      reasons.push({
        signal: 'prior_interaction',
        level: 'info',
        detail: `Prior interactions with receiver: ${count}`,
        source: 'interactions'
      });
    }
  } catch (err) {
    reasons.push({
      signal: 'prior_interaction',
      level: 'warn',
      detail: `Prior interactions provider unavailable: ${err.message}`,
      source: 'unavailable'
    });
  }

  // 4. Signal: blocklist
  try {
    const entry = await callWithTimeout(
      () => providers?.blocklist?.lookup?.(receiver),
      timeoutMs
    );

    if (entry === null || entry === undefined) {
      reasons.push({
        signal: 'blocklist',
        level: 'info',
        detail: 'Receiver is not on blocklist',
        source: 'blocklist'
      });
    } else if (isValidEvidence(entry.evidence)) {
      reasons.push({
        signal: 'blocklist',
        level: 'block',
        detail: `Receiver is on blocklist (reported by ${entry.reportedBy || 'unknown'})`,
        source: 'blocklist'
      });
    } else {
      reasons.push({
        signal: 'blocklist',
        level: 'warn',
        detail: 'Blocklist entry ignored: report without evidence (laporan tanpa bukti)',
        source: 'blocklist'
      });
    }
  } catch (err) {
    reasons.push({
      signal: 'blocklist',
      level: 'warn',
      detail: `Blocklist provider unavailable: ${err.message}`,
      source: 'unavailable'
    });
  }

  // Aggregation & scoring
  const hasBlock = reasons.some((r) => r.level === 'block');
  const hasWarn = reasons.some((r) => r.level === 'warn');

  let verdict = 'allow';
  if (hasBlock) {
    verdict = 'block';
  } else if (hasWarn) {
    verdict = 'warn';
  }

  let score = 0;
  for (const r of reasons) {
    if (r.level === 'block') {
      score += 100;
    } else if (r.level === 'warn') {
      score += 20;
    }
  }
  score = Math.min(100, Math.max(0, score));

  // Only record code pin if final verdict is NOT block
  if (verdict !== 'block' && pendingPinAction) {
    try {
      await pendingPinAction();
    } catch (_) {
      // Pin recording failure does not override verdict
    }
  }

  return {
    verdict,
    score,
    reasons
  };
}

/**
 * Creates default concrete providers for counterparty verification.
 *
 * @param {object} options
 * @param {string} [options.rpcUrl]          NEAR JSON-RPC endpoint
 * @param {string} [options.indexerUrl]      HTTP indexer URL
 * @param {string} [options.blocklistPath]   Path to local JSON blocklist
 * @param {string} [options.interactionLog]  Path to local JSON interaction log
 * @param {string} [options.codePinPath]     Path to local JSON code pin store
 * @param {number} [options.timeoutMs]       Default fetch timeout in ms
 * @returns {object} providers
 */
export function createDefaultProviders({
  rpcUrl,
  indexerUrl,
  blocklistPath,
  interactionLog,
  codePinPath,
  timeoutMs = DEFAULT_TIMEOUT_MS
} = {}) {
  return {
    accountState: async (receiver) => {
      if (!rpcUrl) {
        return { exists: false, codeHash: null };
      }
      const res = await fetch(rpcUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          jsonrpc: '2.0',
          id: 'counterparty-check',
          method: 'query',
          params: {
            request_type: 'view_account',
            finality: 'final',
            account_id: receiver
          }
        }),
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) {
        throw new Error(`RPC returned HTTP status ${res.status}`);
      }
      const data = await res.json();
      if (data.error) {
        return { exists: false, codeHash: null };
      }
      const rawHash = data.result?.code_hash;
      const codeHash = rawHash && rawHash !== NEAR_EMPTY_CODE_HASH ? rawHash : null;
      return { exists: true, codeHash };
    },

    accountHistory: async (receiver) => {
      if (!indexerUrl) {
        return null;
      }
      const url = new URL(indexerUrl);
      url.searchParams.set('account_id', receiver);
      const res = await fetch(url.toString(), {
        method: 'GET',
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(timeoutMs)
      });
      if (!res.ok) {
        throw new Error(`Indexer returned HTTP status ${res.status}`);
      }
      const data = await res.json();
      return {
        firstSeenMs: data.firstSeenMs ?? null,
        txCount: data.txCount ?? 0
      };
    },

    blocklist: {
      lookup: async (receiver) => {
        if (!blocklistPath) return null;
        try {
          const content = await fs.readFile(blocklistPath, 'utf8');
          const data = JSON.parse(content);
          if (Array.isArray(data)) {
            return (
              data.find(
                (item) => item.receiver === receiver || item.accountId === receiver
              ) ?? null
            );
          }
          return data[receiver] ?? null;
        } catch (err) {
          if (err.code === 'ENOENT') return null;
          throw err;
        }
      }
    },

    codePin: {
      get: async (receiver) => {
        if (!codePinPath) return null;
        try {
          const content = await fs.readFile(codePinPath, 'utf8');
          const data = JSON.parse(content);
          return data[receiver] ?? null;
        } catch (err) {
          if (err.code === 'ENOENT') return null;
          throw err;
        }
      },
      set: async (receiver, codeHash) => {
        if (!codePinPath) return;
        let data = {};
        try {
          const content = await fs.readFile(codePinPath, 'utf8');
          data = JSON.parse(content);
        } catch (err) {
          if (err.code !== 'ENOENT') throw err;
        }
        data[receiver] = codeHash;
        const tmpPath = `${codePinPath}.${Date.now()}.${Math.random().toString(36).slice(2)}.tmp`;
        await fs.writeFile(tmpPath, JSON.stringify(data, null, 2), 'utf8');
        await fs.rename(tmpPath, codePinPath);
      }
    },

    interactions: async (agentId, receiver) => {
      if (!interactionLog) return { count: 0, lastMs: null };
      try {
        const content = await fs.readFile(interactionLog, 'utf8');
        const data = JSON.parse(content);
        if (Array.isArray(data)) {
          const matches = data.filter(
            (entry) =>
              (!entry.agentId || entry.agentId === agentId) &&
              (entry.receiver === receiver || entry.recipient === receiver)
          );
          const count = matches.length;
          const lastMs =
            count > 0
              ? Math.max(...matches.map((m) => m.ts ?? m.timestamp ?? 0))
              : null;
          return { count, lastMs };
        }
        const direct =
          data[agentId]?.[receiver] ??
          data[`${agentId}:${receiver}`] ??
          data[receiver];
        if (typeof direct === 'number') {
          return { count: direct, lastMs: null };
        }
        if (direct && typeof direct === 'object') {
          return { count: direct.count ?? 0, lastMs: direct.lastMs ?? null };
        }
        return { count: 0, lastMs: null };
      } catch (err) {
        if (err.code === 'ENOENT') return { count: 0, lastMs: null };
        throw err;
      }
    }
  };
}
