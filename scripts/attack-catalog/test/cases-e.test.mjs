// Unit tests for Layer E (Testnet) Attack Cases
// Verifies:
// 1. Unique IDs across all Layer E cases
// 2. expected is always present with valid label & code
// 3. Amanat cases count >= 500
// 4. Comparison naive cases count == 20 (marked comparison: true)
// 5. All cases pass validateCase schema
// 6. All cases can execute in --dry mode without throwing (offline, mock engine)

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCase, validateCases } from '../schema.mjs';
import { createTestnetSession, executeLayerE } from '../layers/testnet.mjs';
import {
  getLayerECases,
  getLayerEComparisonCases,
  generatePaymentBudgetCases,
  generateApprovalLifecycleCases,
  generateAccessIdentityCases,
  generateDelegateGasCases,
  generateTokenRecipientCases,
  generateComparisonCases,
} from '../cases/layer_e/index.mjs';

test('Layer E case generators are defined and exported', () => {
  assert.equal(typeof generatePaymentBudgetCases, 'function');
  assert.equal(typeof generateApprovalLifecycleCases, 'function');
  assert.equal(typeof generateAccessIdentityCases, 'function');
  assert.equal(typeof generateDelegateGasCases, 'function');
  assert.equal(typeof generateTokenRecipientCases, 'function');
  assert.equal(typeof generateComparisonCases, 'function');
  assert.equal(typeof getLayerECases, 'function');
  assert.equal(typeof getLayerEComparisonCases, 'function');
});

test('Layer E Amanat cases meet count >= 500 and schema validation', () => {
  const cases = getLayerECases();
  assert.ok(cases.length >= 500, `Expected at least 500 Amanat cases, got ${cases.length}`);

  // Validate all through schema
  validateCases(cases);

  // Assert expected fields on every case
  for (const c of cases) {
    assert.equal(c.layer, 'E');
    assert.ok(typeof c.id === 'string' && c.id.startsWith('KAT-E-'));
    assert.ok(c.expected !== undefined && c.expected !== null);
    assert.ok(['BLOCKED', 'INERT', 'OUT_OF_SCOPE'].includes(c.expected.label));
    if (c.expected.label === 'BLOCKED') {
      assert.ok(typeof c.expected.code === 'string', `Case ${c.id} missing expected.code`);
    }
  }
});

test('Layer E category distribution covers required categories', () => {
  const cases = getLayerECases();
  const byCategory = {};
  for (const c of cases) {
    byCategory[c.category] = (byCategory[c.category] || 0) + 1;
  }

  // Categories 1, 2, 3, 4, 5, 6, 7, 10, 11
  assert.ok((byCategory[2] || 0) + (byCategory[3] || 0) >= 140, 'Cat 2+3 should be ~150');
  assert.ok((byCategory[4] || 0) + (byCategory[10] || 0) >= 110, 'Cat 4+10 should be ~120');
  assert.ok((byCategory[5] || 0) >= 90, 'Cat 5 should be ~100');
  assert.ok((byCategory[6] || 0) + (byCategory[7] || 0) >= 70, 'Cat 6+7 should be ~80');
  assert.ok((byCategory[1] || 0) + (byCategory[11] || 0) >= 50, 'Cat 1+11 should be ~60');
});

test('Layer E comparison cases: exactly 20 cases for naive baseline', () => {
  const compCases = getLayerEComparisonCases();
  assert.equal(compCases.length, 20);

  for (const c of compCases) {
    assert.equal(c.comparison, true);
    assert.equal(c.layer, 'E');
    assert.ok(c.id.startsWith('KAT-E-COMP-'));
    validateCase(c);
  }
});

test('Layer E cases execute under --dry mode without throwing', async () => {
  const session = await createTestnetSession({
    dry: true,
    mandatesCount: 2,
  });

  try {
    const cases = getLayerECases();
    // Execute all cases through dry executor: must complete without unhandled exceptions
    for (let i = 0; i < cases.length; i++) {
      const c = cases[i];
      const actual = await executeLayerE(c, session);
      assert.ok(actual, `Execution returned null for ${c.id}`);
      assert.ok(actual.label, `Execution returned no label for ${c.id}`);
      assert.ok(actual.txHash, `Dry execution must provide simulated txHash for ${c.id}`);
    }
  } finally {
    await session.closeSession();
  }
});
