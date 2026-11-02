// Agent-side guarded signing wrapper per track 'security' NEAR Hackathon.
// Enforces allow/warn/block policies before delegating to the underlying signer.

import { checkCounterparty } from './counterparty.mjs';

/**
 * Thrown when counterparty evaluation yields a 'block' verdict.
 */
export class GuardBlockedError extends Error {
  /**
   * @param {string} [message]
   * @param {object} [options]
   * @param {'block'} [options.verdict]
   * @param {Array<object>} [options.reasons]
   */
  constructor(message = 'Guard blocked execution', { verdict = 'block', reasons = [] } = {}) {
    super(message);
    this.name = 'GuardBlockedError';
    this.verdict = verdict;
    this.reasons = reasons;
  }
}

/**
 * Thrown when counterparty evaluation or human confirmation results in denial.
 */
export class GuardDeniedError extends Error {
  /**
   * @param {string} [message]
   * @param {object} [options]
   * @param {string} [options.verdict]
   * @param {Array<object>} [options.reasons]
   */
  constructor(message = 'Guard denied execution', { verdict = 'warn', reasons = [] } = {}) {
    super(message);
    this.name = 'GuardDeniedError';
    this.verdict = verdict;
    this.reasons = reasons;
  }
}

/**
 * Wraps signing execution with counterparty risk checks.
 *
 * @template T
 * @param {object} input
 * @param {string} input.receiver                 Counterparty recipient account
 * @param {string} [input.agentId]                Calling agent identifier
 * @param {() => Promise<T>} input.sign           Underlying signing callback
 * @param {(params: { receiver: string, agentId?: string }) => Promise<any>} [input.checker] Custom counterparty checker
 * @param {(params: { receiver: string, reasons: Array<object> }) => Promise<boolean>} [input.askHuman] Confirmation prompt callback
 * @param {object} [input.policy]                 Guard and audit policy configuration
 * @param {(entry: { ts: number, receiver: string, verdict: string, decision: 'signed'|'blocked'|'denied' }) => void} [input.policy.audit] Audit callback
 * @param {number} [input.policy.now]             Timestamp override
 * @returns {Promise<T>} result of sign()
 */
export async function guardedSign({
  receiver,
  agentId = '',
  sign,
  checker,
  askHuman,
  policy = {}
}) {
  if (typeof sign !== 'function') {
    throw new TypeError('sign must be an executable function');
  }

  const activeChecker =
    typeof checker === 'function'
      ? checker
      : (args) =>
          checkCounterparty({
            ...args,
            providers: policy?.providers,
            policy,
            now: policy?.now
          });

  const now = typeof policy?.now === 'number' ? policy.now : Date.now();

  let checkResult;
  try {
    checkResult = await activeChecker({ receiver, agentId });
  } catch (err) {
    policy?.audit?.({
      ts: now,
      receiver,
      verdict: 'unknown',
      decision: 'denied'
    });
    throw new GuardDeniedError(
      `Checker failed or threw an error: ${err.message}`,
      { verdict: 'unknown', reasons: [] }
    );
  }

  if (
    !checkResult ||
    typeof checkResult !== 'object' ||
    !['allow', 'warn', 'block'].includes(checkResult.verdict)
  ) {
    policy?.audit?.({
      ts: now,
      receiver,
      verdict: 'unknown',
      decision: 'denied'
    });
    throw new GuardDeniedError(
      'Checker returned malformed output or unknown verdict',
      { verdict: 'unknown', reasons: [] }
    );
  }

  const { verdict, reasons = [] } = checkResult;

  if (verdict === 'block') {
    policy?.audit?.({
      ts: now,
      receiver,
      verdict: 'block',
      decision: 'blocked'
    });
    throw new GuardBlockedError('Execution blocked by guard', {
      verdict: 'block',
      reasons
    });
  }

  if (verdict === 'warn') {
    let approved = false;
    if (typeof askHuman === 'function') {
      try {
        const humanDecision = await askHuman({ receiver, reasons });
        approved = humanDecision === true;
      } catch (_) {
        approved = false;
      }
    }

    if (!approved) {
      policy?.audit?.({
        ts: now,
        receiver,
        verdict: 'warn',
        decision: 'denied'
      });
      throw new GuardDeniedError('Execution denied after warning', {
        verdict: 'warn',
        reasons
      });
    }

    policy?.audit?.({
      ts: now,
      receiver,
      verdict: 'warn',
      decision: 'signed'
    });
    return await sign();
  }

  // Verdict is 'allow'
  policy?.audit?.({
    ts: now,
    receiver,
    verdict: 'allow',
    decision: 'signed'
  });
  return await sign();
}
