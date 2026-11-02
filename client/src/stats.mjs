// Per-mandate stats reducer over validated scrip events (PRD 3.3/3.5). Pure: no I/O.
import { toBig } from './events.mjs';

export class InvariantError extends Error {
  constructor(message) {
    super(message);
    this.name = 'InvariantError';
  }
}

/**
 * @typedef {object} MandateStats
 * @property {bigint} deposited
 * @property {bigint} reserved
 * @property {bigint} spent
 * @property {bigint} refunded
 * @property {bigint} withdrawn
 * @property {Object<string, number>} rejectedByCode
 * @property {number} open
 */

/** @returns {MandateStats} */
function emptyStats() {
  return { deposited: 0n, reserved: 0n, spent: 0n, refunded: 0n, withdrawn: 0n, rejectedByCode: {}, open: 0 };
}

function release(s, id, event, amount, toSpent) {
  if (amount > s.reserved) {
    throw new InvariantError(`mandate ${id}: ${event} of ${amount} exceeds reserved ${s.reserved}`);
  }
  if (s.open < 1) throw new InvariantError(`mandate ${id}: ${event} with no open request`);
  s.reserved -= amount;
  s.open -= 1;
  if (toSpent) s.spent += amount;
  else s.refunded += amount;
}

/**
 * @param {import('./events.mjs').ScripEvent[]} events
 * @returns {Map<number, MandateStats>} keyed by mandate_id
 * @throws {InvariantError}
 */
export function reduceEvents(events) {
  const stats = new Map();
  for (const ev of events) {
    for (const d of ev.data) {
      let s = stats.get(d.mandate_id);
      if (!s) stats.set(d.mandate_id, (s = emptyStats()));
      const amount = toBig(d.amount);
      switch (ev.event) {
        case 'deposited':
          s.deposited += amount;
          break;
        case 'withdrawn':
          if (s.withdrawn + amount > s.deposited) {
            throw new InvariantError(`mandate ${d.mandate_id}: withdrawn exceeds deposited`);
          }
          s.withdrawn += amount;
          break;
        case 'reserved':
          s.reserved += amount;
          s.open += 1;
          break;
        case 'settled':
          release(s, d.mandate_id, ev.event, amount, true);
          break;
        case 'refunded':
          release(s, d.mandate_id, ev.event, amount, false);
          break;
        case 'stale_resolved':
          release(s, d.mandate_id, ev.event, amount, d.transferred === true);
          break;
        case 'rejected':
          s.rejectedByCode[d.code] = (s.rejectedByCode[d.code] ?? 0) + 1;
          break;
        default:
          break; // mandate_created, intent_approved, tightened, loosened, revoked: no totals
      }
    }
  }
  return stats;
}

/**
 * @param {MandateStats} state
 * @param {bigint|string} budget
 * @returns {{ok: boolean, overBy: bigint}} ok iff spent + reserved <= budget
 */
export function checkBudget(state, budget) {
  const b = typeof budget === 'bigint' ? budget : toBig(budget);
  const used = state.spent + state.reserved;
  return used <= b ? { ok: true, overBy: 0n } : { ok: false, overBy: used - b };
}
