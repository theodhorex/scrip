import { test } from 'node:test';
import assert from 'node:assert/strict';
import { validateCases } from '../schema.mjs';
import { runCatalog } from '../runner.mjs';
import { getSampleCases, executeLayerC, defaultExecutors } from '../cases/index.mjs';
import { stopFacilitatorServer } from '../layers/facilitator.mjs';

test('getSampleCases returns valid attack cases across layers B and C', async (t) => {
  const cases = getSampleCases();
  assert.equal(cases.length, 702);

  // Validate through schema
  validateCases(cases);

  const cat1 = cases.filter((c) => c.category === 1);
  const cat2 = cases.filter((c) => c.category === 2);
  const cat4 = cases.filter((c) => c.category === 4);
  const cat5 = cases.filter((c) => c.category === 5);
  const cat6 = cases.filter((c) => c.category === 6);
  const cat7 = cases.filter((c) => c.category === 7);
  const cat8 = cases.filter((c) => c.category === 8);
  const cat9 = cases.filter((c) => c.category === 9);
  const cat12 = cases.filter((c) => c.category === 12);

  // Layer C categories
  assert.equal(cat1.length, 36);
  assert.equal(cat2.length, 36);
  assert.equal(cat4.length, 68);
  assert.equal(cat6.length, 77);
  assert.equal(cat8.filter((c) => c.layer === 'C').length, 74);
  assert.equal(cat12.filter((c) => c.layer === 'C').length, 26);

  // Layer B categories
  assert.equal(cat5.length, 111);
  assert.equal(cat7.length, 71);
  assert.equal(cat8.filter((c) => c.layer === 'B').length, 60);
  assert.equal(cat9.length, 98);
  assert.equal(cat12.filter((c) => c.layer === 'B').length, 45);

  const layerC = cases.filter((c) => c.layer === 'C');
  const layerB = cases.filter((c) => c.layer === 'B');
  assert.equal(layerC.length, 317);
  assert.equal(layerB.length, 385);

  for (const c of cases) {
    assert.ok(c.expected);
    assert.ok(['BLOCKED', 'INERT', 'OUT_OF_SCOPE'].includes(c.expected.label));
  }
});

test('layer C executor blocks invalid recipient addresses (Category 1)', async () => {
  const cases = getSampleCases().filter((c) => c.category === 1 && c.layer === 'C');
  assert.equal(cases.length, 36);

  const invalidRecipientCases = cases.filter((c) => c.expected.code === 'RangeError');
  assert.equal(invalidRecipientCases.length, 28);
  for (const c of invalidRecipientCases) {
    const actual = await executeLayerC(c);
    assert.equal(actual.label, 'BLOCKED');
    assert.equal(actual.code, 'RangeError');
  }
});

test('executing sample cases accurately reflects Layer C results and exposes discrepancies', async () => {
  const cases = getSampleCases().filter((c) => c.layer === 'C');
  const res = await runCatalog(cases, {
    executors: defaultExecutors,
    writeOut: false,
  });

  assert.equal(res.cases.length, 317);
  assert.equal(res.summary.breaches.length, 0);
  assert.equal(res.summary.verdicts.FAIL, 0);
  assert.equal(res.summary.verdicts.PASS, 317);

  const failed = res.cases.filter((c) => c.verdict === 'FAIL');
  assert.equal(failed.length, 0);
});

test('executing sample cases accurately reflects Layer B results (Facilitator HTTP)', async () => {
  const cases = getSampleCases().filter((c) => c.layer === 'B');
  try {
    const res = await runCatalog(cases, {
      executors: defaultExecutors,
      writeOut: false,
    });

    assert.equal(res.cases.length, 385);
    assert.equal(res.summary.breaches.length, 0);
    assert.equal(res.summary.verdicts.FAIL, 0);
    assert.equal(res.summary.verdicts.PASS, 385);
  } finally {
    await stopFacilitatorServer();
  }
});
