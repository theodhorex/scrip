// Schema definition and validation for Amanat Attack Catalog
// Conforms to .agy/BRIEF_BACKEND.md and web/docs/RENCANA_ATTACK_2500.md

export const VALID_CATEGORIES = Object.freeze([1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12]);
export const VALID_LAYERS = Object.freeze(['A', 'B', 'C', 'D', 'E']);
export const EXPECTED_LABELS = Object.freeze(['BLOCKED', 'INERT', 'OUT_OF_SCOPE']);
export const ACTUAL_LABELS = Object.freeze(['BLOCKED', 'INERT', 'OUT_OF_SCOPE', 'BREACH']);
export const VERDICTS = Object.freeze(['PASS', 'FAIL', 'BREACH', 'SKIPPED']);

/**
 * Validates a single attack case object.
 * Throws TypeError or RangeError if invalid.
 *
 * @param {object} c
 * @returns {object} The validated case
 */
export function validateCase(c) {
  if (c === null || typeof c !== 'object' || Array.isArray(c)) {
    throw new TypeError('Case must be a non-null object');
  }

  // ID validation
  if (typeof c.id !== 'string' || c.id.trim().length === 0) {
    throw new TypeError('Case id must be a non-empty string');
  }

  // Category validation (1..12)
  if (!Number.isInteger(c.category) || !VALID_CATEGORIES.includes(c.category)) {
    throw new RangeError(`Case ${c.id}: category must be an integer from 1 to 12, got ${c.category}`);
  }

  // Layer validation ('A'..'E')
  if (typeof c.layer !== 'string' || !VALID_LAYERS.includes(c.layer)) {
    throw new RangeError(`Case ${c.id}: layer must be one of [${VALID_LAYERS.join(', ')}], got ${c.layer}`);
  }

  // Title validation
  if (typeof c.title !== 'string' || c.title.trim().length === 0) {
    throw new TypeError(`Case ${c.id}: title must be a non-empty string`);
  }

  // Params validation
  if (c.params === undefined || c.params === null || typeof c.params !== 'object') {
    throw new TypeError(`Case ${c.id}: params must be an object`);
  }

  // Expected validation (MANDATORY before execution)
  if (c.expected === undefined || c.expected === null || typeof c.expected !== 'object' || Array.isArray(c.expected)) {
    throw new TypeError(`Case ${c.id}: expected is required and must be an object`);
  }
  if (!EXPECTED_LABELS.includes(c.expected.label)) {
    throw new RangeError(
      `Case ${c.id}: expected.label must be one of [${EXPECTED_LABELS.join(', ')}], got ${c.expected.label}`
    );
  }
  if (c.expected.code !== undefined && c.expected.code !== null && typeof c.expected.code !== 'string') {
    throw new TypeError(`Case ${c.id}: expected.code must be a string if provided`);
  }

  // Actual validation (optional before execution, must conform if present)
  if (c.actual !== undefined && c.actual !== null) {
    if (typeof c.actual !== 'object' || Array.isArray(c.actual)) {
      throw new TypeError(`Case ${c.id}: actual must be an object if present`);
    }
    if (!ACTUAL_LABELS.includes(c.actual.label)) {
      throw new RangeError(
        `Case ${c.id}: actual.label must be one of [${ACTUAL_LABELS.join(', ')}], got ${c.actual.label}`
      );
    }
    if (c.actual.code !== undefined && c.actual.code !== null && typeof c.actual.code !== 'string') {
      throw new TypeError(`Case ${c.id}: actual.code must be a string if provided`);
    }
    if (c.actual.note !== undefined && c.actual.note !== null && typeof c.actual.note !== 'string') {
      throw new TypeError(`Case ${c.id}: actual.note must be a string if provided`);
    }
    if (c.actual.txHash !== undefined && c.actual.txHash !== null && typeof c.actual.txHash !== 'string') {
      throw new TypeError(`Case ${c.id}: actual.txHash must be a string if provided`);
    }
  }

  // Verdict validation (optional before execution)
  if (c.verdict !== undefined && c.verdict !== null) {
    if (!VERDICTS.includes(c.verdict)) {
      throw new RangeError(
        `Case ${c.id}: verdict must be one of [${VERDICTS.join(', ')}], got ${c.verdict}`
      );
    }
  }

  return c;
}

/**
 * Validates a list of attack cases and asserts unique IDs.
 *
 * @param {Array<object>} cases
 * @returns {Array<object>} The validated cases
 */
export function validateCases(cases) {
  if (!Array.isArray(cases)) {
    throw new TypeError('cases must be an array');
  }

  const seenIds = new Set();
  for (const c of cases) {
    validateCase(c);
    if (seenIds.has(c.id)) {
      throw new Error(`Duplicate case id: ${c.id}`);
    }
    seenIds.add(c.id);
  }

  return cases;
}

/**
 * Summarizes a list of attack cases.
 * Returns counts per category, per layer, per label, verdicts, and list of breaches.
 *
 * @param {Array<object>} cases
 * @returns {object} Summary object
 */
export function summarize(cases) {
  if (!Array.isArray(cases)) {
    throw new TypeError('cases must be an array');
  }

  // Initialize per-category counts
  const byCategory = {};
  for (const cat of VALID_CATEGORIES) {
    byCategory[cat] = { total: 0, PASS: 0, FAIL: 0, BREACH: 0, SKIPPED: 0, PENDING: 0 };
  }

  // Initialize per-layer counts
  const byLayer = {};
  for (const layer of VALID_LAYERS) {
    byLayer[layer] = { total: 0, PASS: 0, FAIL: 0, BREACH: 0, SKIPPED: 0, PENDING: 0 };
  }

  // Initialize per-label counts
  const byLabel = {
    BLOCKED: 0,
    INERT: 0,
    OUT_OF_SCOPE: 0,
    BREACH: 0,
  };

  const verdicts = {
    total: cases.length,
    PASS: 0,
    FAIL: 0,
    BREACH: 0,
    SKIPPED: 0,
    PENDING: 0,
  };

  const breaches = [];

  for (const c of cases) {
    const cat = c.category;
    const layer = c.layer;
    const verdict = c.verdict || 'PENDING';

    if (byCategory[cat]) {
      byCategory[cat].total += 1;
      if (byCategory[cat][verdict] !== undefined) {
        byCategory[cat][verdict] += 1;
      }
    }

    if (byLayer[layer]) {
      byLayer[layer].total += 1;
      if (byLayer[layer][verdict] !== undefined) {
        byLayer[layer][verdict] += 1;
      }
    }

    if (verdicts[verdict] !== undefined) {
      verdicts[verdict] += 1;
    }

    // Label counts: use actual if present, otherwise expected
    const effectiveLabel = c.actual?.label || c.expected?.label;
    if (effectiveLabel && byLabel[effectiveLabel] !== undefined) {
      byLabel[effectiveLabel] += 1;
    }

    // Breach collection: any case with verdict BREACH or actual.label BREACH
    if (c.verdict === 'BREACH' || c.actual?.label === 'BREACH') {
      breaches.push(c);
    }
  }

  return {
    total: cases.length,
    verdicts,
    byCategory,
    byLayer,
    byLabel,
    breaches,
  };
}
