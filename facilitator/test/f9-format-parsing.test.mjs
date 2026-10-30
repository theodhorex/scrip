// F9 Step 1: Format and parsing robustness tests (~40+ table-driven cases).
// Verifies fail-closed behavior: clear 4xx responses, server stays alive, zero stack traces.
import test from 'node:test';
import assert from 'node:assert/strict';
import http from 'node:http';
import { createServer, MAX_BODY_BYTES } from '../src/server.mjs';
import { makeRelayer } from '../src/relay.mjs';
import { basePolicy, fakeProvider } from './helpers.mjs';
import { loadPolicy } from '../src/policy.mjs';
import { createRateLimiter } from '../src/ratelimit.mjs';

const policy = loadPolicy(basePolicy);

async function withF9Server(fn) {
  const provider = fakeProvider();
  const limiter = createRateLimiter(policy.rateLimit);
  const relayer = makeRelayer({
    provider,
    relayerAccount: { accountId: 'relayer.testnet' },
    policy,
    limiter,
  });
  const server = createServer({ relayer, ipLimiter: createRateLimiter({ capacity: 200, refillPerSecond: 100 }) });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    await fn(base, server);
  } finally {
    server.closeAllConnections();
    await new Promise((r) => server.close(r));
  }
}

function rawRequest(urlStr, { method = 'POST', headers = {}, body = null } = {}) {
  return new Promise((resolve, reject) => {
    const u = new URL(urlStr);
    const req = http.request({
      hostname: u.hostname,
      port: u.port,
      path: u.pathname + u.search,
      method,
      headers,
    }, (res) => {
      const chunks = [];
      res.on('data', (c) => chunks.push(c));
      res.on('end', () => {
        const text = Buffer.concat(chunks).toString('utf8');
        resolve({
          status: res.statusCode,
          headers: res.headers,
          text,
          json: () => {
            try { return JSON.parse(text); } catch { return null; }
          },
        });
      });
    });
    req.on('error', reject);
    if (body !== null && body !== undefined) {
      req.write(body);
    }
    req.end();
  });
}

test('F9 Step 1: Format and parsing table (~40+ cases)', (t) => withF9Server(async (base) => {
  const cases = [
    // 1. Body not JSON
    { name: 'plain text body', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: 'not-json', expStatus: 400, expCode: 'BAD_JSON' },
    { name: 'empty text body with content-type', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '', expStatus: 400, expCode: 'BAD_JSON' },
    { name: 'whitespace body', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '   ', expStatus: 400, expCode: 'BAD_JSON' },
    { name: 'unclosed JSON object', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"signed_delegate":', expStatus: 400, expCode: 'BAD_JSON' },
    { name: 'HTML markup payload', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '<html><body>payload</body></html>', expStatus: 400, expCode: 'BAD_JSON' },
    { name: 'JSON boolean true', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: 'true', expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'JSON number 12345', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '12345', expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'JSON string literal', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '"string_value"', expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'JSON null literal', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: 'null', expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'JSON empty array', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '[]', expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'JSON array of integers', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '[1, 2, 3]', expStatus: 400, expCode: 'BAD_REQUEST' },

    // 2. Deeply nested JSON
    { name: 'deeply nested arrays >16KB', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '['.repeat(10000) + ']'.repeat(10000), expStatus: 413, expCode: 'BODY_TOO_LARGE' },
    { name: 'deeply nested objects within 16KB limit', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"a":'.repeat(1000) + '1' + '}'.repeat(1000), expStatus: 400, expCode: 'BAD_REQUEST' },

    // 3. Duplicate fields and invalid shapes
    { name: 'duplicate signed_delegate key with non-string', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"signed_delegate":"abc","signed_delegate":123}', expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'missing signed_delegate field in object', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"other":"val"}', expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'empty object {}', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'trailing junk after JSON', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"signed_delegate":"AAAA"} trailing', expStatus: 400, expCode: 'BAD_JSON' },

    // 4. Wrong field types
    { name: 'signed_delegate as number', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: 42 }), expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'signed_delegate as boolean', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: true }), expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'signed_delegate as null', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: null }), expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'signed_delegate as object', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: {} }), expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'signed_delegate as array', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: ['AAAA'] }), expStatus: 400, expCode: 'BAD_REQUEST' },

    // 5. Base64 corrupted / unpadded / url-safe
    { name: 'broken base64 characters', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: '!!!notbase64@@@' }), expStatus: 400, expCode: 'BAD_ENCODING' },
    { name: 'base64 with whitespace inside', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: 'AAAA BBBB CCCC' }), expStatus: 400, expCode: 'BAD_ENCODING' },
    { name: 'unpadded base64 string', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: 'eyJhIjoxfQ' }), expStatus: 400, expCode: 'BAD_ENCODING' },
    { name: 'url-safe base64 string (- and _)', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: 'eyJh-jox_Q==' }), expStatus: 400, expCode: 'BAD_ENCODING' },
    { name: 'truncated base64 borsh', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: 'AAAA' }), expStatus: 400, expCode: 'BAD_ENCODING' },
    { name: 'empty base64 string', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: '' }), expStatus: 400, expCode: 'BAD_ENCODING' },
    { name: 'excessive length base64 string within 16KB', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: 'A'.repeat(12000) }), expStatus: 400, expCode: 'BAD_ENCODING' },

    // 6. Payload size boundaries
    { name: 'payload exactly 16KB limit + 1 byte (413)', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{"signed_delegate":"' + 'A'.repeat(MAX_BODY_BYTES - 21 + 2) + '"}', expStatus: 413, expCode: 'BODY_TOO_LARGE' },
    { name: 'payload 1MB with header (413)', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json', 'content-length': '1048576' }, body: '{"a":1}', expStatus: 413, expCode: 'BODY_TOO_LARGE' },

    // 7. Unicode and odd characters
    { name: 'null byte \\u0000 inside string', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: 'AAAA\u0000BBBB' }), expStatus: 400, expCode: 'BAD_ENCODING' },
    { name: 'RTL override \\u202E inside string', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: 'AAAA\u202EBBBB' }), expStatus: 400, expCode: 'BAD_ENCODING' },
    { name: 'zero-width space \\u200B inside string', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: 'AAAA\u200BBBBB' }), expStatus: 400, expCode: 'BAD_ENCODING' },
    { name: 'emoji inside signed_delegate string', path: '/relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ signed_delegate: '🚀🔥' }), expStatus: 400, expCode: 'BAD_ENCODING' },

    // 8. Header missing / wrong / giant
    { name: 'missing Content-Type header on /relay', path: '/relay', method: 'POST', headers: {}, body: '{}', expStatus: 415, expCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { name: 'text/plain Content-Type on /relay', path: '/relay', method: 'POST', headers: { 'content-type': 'text/plain' }, body: '{}', expStatus: 415, expCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { name: 'application/x-www-form-urlencoded Content-Type', path: '/relay', method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: 'signed_delegate=foo', expStatus: 415, expCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { name: 'missing PAYMENT-SIGNATURE on /verify', path: '/verify', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', expStatus: 400, expCode: 'MISSING_PAYMENT_SIGNATURE' },
    { name: 'missing PAYMENT-SIGNATURE on /settle', path: '/settle', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', expStatus: 400, expCode: 'MISSING_PAYMENT_SIGNATURE' },
    { name: 'corrupted PAYMENT-SIGNATURE on /verify', path: '/verify', method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': 'not-base64!' }, body: '{}', expStatus: 400, expCode: 'BAD_PAYMENT_SIGNATURE' },
    { name: 'giant PAYMENT-SIGNATURE on /verify', path: '/verify', method: 'POST', headers: { 'content-type': 'application/json', 'payment-signature': 'A'.repeat(17000) }, body: '{}', expStatus: 431 },

    // 9. HTTP method errors (405)
    { name: 'GET /relay -> 405', path: '/relay', method: 'GET', expStatus: 405, expCode: 'METHOD_NOT_ALLOWED' },
    { name: 'PUT /relay -> 405', path: '/relay', method: 'PUT', expStatus: 405, expCode: 'METHOD_NOT_ALLOWED' },
    { name: 'DELETE /relay -> 405', path: '/relay', method: 'DELETE', expStatus: 405, expCode: 'METHOD_NOT_ALLOWED' },
    { name: 'PATCH /relay -> 405', path: '/relay', method: 'PATCH', expStatus: 405, expCode: 'METHOD_NOT_ALLOWED' },
    { name: 'POST /health -> 405', path: '/health', method: 'POST', expStatus: 405, expCode: 'METHOD_NOT_ALLOWED' },
    { name: 'POST /metrics -> 405', path: '/metrics', method: 'POST', expStatus: 405, expCode: 'METHOD_NOT_ALLOWED' },
    { name: 'POST /supported -> 405', path: '/supported', method: 'POST', expStatus: 405, expCode: 'METHOD_NOT_ALLOWED' },
    { name: 'POST /status/123 -> 405', path: '/status/123', method: 'POST', expStatus: 405, expCode: 'METHOD_NOT_ALLOWED' },
    { name: 'GET /verify -> 405', path: '/verify', method: 'GET', expStatus: 405, expCode: 'METHOD_NOT_ALLOWED' },
    { name: 'GET /settle -> 405', path: '/settle', method: 'GET', expStatus: 405, expCode: 'METHOD_NOT_ALLOWED' },

    // 10. Strange paths & traversal
    { name: 'double slash //relay -> 404', path: '//relay', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', expStatus: 404, expCode: 'NOT_FOUND' },
    { name: 'path traversal /relay/.. -> 404', path: '/relay/..', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', expStatus: 404, expCode: 'NOT_FOUND' },
    { name: 'subpath /relay/extra -> 404', path: '/relay/extra', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', expStatus: 404, expCode: 'NOT_FOUND' },
    { name: 'URL with null byte %00 -> 404', path: '/relay%00', method: 'POST', headers: { 'content-type': 'application/json' }, body: '{}', expStatus: 404, expCode: 'NOT_FOUND' },
    { name: 'empty tx hash /status/ -> 400', path: '/status/', method: 'GET', expStatus: 400, expCode: 'BAD_REQUEST' },
    { name: 'unknown tx hash /status/random123 -> 404', path: '/status/random123', method: 'GET', expStatus: 404, expCode: 'TX_NOT_FOUND' },
    { name: 'tx hash with path traversal /status/.. -> 404', path: '/status/..', method: 'GET', expStatus: 404, expCode: 'NOT_FOUND' },
    { name: 'tx hash with null byte /status/%00 -> 404', path: '/status/%00', method: 'GET', expStatus: 404, expCode: 'TX_NOT_FOUND' },
    { name: 'completely unknown path /nope -> 404', path: '/nope', method: 'GET', expStatus: 404, expCode: 'NOT_FOUND' },
  ];

  for (const c of cases) {
    await t.test(c.name, async () => {
      const reqHeaders = { ...c.headers };
      if (c.body !== null && c.body !== undefined && !reqHeaders['content-length']) {
        reqHeaders['content-length'] = String(Buffer.byteLength(c.body));
      }
      const res = await rawRequest(base + c.path, {
        method: c.method,
        headers: reqHeaders,
        body: c.body,
      });
      // Security check: must match expected 4xx status
      assert.equal(res.status, c.expStatus, `Case failed: ${c.name} expected status ${c.expStatus} got ${res.status}`);
      
      // Security check: response body must never leak stack trace or internal secrets
      assert.ok(!res.text.includes('at '), `Case leaked stack trace: ${c.name}`);
      assert.ok(!res.text.includes('Error:'), `Case leaked Error trace: ${c.name}`);
      assert.ok(!res.text.includes('node:'), `Case leaked node internals: ${c.name}`);

      // If expected code is specified and response is JSON, check code
      if (c.expCode) {
        const data = res.json();
        assert.ok(data !== null, `Case did not return JSON: ${c.name}`);
        assert.equal(data.ok, false, `Case ok should be false: ${c.name}`);
        assert.equal(data.code, c.expCode, `Case code mismatch for ${c.name}`);
      }
    });
  }

  // Health check: server MUST remain fully operational and alive after all attacks
  const health = await rawRequest(base + '/health', { method: 'GET' });
  assert.equal(health.status, 200);
  assert.deepEqual(health.json(), { ok: true });
}));
