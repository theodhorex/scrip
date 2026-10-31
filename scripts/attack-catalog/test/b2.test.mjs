import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCases } from '../schema.mjs';
import { runCatalog } from '../runner.mjs';
import { getSampleCases } from '../cases/index.mjs';
import { executeLayerB, stopFacilitatorServer } from '../layers/facilitator.mjs';
import { generateB2Cases } from '../cases/b2_extra.mjs';

test('generateB2Cases returns >= 200 valid Layer B attack cases with unique IDs', () => {
  const cases = generateB2Cases();
  assert.ok(Array.isArray(cases), 'generateB2Cases must return an array');
  assert.ok(
    cases.length >= 200,
    `Expected >= 200 cases, got ${cases.length}`
  );

  // Schema validation
  validateCases(cases);

  // All cases must belong to layer B
  for (const c of cases) {
    assert.equal(c.layer, 'B', `Case ${c.id} must have layer 'B'`);
    assert.ok(c.expected, `Case ${c.id} must have expected`);
    assert.ok(['BLOCKED', 'INERT', 'OUT_OF_SCOPE'].includes(c.expected.label), `Case ${c.id} invalid expected.label`);
  }

  // Categories must include 5, 7, 8, 9, 12
  const categories = new Set(cases.map((c) => c.category));
  assert.ok(categories.has(5), 'Category 5 must be present');
  assert.ok(categories.has(7), 'Category 7 must be present');
  assert.ok(categories.has(8), 'Category 8 must be present');
  assert.ok(categories.has(9), 'Category 9 must be present');
  assert.ok(categories.has(12), 'Category 12 must be present');

  // Verify unique IDs within B2 cases
  const b2Ids = new Set(cases.map((c) => c.id));
  assert.equal(b2Ids.size, cases.length, 'All B2 case IDs must be strictly unique');

  // Verify no ID collision with existing catalog (excluding B2 cases themselves)
  const otherCases = getSampleCases().filter((c) => !b2Ids.has(c.id));
  const otherIds = new Set(otherCases.map((c) => c.id));
  for (const c of cases) {
    assert.ok(!otherIds.has(c.id), `ID collision detected with existing catalog: ${c.id}`);
  }
});

test('executing generated B2 cases with Layer B executor yields zero BREACH', async () => {
  const cases = generateB2Cases();
  try {
    const res = await runCatalog(cases, {
      executors: { B: executeLayerB },
      writeOut: false,
      timeoutMs: 3000,
    });

    assert.equal(res.summary.breaches.length, 0, 'Zero breaches expected across Layer B');
    assert.equal(res.cases.length, cases.length);
  } finally {
    await stopFacilitatorServer();
  }
});
