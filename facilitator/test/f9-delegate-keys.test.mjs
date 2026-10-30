// F9b: Delegate and Key Verification Tests (~30 cases total).
// Covers:
// 1. Access key permissions: full-access, wrong method, wrong receiver, unregistered key, zero allowance.
// 2. Signature bit flipping property test: 64 evenly sampled bit positions across signature + payload (100% rejected).
// 3. Delegate validations: duplicates, wrong accounts, expired block, stale nonces, u64 max and overflow.
import test from 'node:test';
import assert from 'node:assert/strict';
import { actions, KeyPair } from 'near-api-js';
import { loadPolicy } from '../src/policy.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';
import { makeRelayer, createSerialQueue } from '../src/relay.mjs';
import { createKeyVerifier } from '../src/keycheck.mjs';
import { validateSignedDelegate } from '../src/validate.mjs';
import { basePolicy, makeSigned, fakeProvider, goodPermission, AGENT, CONTRACT } from './helpers.mjs';

class AccessKeyDoesNotExistError extends Error {}
class AccountDoesNotExistError extends Error {}

function setupRelayer({
  permission = goodPermission(),
  onKey,
  height = 1000,
  keyNonce = 0n,
  capacity = 10,
  balance = BigInt(10e24),
} = {}) {
  const calls = { submit: 0, viewAccessKey: 0 };
  let t = 1000;
  const policy = loadPolicy(basePolicy);
  const provider = fakeProvider({
    height,
    permission,
    onKey: async (args) => {
      calls.viewAccessKey++;
      if (onKey) return onKey(args);
      return { nonce: keyNonce, permission };
    },
  });

  const relayerAccount = {
    accountId: 'relayer.testnet',
    relayMetaTransaction: async () => {
      calls.submit++;
      return { transaction: { hash: 'TX_HASH_OK' }, receipts_outcome: [] };
    },
  };

  const limiter = createRateLimiter({ capacity, refillPerSecond: 1, now: () => t });
  const globalLimiter = createRateLimiter({ capacity: 100, refillPerSecond: 1, now: () => t });
  const keyVerifier = createKeyVerifier({ provider, policy, now: () => t });

  const relayer = makeRelayer({
    provider,
    relayerAccount,
    policy,
    limiter,
    globalLimiter,
    keyVerifier,
    relayerBalance: async () => balance,
    now: () => t,
    queue: createSerialQueue(),
  });

  return { relayer, calls, policy, limiter, keyVerifier, setTime: (v) => { t = v; } };
}

test('F9b Step 1: Kunci - Verifikasi tipe dan permission access key', async (t) => {
  await t.test('1.1 FullAccess key is rejected with KEY_NOT_ALLOWED and no submit', async () => {
    const { relayer, calls } = setupRelayer({ permission: 'FullAccess' });
    const { b64 } = await makeSigned();
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'KEY_NOT_ALLOWED');
    assert.equal(calls.submit, 0, 'Must never broadcast for FullAccess key');
  });

  await t.test('1.2 FunctionCall key with other method is rejected with KEY_NOT_ALLOWED', async () => {
    const { relayer, calls } = setupRelayer({
      permission: goodPermission({ method_names: ['some_other_method'] }),
    });
    const { b64 } = await makeSigned();
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'KEY_NOT_ALLOWED');
    assert.equal(calls.submit, 0);
  });

  await t.test('1.3 FunctionCall key with mixed methods including unallowed is rejected', async () => {
    const { relayer, calls } = setupRelayer({
      permission: goodPermission({ method_names: ['request_payment', 'drain_mandate'] }),
    });
    const { b64 } = await makeSigned();
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'KEY_NOT_ALLOWED');
    assert.equal(calls.submit, 0);
  });

  await t.test('1.4 FunctionCall key with empty method_names array is rejected', async () => {
    const { relayer, calls } = setupRelayer({
      permission: goodPermission({ method_names: [] }),
    });
    const { b64 } = await makeSigned();
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'KEY_NOT_ALLOWED');
    assert.equal(calls.submit, 0);
  });

  await t.test('1.5 FunctionCall key with other receiver is rejected with KEY_NOT_ALLOWED', async () => {
    const { relayer, calls } = setupRelayer({
      permission: goodPermission({ receiver_id: 'other-contract.testnet' }),
    });
    const { b64 } = await makeSigned();
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'KEY_NOT_ALLOWED');
    assert.equal(calls.submit, 0);
  });

  await t.test('1.6 Key not registered to sender (AccessKeyDoesNotExistError) is rejected', async () => {
    const { relayer, calls } = setupRelayer({
      onKey: () => { throw new AccessKeyDoesNotExistError('key not found'); },
    });
    const { b64 } = await makeSigned();
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'KEY_NOT_ALLOWED');
    assert.equal(calls.submit, 0);
  });

  await t.test('1.7 Sender account does not exist (AccountDoesNotExistError) is rejected', async () => {
    const { relayer, calls } = setupRelayer({
      onKey: () => { throw new AccountDoesNotExistError('account not found'); },
    });
    const { b64 } = await makeSigned();
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'KEY_NOT_ALLOWED');
    assert.equal(calls.submit, 0);
  });

  await t.test('1.8 FunctionCall key with zero allowance is rejected with KEY_NOT_ALLOWED', async () => {
    const { relayer, calls } = setupRelayer({
      permission: goodPermission({ allowance: '0' }),
    });
    const { b64 } = await makeSigned();
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'KEY_NOT_ALLOWED');
    assert.equal(calls.submit, 0);
  });
});

test('F9b Step 2: Tanda tangan - Sampel 64 posisi bit flip (property-based testing)', async (t) => {
  const policy = loadPolicy(basePolicy);
  const { b64 } = await makeSigned();
  const rawBytes = Buffer.from(b64, 'base64');
  const totalBits = rawBytes.length * 8;
  const sigStart = rawBytes.length - 64;

  await t.test('2.1 32 bit flips strictly in signature region -> all rejected with BAD_SIGNATURE', async () => {
    let badSigCount = 0;
    const totalSigBits = 64 * 8;
    for (let i = 0; i < 32; i++) {
      const bitOffset = Math.floor(i * (totalSigBits / 32));
      const bitPos = (sigStart * 8) + bitOffset;
      const corrupted = Buffer.from(rawBytes);
      corrupted[Math.floor(bitPos / 8)] ^= (1 << (bitPos % 8));
      const res = validateSignedDelegate(corrupted.toString('base64'), policy);
      assert.equal(res.ok, false);
      assert.equal(res.code, 'BAD_SIGNATURE', `Bit flip at signature position ${bitPos} must yield BAD_SIGNATURE`);
      badSigCount++;
    }
    assert.equal(badSigCount, 32);
  });

  await t.test('2.2 32 bit flips strictly in payload/DelegateAction region -> all rejected fail-closed (0 accepted)', async () => {
    let rejectedCount = 0;
    const totalPayloadBits = sigStart * 8;
    for (let i = 0; i < 32; i++) {
      const bitPos = Math.floor(i * (totalPayloadBits / 32));
      const corrupted = Buffer.from(rawBytes);
      corrupted[Math.floor(bitPos / 8)] ^= (1 << (bitPos % 8));
      const res = validateSignedDelegate(corrupted.toString('base64'), policy);
      assert.equal(res.ok, false, `Corrupted payload at bit ${bitPos} must NOT be accepted`);
      assert.ok(res.code, `Must return rejection code, got: ${JSON.stringify(res)}`);
      rejectedCount++;
    }
    assert.equal(rejectedCount, 32);
  });

  await t.test('2.3 64 evenly distributed bit flips across entire SignedDelegate buffer -> 100% rejected, 0 pass', async () => {
    const { relayer, calls } = setupRelayer();
    let rejectedCount = 0;
    const numSamples = 64;
    for (let i = 0; i < numSamples; i++) {
      const bitPos = Math.floor(i * (totalBits / numSamples));
      const corrupted = Buffer.from(rawBytes);
      corrupted[Math.floor(bitPos / 8)] ^= (1 << (bitPos % 8));
      const res = await relayer.relay(corrupted.toString('base64'));
      assert.equal(res.ok, false, `Relayer must reject bit-flipped delegate at bit ${bitPos}`);
      rejectedCount++;
    }
    assert.equal(rejectedCount, 64);
    assert.equal(calls.submit, 0, 'Relayer must make 0 submits across all 64 corrupted delegates');
  });

  await t.test('2.4 Signature from different key pair / mismatched signature -> BAD_SIGNATURE', async () => {
    const keyPair1 = KeyPair.fromRandom('ed25519');
    const keyPair2 = KeyPair.fromRandom('ed25519');
    const s1 = await makeSigned({ keyPair: keyPair1 });
    const s2 = await makeSigned({ keyPair: keyPair2 });
    const bytes1 = Buffer.from(s1.b64, 'base64');
    const bytes2 = Buffer.from(s2.b64, 'base64');
    // Transplant s2 signature onto s1 payload
    bytes2.copy(bytes1, bytes1.length - 64, bytes2.length - 64);
    const res = validateSignedDelegate(bytes1.toString('base64'), policy);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'BAD_SIGNATURE');
  });
});

test('F9b Step 3: Delegate - Validasi duplikasi, batas akun, expiry, dan batas nonce', async (t) => {
  await t.test('3.1 Dobel delegate persis (replay attack) ditolak DUPLICATE_DELEGATE (409)', async () => {
    const { relayer, calls } = setupRelayer();
    const { b64 } = await makeSigned({ nonce: 10n });
    const r1 = await relayer.relay(b64);
    assert.equal(r1.ok, true);
    assert.equal(calls.submit, 1);

    const r2 = await relayer.relay(b64);
    assert.equal(r2.ok, false);
    assert.equal(r2.code, 'DUPLICATE_DELEGATE');
    assert.equal(r2.txHash, 'TX_HASH_OK');
    assert.equal(calls.submit, 1, 'Duplicate delegate must never be submitted twice');
  });

  await t.test('3.2 Nonce delegate lama / sama dengan on-chain access key ditolak NONCE_TOO_LOW', async () => {
    const { relayer, calls } = setupRelayer({ keyNonce: 20n });
    // Nonce lower than keyNonce
    const rLower = await relayer.relay((await makeSigned({ nonce: 19n })).b64);
    assert.equal(rLower.ok, false);
    assert.equal(rLower.code, 'NONCE_TOO_LOW');

    // Nonce equal to keyNonce
    const rEqual = await relayer.relay((await makeSigned({ nonce: 20n })).b64);
    assert.equal(rEqual.ok, false);
    assert.equal(rEqual.code, 'NONCE_TOO_LOW');
    assert.equal(calls.submit, 0);

    // Nonce strictly above keyNonce passes
    const rAbove = await relayer.relay((await makeSigned({ nonce: 21n })).b64);
    assert.equal(rAbove.ok, true);
    assert.equal(calls.submit, 1);
  });

  await t.test('3.3 Delegate untuk akun pengirim asing (tidak ada di allowedAgents) ditolak AGENT_NOT_ALLOWED', async () => {
    const { relayer, calls } = setupRelayer();
    const { b64 } = await makeSigned({ senderId: 'foreign.testnet' });
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'AGENT_NOT_ALLOWED');
    assert.equal(calls.submit, 0);
  });

  await t.test('3.4 Delegate untuk akun pengirim non-testnet ditolak AGENT_NOT_ALLOWED', async () => {
    const { relayer, calls } = setupRelayer();
    const { b64 } = await makeSigned({ senderId: 'mainnet_account.near' });
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'AGENT_NOT_ALLOWED');
    assert.equal(calls.submit, 0);
  });

  await t.test('3.5 Delegate untuk kontrak penerima salah ditolak WRONG_RECEIVER', async () => {
    const { relayer, calls } = setupRelayer();
    const { b64 } = await makeSigned({ receiverId: 'other-app.testnet' });
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRONG_RECEIVER');
    assert.equal(calls.submit, 0);
  });

  await t.test('3.6 Blok kedaluwarsa di masa lalu / margin tipis ditolak EXPIRES_TOO_SOON', async () => {
    const { relayer, calls } = setupRelayer({ height: 1000 });
    // Margin is 5 in basePolicy. Current height = 1000.
    // maxBlockHeight = 1004 < 1000 + 5 -> EXPIRES_TOO_SOON
    const rSoon = await relayer.relay((await makeSigned({ maxBlockHeight: 1004n })).b64);
    assert.equal(rSoon.ok, false);
    assert.equal(rSoon.code, 'EXPIRES_TOO_SOON');

    // Past block height: 900
    const rPast = await relayer.relay((await makeSigned({ maxBlockHeight: 900n })).b64);
    assert.equal(rPast.ok, false);
    assert.equal(rPast.code, 'EXPIRES_TOO_SOON');
    assert.equal(calls.submit, 0);
  });

  await t.test('3.7 Blok kedaluwarsa melampaui jendela window ditolak EXPIRES_TOO_FAR', async () => {
    const { relayer, calls } = setupRelayer({ height: 1000 });
    // Window is 200. Current height = 1000.
    // maxBlockHeight = 1201 > 1000 + 200 -> EXPIRES_TOO_FAR
    const rFar = await relayer.relay((await makeSigned({ maxBlockHeight: 1201n })).b64);
    assert.equal(rFar.ok, false);
    assert.equal(rFar.code, 'EXPIRES_TOO_FAR');
    assert.equal(calls.submit, 0);
  });

  await t.test('3.8 Nonce 0 pada delegateAction ditolak NONCE_INVALID', async () => {
    const { relayer, calls } = setupRelayer();
    const { b64 } = await makeSigned({ nonce: 0n });
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NONCE_INVALID');
    assert.equal(calls.submit, 0);
  });

  await t.test('3.9 Nonce sangat besar u64::MAX (2^64 - 1) diterima jika di atas keyNonce', async () => {
    const { relayer, calls } = setupRelayer({ keyNonce: 1000n });
    const u64Max = (1n << 64n) - 1n; // 18446744073709551615n
    const { b64 } = await makeSigned({ nonce: u64Max });
    const res = await relayer.relay(b64);
    assert.equal(res.ok, true);
    assert.equal(calls.submit, 1);
  });

  await t.test('3.10 Nonce melebihi u64::MAX pada call args request_payment ditolak BAD_CALL_ARGS', async () => {
    const { relayer, calls } = setupRelayer();
    const overflowNonceStr = (1n << 64n).toString();
    const arg = Buffer.from(JSON.stringify({
      mandate_id: 1,
      recipient: 'bob.testnet',
      amount: '100',
      nonce: overflowNonceStr,
    }), 'utf8');
    const { b64 } = await makeSigned({
      actions: [actions.functionCall('request_payment', arg, 60_000_000_000_000n, 0n)],
    });
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'BAD_CALL_ARGS');
    assert.equal(calls.submit, 0);
  });

  await t.test('3.11 Nonce 2^64 pada delegateAction wrap-around modulo 2^64 jadi 0 -> NONCE_INVALID', async () => {
    const { relayer, calls } = setupRelayer();
    const exactly2To64 = 1n << 64n;
    const { b64 } = await makeSigned({ nonce: exactly2To64 });
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NONCE_INVALID');
    assert.equal(calls.submit, 0);
  });

  await t.test('3.12 Nonce negatif pada call args request_payment ditolak BAD_CALL_ARGS', async () => {
    const { relayer, calls } = setupRelayer();
    const arg = Buffer.from(JSON.stringify({
      mandate_id: 1,
      recipient: 'bob.testnet',
      amount: '100',
      nonce: -5,
    }), 'utf8');
    const { b64 } = await makeSigned({
      actions: [actions.functionCall('request_payment', arg, 60_000_000_000_000n, 0n)],
    });
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'BAD_CALL_ARGS');
    assert.equal(calls.submit, 0);
  });

  await t.test('3.13 Delegate dengan aksi bukan functionCall (Transfer) ditolak NOT_FUNCTION_CALL', async () => {
    const { relayer, calls } = setupRelayer();
    const { b64 } = await makeSigned({
      actions: [actions.transfer(100n)],
    });
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'NOT_FUNCTION_CALL');
    assert.equal(calls.submit, 0);
  });

  await t.test('3.14 Delegate dengan nol aksi ditolak WRONG_ACTION_COUNT', async () => {
    const { relayer, calls } = setupRelayer();
    const { b64 } = await makeSigned({
      actions: [],
    });
    const res = await relayer.relay(b64);
    assert.equal(res.ok, false);
    assert.equal(res.code, 'WRONG_ACTION_COUNT');
    assert.equal(calls.submit, 0);
  });
});

