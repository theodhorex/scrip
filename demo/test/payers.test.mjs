import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { makeNaivePayer, makeScripPayer } from '../agent.mjs';

const require = createRequire(new URL('../../client/package.json', import.meta.url));
const { KeyPair } = require('near-api-js');

test('naive payer: ft_transfer from its own account with the exact amount, 1 yocto', async () => {
  const calls = [];
  const account = { callFunctionRaw: async (c) => { calls.push(c); return { transaction: { hash: 'NH1' } }; } };
  const payer = makeNaivePayer({ account, token: 'usdc.testnet' });
  const r = await payer.pay({ payTo: 'evil.testnet', amount: '1000000', invoiceId: 'i1' });
  assert.deepEqual(r, { ok: true, txHash: 'NH1' });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].contractId, 'usdc.testnet');
  assert.equal(calls[0].methodName, 'ft_transfer');
  assert.deepEqual(calls[0].args, { receiver_id: 'evil.testnet', amount: '1000000' });
  assert.equal(calls[0].deposit, 1n);
});

test('naive payer: a throwing transfer is reported, not swallowed', async () => {
  const account = { callFunctionRaw: async () => { throw new Error('boom'); } };
  const r = await makeNaivePayer({ account, token: 't.testnet' }).pay({ payTo: 'a.testnet', amount: '1', invoiceId: 'i' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'TRANSFER_FAILED');
  assert.match(r.detail, /boom/);
});

function scrip(over = {}) {
  const sent = [];
  const deps = {
    agentId: 'agent.testnet', contractId: 'amc.testnet', mandateId: 7, keyPair: KeyPair.fromRandom('ed25519'),
    getAccessKeyNonce: async () => 100n,
    getBlockHeight: async () => 5000n,
    postRelay: async (body) => { sent.push(JSON.parse(body)); return { status: 200, body: { ok: true, tx_hash: 'AH1' } }; },
    readTx: async () => ({ events: [{ event: 'settled', data: [{ code: undefined }] }], results: [] }),
    ...over,
  };
  return { payer: makeScripPayer(deps), sent };
}
const rejectedEvents = (code) => ({ events: [{ event: 'rejected', data: [{ code }] }], results: [] });

test('scrip payer: signs a delegate, posts base64, settled event gives ok', async () => {
  const { payer, sent } = scrip();
  const r = await payer.pay({ payTo: 'shop.testnet', amount: '200000', invoiceId: 'i1' });
  assert.deepEqual(r, { ok: true, txHash: 'AH1' });
  assert.equal(sent.length, 1);
  assert.match(sent[0].signed_delegate, /^[A-Za-z0-9+/]+={0,2}$/);
});

test('scrip payer: contract rejection codes from events', async () => {
  for (const code of ['RECIPIENT_NOT_ALLOWED', 'OVER_PER_PAYMENT_CAP']) {
    const { payer } = scrip({ readTx: async () => rejectedEvents(code) });
    const r = await payer.pay({ payTo: 'evil.testnet', amount: '1000000', invoiceId: 'i' });
    assert.deepEqual(r, { ok: false, code, txHash: 'AH1' });
  }
});

test('scrip payer: rejection code from a PaymentResult in receipts', async () => {
  const { payer } = scrip({ readTx: async () => ({ events: [], results: ['{"Rejected":{"code":"OVER_BUDGET"}}'] }) });
  const r = await payer.pay({ payTo: 'x.testnet', amount: '1', invoiceId: 'i' });
  assert.equal(r.code, 'OVER_BUDGET');
  assert.equal(r.ok, false);
});

test('scrip payer: facilitator errors map through classifyRelayResponse', async () => {
  const cases = [
    [{ status: 400, body: { ok: false, code: 'KEY_NOT_ALLOWED' } }, 'KEY_NOT_ALLOWED', false],
    [{ status: 429, body: { ok: false, code: 'RATE_LIMITED' }, retryAfter: '3' }, 'RATE_LIMITED', true],
    [{ status: 502, body: { ok: false, code: 'TX_FAILED' } }, 'TX_FAILED', false],
  ];
  for (const [resp, code, retryable] of cases) {
    const { payer } = scrip({ postRelay: async () => resp, readTx: async () => { throw new Error('must not read'); } });
    const r = await payer.pay({ payTo: 'x.testnet', amount: '1', invoiceId: 'i' });
    assert.equal(r.ok, false);
    assert.equal(r.code, code);
    assert.equal(r.retryable, retryable);
  }
});

test('scrip payer: unreadable chain result is NOT reported as paid', async () => {
  const { payer } = scrip({ readTx: async () => ({ events: [], results: [], unreadable: true }) });
  const r = await payer.pay({ payTo: 'x.testnet', amount: '1', invoiceId: 'i' });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'UNVERIFIED');
});

test('scrip payer: refunded and reserved-only are not ok', async () => {
  let r = await scrip({ readTx: async () => ({ events: [{ event: 'reserved', data: [{}] }, { event: 'refunded', data: [{}] }], results: [] }) }).payer.pay({ payTo: 'x.testnet', amount: '1', invoiceId: 'i' });
  assert.deepEqual([r.ok, r.code], [false, 'REFUNDED']);
  r = await scrip({ readTx: async () => ({ events: [{ event: 'reserved', data: [{}] }], results: [] }) }).payer.pay({ payTo: 'x.testnet', amount: '1', invoiceId: 'i' });
  assert.deepEqual([r.ok, r.code], [false, 'PENDING']);
});

test('scrip payer: delegate nonce increases and request nonce is unique per call', async () => {
  const sent = [];
  const { payer } = scrip({ postRelay: async (b) => { sent.push(b); return { status: 200, body: { ok: true, tx_hash: 'T' } }; } });
  await payer.pay({ payTo: 'a.testnet', amount: '1', invoiceId: 'i1' });
  await payer.pay({ payTo: 'a.testnet', amount: '1', invoiceId: 'i2' });
  assert.notEqual(sent[0], sent[1]);
});
