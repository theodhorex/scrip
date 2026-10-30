import test from "node:test";
import assert from "node:assert/strict";
import { writeFileSync, unlinkSync, mkdirSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  loadAttackResults,
  loadAttackCatalog,
  parseAttackResults,
  parseAttackCatalog,
  formatUsdcUnits,
  buildCategoryMatrix,
  getOutOfScopeCases,
} from "../src/lib/attack-data.ts";

const tempDir = join(tmpdir(), "amanat-test-" + Date.now());
mkdirSync(tempDir, { recursive: true });

test("formatUsdcUnits formats raw 6-decimal units to clean display string", () => {
  assert.equal(formatUsdcUnits("1400000"), "1.40 USDC");
  assert.equal(formatUsdcUnits("1000000"), "1.00 USDC");
  assert.equal(formatUsdcUnits("400000"), "0.40 USDC");
  assert.equal(formatUsdcUnits("0"), "0.00 USDC");
});

test("loadAttackResults: berkas ada (real results/attack.json)", () => {
  const result = loadAttackResults();
  assert.ok(result !== null, "Expected loadAttackResults() to load real results/attack.json");
  assert.equal(result.network, "testnet");
  assert.equal(result.params.N, 30);
  assert.equal(result.params.budget, "1000000");

  assert.ok(result.naive !== null);
  assert.equal(result.naive.contract, "naive");
  assert.equal(result.naive.budget, "1000000");
  assert.equal(result.naive.merchantReceived, "1400000");
  assert.equal(result.naive.spent, "1400000");
  assert.equal(result.naive.exceededBudget, true);
  assert.equal(result.naive.overBudgetBy, "400000");
  assert.equal(result.naive.paymentsPaid, "14");

  assert.ok(result.amanat !== null);
  assert.equal(result.amanat.contract, "amanat");
  assert.equal(result.amanat.budget, "1000000");
  assert.equal(result.amanat.merchantReceived, "1000000");
  assert.equal(result.amanat.spent, "1000000");
  assert.equal(result.amanat.exceededBudget, false);
  assert.equal(result.amanat.overBudgetBy, "0");
  assert.equal(result.amanat.paymentsPaid, "10");
});

test("loadAttackResults: berkas hilang mengembalikan null tanpa melempar", () => {
  const nonExistentPath = join(tempDir, "does-not-exist.json");
  const result = loadAttackResults(nonExistentPath);
  assert.equal(result, null);
});

test("loadAttackResults: JSON rusak mengembalikan null tanpa melempar", () => {
  const brokenPath = join(tempDir, "broken.json");
  writeFileSync(brokenPath, "{ broken json content", "utf8");
  try {
    const result = loadAttackResults(brokenPath);
    assert.equal(result, null);
  } finally {
    unlinkSync(brokenPath);
  }
});

test("loadAttackResults: bidang kurang mengembalikan null tanpa melempar", () => {
  // Test via parseAttackResults
  assert.equal(parseAttackResults(null), null);
  assert.equal(parseAttackResults([]), null);
  assert.equal(parseAttackResults([{}]), null);
  assert.equal(
    parseAttackResults([
      {
        network: "testnet",
        // missing params, cases, etc.
      },
    ]),
    null,
  );
  assert.equal(
    parseAttackResults([
      {
        network: "testnet",
        params: { N: 30, amount: "100000", budget: "1000000" },
        cases: [
          { contract: "naive" }, // missing budget, merchantReceived, broadcast, etc.
        ],
      },
    ]),
    null,
  );

  // Also test with file path
  const partialPath = join(tempDir, "partial.json");
  writeFileSync(partialPath, JSON.stringify([{ network: "testnet" }]), "utf8");
  try {
    const result = loadAttackResults(partialPath);
    assert.equal(result, null);
  } finally {
    unlinkSync(partialPath);
  }
});

test("loadAttackCatalog: berkas ada mengembalikan tipe katalog terketik", () => {
  const validCatalog = {
    cases: [
      {
        category: "budget",
        layer: "contracts",
        expected: { label: "BLOCKED" },
        actual: { label: "BLOCKED" },
        verdict: "PASS",
      },
      {
        category: "threat_model",
        layer: "absurd",
        expected: { label: "OUT_OF_SCOPE" },
        actual: { label: "OUT_OF_SCOPE" },
        verdict: "PASS",
      },
    ],
    summary: {
      total: 2,
    },
  };

  const catalogPath = join(tempDir, "attack-catalog.json");
  writeFileSync(catalogPath, JSON.stringify(validCatalog), "utf8");
  try {
    const loaded = loadAttackCatalog(catalogPath);
    assert.ok(loaded !== null);
    assert.equal(loaded.cases.length, 2);
    assert.equal(loaded.cases[0].category, "budget");
    assert.equal(loaded.cases[0].expected.label, "BLOCKED");
    assert.equal(loaded.cases[1].actual.label, "OUT_OF_SCOPE");
  } finally {
    unlinkSync(catalogPath);
  }
});

test("loadAttackCatalog: berkas hilang mengembalikan null tanpa melempar", () => {
  const nonExistent = join(tempDir, "non-existent-catalog.json");
  const result = loadAttackCatalog(nonExistent);
  assert.equal(result, null);
});

test("loadAttackCatalog: JSON rusak mengembalikan null tanpa melempar", () => {
  const brokenPath = join(tempDir, "broken-catalog.json");
  writeFileSync(brokenPath, "{ invalid json @@", "utf8");
  try {
    const result = loadAttackCatalog(brokenPath);
    assert.equal(result, null);
  } finally {
    unlinkSync(brokenPath);
  }
});

test("loadAttackCatalog: bidang kurang mengembalikan null tanpa melempar", () => {
  // Missing cases array
  assert.equal(parseAttackCatalog({}), null);
  assert.equal(parseAttackCatalog({ cases: "not an array" }), null);
  // Case missing required fields
  assert.equal(
    parseAttackCatalog({
      cases: [
        {
          category: "budget",
          // missing layer, expected, actual, verdict
        },
      ],
    }),
    null,
  );
  assert.equal(
    parseAttackCatalog({
      cases: [
        {
          category: "budget",
          layer: "contracts",
          expected: {}, // missing label
          actual: { label: "BLOCKED" },
          verdict: "PASS",
        },
      ],
    }),
    null,
  );
});

test("loadAttackCatalog: mendukung kategori integer dan string", () => {
  const parsed = parseAttackCatalog({
    cases: [
      {
        id: "TC-01",
        category: 1,
        layer: "A",
        expected: { label: "BLOCKED" },
        actual: { label: "BLOCKED" },
        verdict: "PASS",
      },
    ],
  });
  assert.ok(parsed !== null);
  assert.equal(parsed.cases[0].category, 1);
});

test("buildCategoryMatrix dan getOutOfScopeCases menyusun matriks dan memfilter OUT_OF_SCOPE", () => {
  const cases = [
    {
      id: "C1",
      category: 1,
      layer: "A",
      expected: { label: "BLOCKED" },
      actual: { label: "BLOCKED" },
      verdict: "PASS",
    },
    {
      id: "C2",
      category: 1,
      layer: "B",
      expected: { label: "INERT" },
      actual: { label: "INERT" },
      verdict: "PASS",
    },
    {
      id: "C3",
      category: 12,
      layer: "absurd",
      expected: { label: "OUT_OF_SCOPE" },
      actual: { label: "OUT_OF_SCOPE" },
      verdict: "PASS",
    },
  ];

  const matrix = buildCategoryMatrix(cases);
  assert.equal(matrix.length, 2);
  assert.equal(matrix[0].category, "1");
  assert.equal(matrix[0].blocked, 1);
  assert.equal(matrix[0].inert, 1);
  assert.equal(matrix[0].total, 2);
  assert.equal(matrix[1].category, "12");
  assert.equal(matrix[1].outOfScope, 1);
  assert.equal(matrix[1].total, 1);

  const outOfScope = getOutOfScopeCases(cases);
  assert.equal(outOfScope.length, 1);
  assert.equal(outOfScope[0].id, "C3");
});
