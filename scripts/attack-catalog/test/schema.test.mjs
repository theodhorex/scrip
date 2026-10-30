import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  validateCase,
  validateCases,
  summarize,
  VALID_CATEGORIES,
  VALID_LAYERS,
  EXPECTED_LABELS,
  ACTUAL_LABELS,
} from '../schema.mjs';

function makeValidCase(overrides = {}) {
  return {
    id: 'KAT-C-001',
    category: 1,
    layer: 'C',
    title: 'Recipient with uppercase chars',
    params: { recipient: 'ALICE.near', amount: '1000' },
    expected: { label: 'BLOCKED', code: 'RangeError' },
    ...overrides,
  };
}

test('validateCase accepts a valid case without actual/verdict', () => {
  const c = makeValidCase();
  const validated = validateCase(c);
  assert.equal(validated.id, 'KAT-C-001');
});

test('validateCase accepts a valid case with actual and verdict', () => {
  const c = makeValidCase({
    actual: { label: 'BLOCKED', code: 'RangeError', note: 'blocked by regex', txHash: 'tx123' },
    verdict: 'PASS',
  });
  const validated = validateCase(c);
  assert.equal(validated.verdict, 'PASS');
  assert.equal(validated.actual.label, 'BLOCKED');
});

test('validateCase rejects invalid case structure', () => {
  assert.throws(() => validateCase(null), TypeError);
  assert.throws(() => validateCase('not an object'), TypeError);
  assert.throws(() => validateCase([]), TypeError);
});

test('validateCase rejects missing or empty id', () => {
  assert.throws(() => validateCase(makeValidCase({ id: '' })), TypeError);
  assert.throws(() => validateCase(makeValidCase({ id: '   ' })), TypeError);
  assert.throws(() => validateCase(makeValidCase({ id: null })), TypeError);
});

test('validateCase rejects invalid category', () => {
  assert.throws(() => validateCase(makeValidCase({ category: 0 })), RangeError);
  assert.throws(() => validateCase(makeValidCase({ category: 13 })), RangeError);
  assert.throws(() => validateCase(makeValidCase({ category: '1' })), RangeError);
});

test('validateCase rejects invalid layer', () => {
  assert.throws(() => validateCase(makeValidCase({ layer: 'F' })), RangeError);
  assert.throws(() => validateCase(makeValidCase({ layer: 'c' })), RangeError);
});

test('validateCase rejects missing expected', () => {
  const c = makeValidCase();
  delete c.expected;
  assert.throws(() => validateCase(c), TypeError);
  assert.throws(() => validateCase(makeValidCase({ expected: null })), TypeError);
});

test('validateCase rejects foreign/unknown expected label', () => {
  assert.throws(() => validateCase(makeValidCase({ expected: { label: 'UNKNOWN' } })), RangeError);
  assert.throws(() => validateCase(makeValidCase({ expected: { label: 'BREACH' } })), RangeError); // BREACH not allowed in expected
});

test('validateCase rejects foreign/unknown actual label', () => {
  assert.throws(
    () => validateCase(makeValidCase({ actual: { label: 'INVALID_LABEL' } })),
    RangeError
  );
});

test('validateCase rejects invalid verdict', () => {
  assert.throws(() => validateCase(makeValidCase({ verdict: 'MAYBE' })), RangeError);
});

test('validateCases detects duplicate id', () => {
  const cases = [
    makeValidCase({ id: 'DUP-1' }),
    makeValidCase({ id: 'DUP-2' }),
    makeValidCase({ id: 'DUP-1' }),
  ];
  assert.throws(() => validateCases(cases), /Duplicate case id: DUP-1/);
});

test('summarize computes counts per category, layer, label, and gathers breaches', () => {
  const cases = [
    makeValidCase({
      id: 'C-01',
      category: 1,
      layer: 'C',
      expected: { label: 'BLOCKED', code: 'RangeError' },
      actual: { label: 'BLOCKED', code: 'RangeError' },
      verdict: 'PASS',
    }),
    makeValidCase({
      id: 'C-02',
      category: 2,
      layer: 'C',
      expected: { label: 'BLOCKED' },
      actual: { label: 'INERT' },
      verdict: 'FAIL',
    }),
    makeValidCase({
      id: 'A-01',
      category: 1,
      layer: 'A',
      expected: { label: 'BLOCKED' },
      actual: { label: 'BREACH', note: 'funds stolen' },
      verdict: 'BREACH',
    }),
    makeValidCase({
      id: 'B-01',
      category: 9,
      layer: 'B',
      expected: { label: 'BLOCKED' },
      verdict: 'SKIPPED',
    }),
  ];

  const s = summarize(cases);
  assert.equal(s.total, 4);
  assert.equal(s.verdicts.PASS, 1);
  assert.equal(s.verdicts.FAIL, 1);
  assert.equal(s.verdicts.BREACH, 1);
  assert.equal(s.verdicts.SKIPPED, 1);

  // Category checks
  assert.equal(s.byCategory[1].total, 2);
  assert.equal(s.byCategory[1].PASS, 1);
  assert.equal(s.byCategory[1].BREACH, 1);
  assert.equal(s.byCategory[2].total, 1);
  assert.equal(s.byCategory[2].FAIL, 1);
  assert.equal(s.byCategory[9].total, 1);
  assert.equal(s.byCategory[9].SKIPPED, 1);

  // Layer checks
  assert.equal(s.byLayer.C.total, 2);
  assert.equal(s.byLayer.C.PASS, 1);
  assert.equal(s.byLayer.C.FAIL, 1);
  assert.equal(s.byLayer.A.total, 1);
  assert.equal(s.byLayer.A.BREACH, 1);
  assert.equal(s.byLayer.B.total, 1);
  assert.equal(s.byLayer.B.SKIPPED, 1);

  // Label checks (actual if present, else expected)
  assert.equal(s.byLabel.BLOCKED, 2); // C-01 (actual BLOCKED), B-01 (expected BLOCKED)
  assert.equal(s.byLabel.INERT, 1); // C-02 (actual INERT)
  assert.equal(s.byLabel.BREACH, 1); // A-01 (actual BREACH)

  // Breaches list
  assert.equal(s.breaches.length, 1);
  assert.equal(s.breaches[0].id, 'A-01');
});
