import { test } from 'node:test';
import assert from 'node:assert/strict';
import { KeyPair } from 'near-api-js';
import { payGasless, HOSTED_RELAY_URL } from '../src/index.mjs';
import { validateSignedDelegate } from '../../facilitator/src/validate.mjs';

const CONTRACT = 'scrip.testnet';
const AGENT = 'agent1.testnet';
const provider = { viewAccessKey: async () => ({ nonce: 41n }), viewBlock: async () => ({ header: { height: 1000 } }) };
const reply = (status, body) => ({ status, json: async () => body, headers: { get: () => null } });

test('payGasless signs a delegate the facilitator accepts and reads the inner status', async () => {
  let seen;
  const fetch = async (url, init) => { seen = { url, init }; return reply(200, { ok: true, tx_hash: 'abc', inner_status: 'Rejected', inner_code: 'RECIPIENT_NOT_ALLOWED' }); };
  const r = await payGasless({ agentId: AGENT, keyPair: KeyPair.fromRandom('ed25519'), contractId: CONTRACT, mandateId: 3, recipient: 'shop.testnet', amount: '10', nonce: 5, provider, fetch });
  assert.deepEqual(r, { ok: true, txHash: 'abc', innerStatus: 'Rejected', innerCode: 'RECIPIENT_NOT_ALLOWED', code: null, retryable: false });
  assert.equal(seen.url, HOSTED_RELAY_URL);
  const b64 = JSON.parse(seen.init.body).signed_delegate;
  const policy = { contractId: CONTRACT, allowedMethods: ['request_payment'], allowedAgents: [AGENT], minGas: 60_000_000_000_000n, maxGas: 100_000_000_000_000n, maxBlockHeightWindow: 300, minBlockHeightMargin: 5 };
  const v = validateSignedDelegate(b64, policy, { currentBlockHeight: 1000 });
  assert.equal(v.ok, true, `${v.code}: ${v.detail}`);
  assert.equal(v.nonce, 42n);
  assert.equal(v.maxBlockHeight, 1100n);
  assert.equal(v.call.mandateId, 3n);
});

test('payGasless reports relayer refusals with their code', async () => {
  const fetch = async () => reply(400, { ok: false, code: 'AGENT_NOT_ALLOWED' });
  const r = await payGasless({ agentId: AGENT, keyPair: KeyPair.fromRandom('ed25519'), contractId: CONTRACT, mandateId: 3, recipient: 'shop.testnet', amount: '10', provider, fetch });
  assert.equal(r.ok, false);
  assert.equal(r.code, 'AGENT_NOT_ALLOWED');
  assert.equal(r.retryable, false);
});
