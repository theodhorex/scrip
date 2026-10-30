// Unit test suite for C2 Attack Catalog extension (Layer C: Client and Parser Offline)
// Requirements:
// 1. Total cases >= 150
// 2. Unique IDs across all cases
// 3. Expected is present with valid label & code for every case
// 4. Conforms to validateCases schema
// 5. Covers Categories 1, 2, 4, 6, 8, 12

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCases } from '../schema.mjs';
import { runCatalog } from '../runner.mjs';
import { generateC2Cases } from '../cases/c2_extra.mjs';
import { executeLayerCExtra } from '../layers/client_extra.mjs';

test('C2 extra cases generator is defined and returns >= 150 cases', () => {
  assert.equal(typeof generateC2Cases, 'function');
  const cases = generateC2Cases();
  assert.ok(Array.isArray(cases), 'generateC2Cases must return an array');
  assert.ok(cases.length >= 150, `Expected at least 150 cases, got ${cases.length}`);
});

test('C2 cases have unique IDs, valid schemas, and required expected fields', () => {
  const cases = generateC2Cases();
  validateCases(cases);

  const seenIds = new Set();
  for (const c of cases) {
    assert.equal(c.layer, 'C', `Case ${c.id} must be layer C`);
    assert.ok(c.id.startsWith('KAT-C2-'), `Case ${c.id} must start with KAT-C2-`);
    assert.ok(!seenIds.has(c.id), `Duplicate ID detected: ${c.id}`);
    seenIds.add(c.id);

    assert.ok(c.expected, `Case ${c.id} missing expected`);
    assert.ok(['BLOCKED', 'INERT', 'OUT_OF_SCOPE'].includes(c.expected.label), `Case ${c.id} invalid expected.label`);
    if (c.expected.label === 'BLOCKED') {
      assert.ok(typeof c.expected.code === 'string', `Case ${c.id} BLOCKED must have expected.code`);
    }
  }
});

test('C2 cases cover all required categories: 1, 2, 4, 6, 8, 12', () => {
  const cases = generateC2Cases();
  const byCat = {};
  for (const c of cases) {
    byCat[c.category] = (byCat[c.category] || 0) + 1;
  }

  assert.ok((byCat[1] || 0) >= 20, `Category 1 must have >= 20 cases, got ${byCat[1] || 0}`);
  assert.ok((byCat[2] || 0) >= 20, `Category 2 must have >= 20 cases, got ${byCat[2] || 0}`);
  assert.ok((byCat[4] || 0) >= 20, `Category 4 must have >= 20 cases, got ${byCat[4] || 0}`);
  assert.ok((byCat[6] || 0) >= 20, `Category 6 must have >= 20 cases, got ${byCat[6] || 0}`);
  assert.ok((byCat[8] || 0) >= 20, `Category 8 must have >= 20 cases, got ${byCat[8] || 0}`);
  assert.ok((byCat[12] || 0) >= 20, `Category 12 must have >= 20 cases, got ${byCat[12] || 0}`);
});

test('C2 cases execute offline without unhandled exceptions or crashes', async () => {
  const cases = generateC2Cases();
  for (const c of cases) {
    const actual = await executeLayerCExtra(c);
    assert.ok(actual, `Execution returned null for ${c.id}`);
    assert.ok(actual.label, `Execution returned no label for ${c.id}`);
    assert.ok(['BLOCKED', 'INERT', 'OUT_OF_SCOPE', 'BREACH'].includes(actual.label));
  }
});

test('C2 cases execute through runCatalog with verdicts properly calculated', async () => {
  const cases = generateC2Cases();
  const { summary, cases: evaluated } = await runCatalog(cases, {
    executors: { C: executeLayerCExtra },
    writeOut: false,
  });

  assert.equal(summary.total, cases.length);
  assert.equal(summary.verdicts.BREACH, 0, 'No BREACH should occur in client parser unit tests');
  assert.ok(summary.verdicts.PASS > 0, 'Must have passing cases');
  // Check that summary reflects verdicts truthfully
  assert.equal(summary.verdicts.PASS + summary.verdicts.FAIL, cases.length);
});

