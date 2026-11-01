import { test } from 'node:test';
import assert from 'node:assert/strict';
import { reduceEvents, checkBudget, InvariantError } from '../src/stats.mjs';

const e = (event, amount, extra = {}, id = 1) => ({
  standard: 'amanat', version: '1.0.0', event,
  data: [{ mandate_id: id, recipient: 'shop.testnet', amount: String(amount), ...extra }],
});

test('deposit and withdraw', () => {
  const s = reduceEvents([e('deposited', 1000), e('withdrawn', 300)]).get(1);
  assert.equal(s.deposited, 1000n);
  assert.equal(s.withdrawn, 300n);
  assert.equal(s.open, 0);
});

test('reserved -> settled', () => {
  const s = reduceEvents([e('reserved', 100), e('settled', 100)]).get(1);
  assert.equal(s.reserved, 0n);
  assert.equal(s.spent, 100n);
  assert.equal(s.open, 0);
});

test('reserved -> refunded', () => {
  const s = reduceEvents([e('reserved', 100), e('refunded', 100)]).get(1);
  assert.equal(s.reserved, 0n);
  assert.equal(s.spent, 0n);
  assert.equal(s.refunded, 100n);
  assert.equal(s.open, 0);
});

test('stale_resolved transferred=true behaves like settled', () => {
  const s = reduceEvents([e('reserved', 50), e('stale_resolved', 50, { transferred: true })]).get(1);
  assert.equal(s.spent, 50n);
  assert.equal(s.refunded, 0n);
  assert.equal(s.reserved, 0n);
  assert.equal(s.open, 0);
});

test('stale_resolved transferred=false behaves like refunded', () => {
  const s = reduceEvents([e('reserved', 50), e('stale_resolved', 50, { transferred: false })]).get(1);
  assert.equal(s.spent, 0n);
  assert.equal(s.refunded, 50n);
  assert.equal(s.reserved, 0n);
  assert.equal(s.open, 0);
});

test('rejected only counts by code', () => {
  const s = reduceEvents([
    e('rejected', 5, { code: 'OVER_BUDGET' }),
    e('rejected', 5, { code: 'OVER_BUDGET' }),
    e('rejected', 5, { code: 'EXPIRED' }),
  ]).get(1);
  assert.deepEqual(s.rejectedByCode, { OVER_BUDGET: 2, EXPIRED: 1 });
  assert.equal(s.reserved, 0n);
  assert.equal(s.open, 0);
});

test('mandates are tracked separately; other events are neutral', () => {
  const m = reduceEvents([e('reserved', 10, {}, 1), e('reserved', 20, {}, 2), e('revoked', 0, {}, 1)]);
  assert.equal(m.get(1).reserved, 10n);
  assert.equal(m.get(2).reserved, 20n);
});

test('settled without reserved throws InvariantError', () => {
  assert.throws(() => reduceEvents([e('settled', 1)]), InvariantError);
});

test('refunded without reserved throws InvariantError', () => {
  assert.throws(() => reduceEvents([e('refunded', 1)]), InvariantError);
});

test('stale_resolved without reserved throws InvariantError (both ways)', () => {
  assert.throws(() => reduceEvents([e('stale_resolved', 1, { transferred: true })]), InvariantError);
  assert.throws(() => reduceEvents([e('stale_resolved', 1, { transferred: false })]), InvariantError);
});

test('settling more than reserved throws', () => {
  assert.throws(() => reduceEvents([e('reserved', 10), e('settled', 11)]), InvariantError);
  assert.throws(() => reduceEvents([e('reserved', 10), e('refunded', 11)]), InvariantError);
});

test('withdrawn beyond deposited throws', () => {
  assert.throws(() => reduceEvents([e('deposited', 10), e('withdrawn', 11)]), InvariantError);
});

test('settling with no open request throws', () => {
  assert.throws(() => reduceEvents([e('reserved', 10), e('settled', 4), e('settled', 4), e('settled', 2)]), InvariantError);
});

test('20 interleaved reserved events and a budget check', () => {
  const evs = [];
  for (let i = 0; i < 20; i++) evs.push(e('reserved', 10 + i));
  // total reserved = 200 + 190 = 390
  for (let i = 0; i < 20; i += 2) evs.push(e('settled', 10 + i)); // 10,12,...,28 -> 190
  for (let i = 1; i < 20; i += 4) evs.push(e('refunded', 10 + i)); // 11,15,19,23,27 -> 95
  const s = reduceEvents(evs).get(1);
  assert.equal(s.spent, 190n);
  assert.equal(s.refunded, 95n);
  assert.equal(s.reserved, 390n - 190n - 95n);
  assert.equal(s.open, 20 - 10 - 5);
  assert.deepEqual(checkBudget(s, 390n), { ok: true, overBy: 0n });
  assert.deepEqual(checkBudget(s, 295n), { ok: true, overBy: 0n });
  assert.deepEqual(checkBudget(s, 290n), { ok: false, overBy: 5n });
});

test('checkBudget accepts a string budget', () => {
  const s = reduceEvents([e('reserved', 10)]).get(1);
  assert.deepEqual(checkBudget(s, '10'), { ok: true, overBy: 0n });
  assert.deepEqual(checkBudget(s, '9'), { ok: false, overBy: 1n });
});

test('input is not mutated and results are independent per call', () => {
  const evs = [e('reserved', 10)];
  const a = reduceEvents(evs);
  const b = reduceEvents(evs);
  assert.notEqual(a.get(1), b.get(1));
  assert.equal(b.get(1).reserved, 10n);
});
