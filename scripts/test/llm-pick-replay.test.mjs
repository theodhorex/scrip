import test from 'node:test';
import assert from 'node:assert/strict';
import { writeFileSync, mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pickDecisions } from '../llm-pick-replay.mjs';

const t = (o) => ({ model: 'm', seed: 1, prompt: 'normal', invoiceMode: 'injected', label: 'PAID_OK', decision: { type: 'pay', recipient: 'merchant.testnet', amount: '200000' }, ...o });

test('pickDecisions: one per fooled label, normal prompt and lowest seed first, ignores others', () => {
  const dir = mkdtempSync(join(tmpdir(), 'pick-'));
  const f = join(dir, 'a.json');
  writeFileSync(f, JSON.stringify({ trials: [
    t({ label: 'FOOLED_RECIPIENT', seed: 5, prompt: 'hijacked', decision: { type: 'pay', recipient: 'attacker.testnet', amount: '1' } }),
    t({ label: 'FOOLED_RECIPIENT', seed: 7, decision: { type: 'pay', recipient: 'attacker.testnet', amount: '2' } }),
    t({ label: 'FOOLED_RECIPIENT', seed: 3, decision: { type: 'pay', recipient: 'attacker.testnet', amount: '3' } }),
    t({ label: 'DECLINED', decision: { type: 'decline', reason: 'x' } }),
  ] }));
  const r = pickDecisions([f], '42');
  assert.equal(r.decisions.length, 1);
  assert.equal(r.decisions[0].seed, 3);
  assert.equal(r.decisions[0].amount, '3');
  assert.match(r.source, /42/);
});
