// NEP-297 event parser for the `scrip` standard (PRD 3.5). Pure: no I/O.

export const STANDARD = 'scrip';
export const VERSION = '1.0.0';
export const EVENT_NAMES = Object.freeze([
  'mandate_created', 'deposited', 'reserved', 'rejected', 'settled', 'refunded',
  'intent_approved', 'tightened', 'loosened', 'revoked', 'withdrawn', 'stale_resolved',
]);

const PREFIX = 'EVENT_JSON:';
const AMOUNT_RE = /^(0|[1-9][0-9]*)$/;

export class EventParseError extends Error {
  /** @param {string} message @param {number} lineNumber 1-based index in the logs array */
  constructor(message, lineNumber) {
    super(`line ${lineNumber}: ${message}`);
    this.name = 'EventParseError';
    this.lineNumber = lineNumber;
  }
}

/**
 * @typedef {object} EventData
 * @property {number} mandate_id
 * @property {number} [request_id]
 * @property {string} recipient
 * @property {string} amount     canonical decimal string
 * @property {string} [code]     required for `rejected`
 * @property {boolean} [transferred] required for `stale_resolved`
 * @typedef {{standard: 'scrip', version: '1.0.0', event: string, data: EventData[]}} ScripEvent
 */

/** Convert a canonical decimal amount string to BigInt. */
export function toBig(amount) {
  if (typeof amount !== 'string') throw new TypeError('amount must be a string');
  if (!AMOUNT_RE.test(amount)) throw new RangeError('amount must be canonical decimal digits');
  return BigInt(amount);
}

function validateData(event, d, n, i) {
  const where = `data[${i}]`;
  if (d === null || typeof d !== 'object' || Array.isArray(d)) {
    throw new EventParseError(`${where} must be an object`, n);
  }
  if (!Number.isSafeInteger(d.mandate_id)) throw new EventParseError(`${where}.mandate_id must be an integer`, n);
  if ('request_id' in d && !Number.isSafeInteger(d.request_id)) {
    throw new EventParseError(`${where}.request_id must be an integer`, n);
  }
  if (typeof d.recipient !== 'string') throw new EventParseError(`${where}.recipient must be a string`, n);
  if (typeof d.amount !== 'string' || !AMOUNT_RE.test(d.amount)) {
    throw new EventParseError(`${where}.amount must be a canonical decimal string`, n);
  }
  if (event === 'rejected' && typeof d.code !== 'string') {
    throw new EventParseError(`${where}.code is required for rejected`, n);
  }
  if ('code' in d && typeof d.code !== 'string') throw new EventParseError(`${where}.code must be a string`, n);
  if (event === 'stale_resolved' && typeof d.transferred !== 'boolean') {
    throw new EventParseError(`${where}.transferred (boolean) is required for stale_resolved`, n);
  }
  if ('transferred' in d && typeof d.transferred !== 'boolean') {
    throw new EventParseError(`${where}.transferred must be a boolean`, n);
  }
}

/**
 * Extract and validate scrip events from contract logs.
 * @param {string[]} logs
 * @returns {ScripEvent[]}
 * @throws {EventParseError} on a malformed scrip line
 */
export function parseEventLogs(logs) {
  const out = [];
  logs.forEach((log, idx) => {
    const n = idx + 1;
    if (typeof log !== 'string' || !log.startsWith(PREFIX)) return;
    let obj;
    try {
      obj = JSON.parse(log.slice(PREFIX.length));
    } catch (err) {
      throw new EventParseError(`invalid JSON (${err.message})`, n);
    }
    if (obj === null || typeof obj !== 'object' || Array.isArray(obj)) {
      throw new EventParseError('event must be a JSON object', n);
    }
    if (obj.standard !== STANDARD) return; // foreign standard: ignore
    if (obj.version !== VERSION) throw new EventParseError(`unsupported version ${JSON.stringify(obj.version)}`, n);
    if (!EVENT_NAMES.includes(obj.event)) throw new EventParseError(`unknown event ${JSON.stringify(obj.event)}`, n);
    if (!Array.isArray(obj.data)) throw new EventParseError('data must be an array', n);
    obj.data.forEach((d, i) => validateData(obj.event, d, n, i));
    out.push(obj);
  });
  return out;
}
