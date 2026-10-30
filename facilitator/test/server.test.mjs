import test from 'node:test';
import assert from 'node:assert/strict';
import { createServer, MAX_BODY_BYTES } from '../src/server.mjs';

async function withServer(relay, fn, log, opts = {}) {
  const server = createServer({ relayer: { relay }, log, ...opts });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try { await fn(base); } finally { server.closeAllConnections(); await new Promise((r) => server.close(r)); }
}
const post = (base, body, headers = { 'content-type': 'application/json' }) => fetch(base + '/relay', { method: 'POST', headers, body });

test('GET /health', () => withServer(async () => {}, async (b) => {
  const r = await fetch(b + '/health');
  assert.equal(r.status, 200);
  assert.deepEqual(await r.json(), { ok: true });
}));

test('200 on success, 400 on validation code, 429 with Retry-After, 502 upstream', () => {
  const answers = [
    { ok: true, txHash: 'T1', outerSuccess: true, note: 'N' },
    { ok: false, code: 'BAD_SIGNATURE', detail: 'x' },
    { ok: false, code: 'RATE_LIMITED', retryAfterMs: 2500 },
    { ok: false, code: 'BUSY', retryAfterMs: 1000 },
    { ok: false, code: 'UPSTREAM_ERROR' },
    { ok: false, code: 'KEY_NOT_ALLOWED' },
    { ok: false, code: 'GAS_TOO_LOW' },
  ];
  return withServer(async () => answers.shift(), async (b) => {
    const body = JSON.stringify({ signed_delegate: 'AAAA' });
    let r = await post(b, body);
    assert.equal(r.status, 200);
    assert.deepEqual(await r.json(), { ok: true, tx_hash: 'T1', outer_tx_succeeded: true, note: 'N' });
    r = await post(b, body);
    assert.equal(r.status, 400);
    assert.deepEqual(await r.json(), { ok: false, code: 'BAD_SIGNATURE' });
    r = await post(b, body);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '3');
    r = await post(b, body);
    assert.equal(r.status, 429);
    assert.equal(r.headers.get('retry-after'), '1');
    assert.deepEqual(await r.json(), { ok: false, code: 'BUSY' });
    r = await post(b, body);
    assert.equal(r.status, 502);
    r = await post(b, body);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'KEY_NOT_ALLOWED');
    r = await post(b, body);
    assert.equal(r.status, 400);
    assert.equal((await r.json()).code, 'GAS_TOO_LOW');
  });
});

test('bad JSON, wrong shape, wrong content-type, wrong method, unknown path', () =>
  withServer(async () => assert.fail('must not be called'), async (b) => {
    assert.equal((await post(b, '{nope')).status, 400);
    assert.equal((await post(b, JSON.stringify({ signed_delegate: 5 }))).status, 400);
    assert.equal((await post(b, JSON.stringify([]))).status, 400);
    assert.equal((await post(b, '{}', { 'content-type': 'text/plain' })).status, 415);
    assert.equal((await fetch(b + '/relay')).status, 405);
    assert.equal((await fetch(b + '/nope')).status, 404);
  }));

test('body over 16 KB is rejected with 413 before relaying', () =>
  withServer(async () => assert.fail('must not be called'), async (b) => {
    const r = await post(b, JSON.stringify({ signed_delegate: 'A'.repeat(MAX_BODY_BYTES) }));
    assert.equal(r.status, 413);
  }));

test('relayer crash gives 500 without stack trace; logs never contain the body', async () => {
  const logs = [];
  await withServer(async () => { throw new Error('SECRET stack detail'); }, async (b) => {
    const r = await post(b, JSON.stringify({ signed_delegate: 'TOPSECRETBODY' }));
    const text = await r.text();
    assert.equal(r.status, 500);
    assert.ok(!text.includes('SECRET') && !text.includes('at '));
  }, (e) => logs.push(JSON.stringify(e)));
  assert.ok(!logs.join('').includes('TOPSECRETBODY'));
});

import { createRateLimiter } from '../src/ratelimit.mjs';
const body = JSON.stringify({ signed_delegate: 'AAAA' });

test('N-M1: per-IP bucket returns 429 IP_RATE_LIMITED before the relayer runs', async () => {
  let calls = 0;
  await withServer(async () => (calls++, { ok: false, code: 'BAD_ENCODING' }), async (b) => {
    assert.equal((await post(b, body)).status, 400);
    assert.equal((await post(b, body)).status, 400);
    const r = await post(b, body);
    assert.equal(r.status, 429);
    assert.equal((await r.json()).code, 'IP_RATE_LIMITED');
    assert.ok(Number(r.headers.get('retry-after')) >= 1);
    assert.equal(calls, 2);
  }, undefined, { ipLimiter: createRateLimiter({ capacity: 2, refillPerSecond: 0.001 }) });
});

test('N-M1: X-Forwarded-For ignored unless trustProxy', async () => {
  for (const trustProxy of [false, true]) {
    let n = 0;
    await withServer(async () => ({ ok: false, code: 'BAD_ENCODING' }), async (b) => {
      const codes = [];
      for (let i = 0; i < 3; i++) codes.push((await post(b, body, { 'content-type': 'application/json', 'x-forwarded-for': `9.9.9.${n++}` })).status);
      assert.deepEqual(codes, trustProxy ? [400, 400, 400] : [400, 429, 429]);
    }, undefined, { ipLimiter: createRateLimiter({ capacity: 1, refillPerSecond: 0.001 }), trustProxy });
  }
});

test('N-M1: concurrent in-flight relays are capped (503 SERVER_BUSY)', async () => {
  let release;
  const gate = new Promise((r) => (release = r));
  await withServer(async () => { await gate; return { ok: false, code: 'BAD_ENCODING' }; }, async (b) => {
    const a = [post(b, body), post(b, body)];
    await new Promise((r) => setTimeout(r, 50));
    const busy = await post(b, body);
    assert.equal(busy.status, 503);
    assert.equal((await busy.json()).code, 'SERVER_BUSY');
    release();
    assert.deepEqual((await Promise.all(a)).map((r) => r.status), [400, 400]);
    assert.equal((await post(b, body)).status, 400); // slot freed
  }, undefined, { maxInFlight: 2, ipLimiter: createRateLimiter({ capacity: 100, refillPerSecond: 1 }) });
});

test('new codes map to 409 and 504', async () => {
  const answers = [{ ok: false, code: 'DUPLICATE_DELEGATE', txHash: 'T' }, { ok: false, code: 'RELAY_PENDING' }];
  await withServer(async () => answers.shift(), async (b) => {
    assert.equal((await post(b, body)).status, 409);
    assert.equal((await post(b, body)).status, 504);
  });
});

test('N3-M1: GET /status/:hash enforces IP rate limiting', async () => {
  let statusCalls = 0;
  const relayer = {
    getTxStatus: async (h) => {
      statusCalls++;
      return { ok: true, status: 'FINAL' };
    },
  };
  const server = createServer({
    relayer,
    ipLimiter: createRateLimiter({ capacity: 2, refillPerSecond: 0.001 }),
  });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const r1 = await fetch(base + '/status/HASH1');
    assert.equal(r1.status, 200);
    const r2 = await fetch(base + '/status/HASH2');
    assert.equal(r2.status, 200);
    const r3 = await fetch(base + '/status/HASH3');
    assert.equal(r3.status, 429);
    assert.equal((await r3.json()).code, 'IP_RATE_LIMITED');
    assert.equal(statusCalls, 2);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
});

