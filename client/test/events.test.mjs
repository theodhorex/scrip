import { test } from 'node:test';
import assert from 'node:assert/strict';
import { parseEventLogs, toBig, EventParseError } from '../src/events.mjs';

const line = (obj) => 'EVENT_JSON:' + JSON.stringify(obj);
const ev = (event, data, over = {}) => ({ standard: 'amanat', version: '1.0.0', event, data, ...over });
const base = { mandate_id: 1, recipient: 'shop.testnet', amount: '100' };

test('parses valid events and keeps amounts as strings', () => {
  const out = parseEventLogs([
    line(ev('reserved', [{ ...base, request_id: 5 }])),
    line(ev('settled', [{ ...base, request_id: 5 }])),
  ]);
  assert.equal(out.length, 2);
  assert.equal(out[0].event, 'reserved');
  assert.equal(out[0].data[0].amount, '100');
  assert.equal(out[0].data[0].request_id, 5);
});

test('accepts every PRD event name', () => {
  const names = ['mandate_created', 'deposited', 'reserved', 'settled', 'refunded', 'intent_approved',
    'tightened', 'loosened', 'revoked', 'withdrawn'];
  for (const n of names) assert.equal(parseEventLogs([line(ev(n, [base]))]).length, 1, n);
  assert.equal(parseEventLogs([line(ev('rejected', [{ ...base, code: 'OVER_BUDGET' }]))]).length, 1);
  assert.equal(parseEventLogs([line(ev('stale_resolved', [{ ...base, transferred: true }]))]).length, 1);
});

test('ignores plain logs and foreign standards', () => {
  const out = parseEventLogs([
    'hello world',
    line({ standard: 'nep171', version: '1.0.0', event: 'nft_mint', data: [] }),
  ]);
  assert.deepEqual(out, []);
});

test('malformed JSON throws EventParseError with line number', () => {
  assert.throws(
    () => parseEventLogs(['ok', 'EVENT_JSON:{bad']),
    (e) => e instanceof EventParseError && e.lineNumber === 2,
  );
});

test('wrong version throws', () => {
  assert.throws(() => parseEventLogs([line(ev('reserved', [base], { version: '2.0.0' }))]), EventParseError);
});

test('unknown event throws', () => {
  assert.throws(() => parseEventLogs([line(ev('exploded', [base]))]), EventParseError);
});

test('data must be array of objects', () => {
  assert.throws(() => parseEventLogs([line(ev('reserved', base))]), EventParseError);
  assert.throws(() => parseEventLogs([line(ev('reserved', [5]))]), EventParseError);
  assert.throws(() => parseEventLogs([line(ev('reserved', [null]))]), EventParseError);
});

test('missing required fields throw', () => {
  for (const k of ['mandate_id', 'recipient', 'amount']) {
    const d = { ...base };
    delete d[k];
    assert.throws(() => parseEventLogs([line(ev('reserved', [d]))]), EventParseError, k);
  }
  assert.throws(() => parseEventLogs([line(ev('rejected', [base]))]), EventParseError);
  assert.throws(() => parseEventLogs([line(ev('stale_resolved', [base]))]), EventParseError);
});

test('field type errors throw', () => {
  assert.throws(() => parseEventLogs([line(ev('reserved', [{ ...base, mandate_id: 1.5 }]))]), EventParseError);
  assert.throws(() => parseEventLogs([line(ev('reserved', [{ ...base, mandate_id: '1' }]))]), EventParseError);
  assert.throws(() => parseEventLogs([line(ev('reserved', [{ ...base, request_id: 'x' }]))]), EventParseError);
  assert.throws(() => parseEventLogs([line(ev('stale_resolved', [{ ...base, transferred: 'yes' }]))]), EventParseError);
  assert.throws(() => parseEventLogs([line(ev('rejected', [{ ...base, code: 7 }]))]), EventParseError);
});

test('non-canonical amount throws', () => {
  for (const a of ['007', '-1', '1.5', '', ' 1', 100, '1e3']) {
    assert.throws(() => parseEventLogs([line(ev('reserved', [{ ...base, amount: a }]))]), EventParseError, String(a));
  }
});

test('error carries the line number of the offending line', () => {
  const lines = ['a', 'b', line(ev('reserved', [base])), line(ev('nope', [base]))];
  assert.throws(() => parseEventLogs(lines), (e) => e.lineNumber === 4);
});

test('toBig converts canonical strings and rejects others', () => {
  assert.equal(toBig('340282366920938463463374607431768211455'), (1n << 128n) - 1n);
  assert.equal(toBig('0'), 0n);
  assert.throws(() => toBig('01'), RangeError);
  assert.throws(() => toBig(5), TypeError);
});
