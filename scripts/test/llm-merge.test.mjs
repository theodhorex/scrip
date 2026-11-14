import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mergeChunks } from '../llm-merge.mjs';
import { PROMPT_KINDS, INVOICE_MODES } from '../llm-trials.mjs';

function chunk(model, seeds, runAt = '2026-11-14T00:00:00.000Z') {
  const trials = [];
  for (const prompt of PROMPT_KINDS) for (const invoiceMode of INVOICE_MODES) for (const seed of seeds) {
    trials.push({ model, prompt, promptKind: prompt, invoiceMode, seed, label: 'PAID_OK' });
  }
  return { metadata: { model, runAt, seeds: seeds.length, totalTrials: trials.length }, trials };
}

test('mergeChunks joins seed chunks and recomputes totals', () => {
  const m = mergeChunks([chunk('x', [1, 2]), chunk('x', [3, 4], '2026-11-15T00:00:00.000Z')], ['run-a']);
  assert.equal(m.metadata.seeds, 4);
  assert.equal(m.metadata.totalTrials, 24);
  assert.deepEqual(m.metadata.seedList, [1, 2, 3, 4]);
  assert.equal(m.metadata.runAt, '2026-11-15T00:00:00.000Z');
  assert.equal(m.summary.totals.total, 24);
  assert.equal(m.summary.totals.PAID_OK, 24);
});

test('mergeChunks rejects duplicates, mixed models and uneven chunks', () => {
  assert.throws(() => mergeChunks([chunk('x', [1]), chunk('x', [1])]), /duplicate/);
  assert.throws(() => mergeChunks([chunk('x', [1]), chunk('y', [2])]), /mixed models/);
  const bad = chunk('x', [1, 2]); bad.trials.pop();
  assert.throws(() => mergeChunks([bad]), /cover the same seeds/);
  assert.throws(() => mergeChunks([]), /no chunks/);
});
