// Parametric generator for Category 8: Format and Parsing (Layer C - Client Parser)
// Based on client/README.md and client/src/payment.mjs specification:
// parsePaymentResponse: parses JSON/base64/base64url payment responses or headers.
// buildPaymentSignature: constructs and signs x402-style payment payload.

/**
 * Helper to build deeply nested JSON string
 */
function buildDeeplyNestedJson(depth = 1500) {
  let s = '{"v": 1}';
  for (let i = 0; i < depth; i++) {
    s = `{"n":${s}}`;
  }
  return s;
}

/**
 * Helper to build large JSON payload (~50KB)
 */
function buildLargeJsonPayload() {
  const filler = 'a'.repeat(50000);
  return JSON.stringify({
    ok: true,
    tx_hash: 'tx_large_payload_valid_hash_12345',
    filler,
  });
}

/**
 * Valid sample requirements for buildPaymentSignature tests
 */
const VALID_REQUIREMENTS = {
  payTo: 'bob.near',
  amount: '1000',
  asset: 'NEAR',
  mandate: 1n,
};

/**
 * Parameter strategies for Category 8 (Client Format and Parsing).
 */
export const FORMAT_PARSING_VARIATIONS = [
  // --- parsePaymentResponse: base64 variations ---
  {
    subId: '01',
    title: 'Corrupted base64 with invalid symbols',
    target: 'parsePaymentResponse',
    input: '!@#$%^&*()_+',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Invalid base64 characters throw RangeError',
  },
  {
    subId: '02',
    title: 'Unpadded base64 containing valid JSON object',
    target: 'parsePaymentResponse',
    input: Buffer.from('{"ok":true,"tx_hash":"tx_unpadded_123"}').toString('base64').replace(/=+$/, ''),
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'Unpadded base64 is padded automatically and parsed',
  },
  {
    subId: '03',
    title: 'URL-safe base64 containing valid JSON object',
    target: 'parsePaymentResponse',
    input: Buffer.from('{"ok":true,"tx_hash":"tx_urlsafe_123"}').toString('base64url'),
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'URL-safe base64 characters (- and _) are converted and parsed',
  },
  {
    subId: '04',
    title: 'Malformed base64 padding (triple equals ===)',
    target: 'parsePaymentResponse',
    input: Buffer.from('{"ok":true}').toString('base64') + '===',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Illegal padding length fails base64 validation',
  },
  {
    subId: '05',
    title: 'Valid base64 containing non-JSON plaintext',
    target: 'parsePaymentResponse',
    input: Buffer.from('this is raw plaintext, not JSON').toString('base64'),
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Base64 decoding to non-JSON text throws RangeError',
  },
  {
    subId: '06',
    title: 'Base64 decoding to JSON array instead of object',
    target: 'parsePaymentResponse',
    input: Buffer.from('["item1", "item2"]').toString('base64'),
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Top-level array is an invalid payment response format',
  },
  {
    subId: '07',
    title: 'Base64 decoding to JSON primitive number',
    target: 'parsePaymentResponse',
    input: Buffer.from('12345').toString('base64'),
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Primitive JSON number throws RangeError',
  },
  {
    subId: '08',
    title: 'Base64 decoding to JSON primitive boolean',
    target: 'parsePaymentResponse',
    input: Buffer.from('true').toString('base64'),
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Primitive JSON boolean throws RangeError',
  },
  {
    subId: '09',
    title: 'Empty string input to payment response parser',
    target: 'parsePaymentResponse',
    input: '',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Empty string throws RangeError',
  },
  {
    subId: '10',
    title: 'Whitespace only input string',
    target: 'parsePaymentResponse',
    input: '     ',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Whitespace-only string throws RangeError',
  },

  // --- parsePaymentResponse: JSON structure variations ---
  {
    subId: '11',
    title: 'Deeply nested JSON structure (call stack exhaustion payload)',
    target: 'parsePaymentResponse',
    input: buildDeeplyNestedJson(1500),
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'V8 parses 1500 levels without throwing; parser returns a safe ok=false object',
  },
  {
    subId: '12',
    title: 'Duplicate JSON fields with identical values',
    target: 'parsePaymentResponse',
    input: '{"ok":true,"ok":true,"tx_hash":"tx_dup_identical"}',
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'Valid JSON with duplicate fields is parsed by standard parser',
  },
  {
    subId: '13',
    title: 'Duplicate JSON fields with conflicting status values',
    target: 'parsePaymentResponse',
    input: '{"ok":false,"ok":true,"tx_hash":"tx_dup_conflicting"}',
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'Standard JSON semantics keeps last duplicate key without crashing',
  },
  {
    subId: '14',
    title: 'Malformed JSON missing closing bracket',
    target: 'parsePaymentResponse',
    input: '{"ok":true,"tx_hash":"tx_unclosed"',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Truncated JSON syntax throws RangeError',
  },
  {
    subId: '15',
    title: 'Malformed JSON trailing comma in object',
    target: 'parsePaymentResponse',
    input: '{"ok":true,"tx_hash":"tx_trailing",}',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Trailing comma is invalid JSON and throws RangeError',
  },
  {
    subId: '16',
    title: 'Malformed JSON unquoted object key',
    target: 'parsePaymentResponse',
    input: '{ok:true,tx_hash:"tx_unquoted"}',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Unquoted key violates JSON specification and throws RangeError',
  },
  {
    subId: '17',
    title: 'Malformed JSON single-quoted string',
    target: 'parsePaymentResponse',
    input: "{'ok':true,'tx_hash':'tx_single_quote'}",
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Single quotes are invalid JSON and throw RangeError',
  },
  {
    subId: '18',
    title: 'Large 50KB JSON payload',
    target: 'parsePaymentResponse',
    input: buildLargeJsonPayload(),
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'Valid large JSON payload parses without crashing',
  },
  {
    subId: '19',
    title: 'Valid Unicode emojis and non-ASCII characters in JSON',
    target: 'parsePaymentResponse',
    input: '{"ok":true,"tx_hash":"tx_🔥_⚡_100","payer":"alïce_spécial"}',
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'Valid UTF-8 Unicode is supported in JSON',
  },
  {
    subId: '20',
    title: 'Malformed truncated Unicode escape in JSON',
    target: 'parsePaymentResponse',
    input: '{"ok":true,"tx_hash":"\\u12"}',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Truncated Unicode escape sequence throws RangeError',
  },

  // --- parsePaymentResponse: type mismatches ---
  {
    subId: '21',
    title: 'Input as number primitive (42)',
    target: 'parsePaymentResponse',
    input: 42,
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Non-string, non-object input throws RangeError',
  },
  {
    subId: '22',
    title: 'Input as boolean primitive (false)',
    target: 'parsePaymentResponse',
    input: false,
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Boolean input throws RangeError',
  },
  {
    subId: '23',
    title: 'Input as null',
    target: 'parsePaymentResponse',
    input: null,
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'null input throws TypeError responseOrHeader is required',
  },
  {
    subId: '24',
    title: 'Input as undefined',
    target: 'parsePaymentResponse',
    input: undefined,
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'undefined input throws TypeError',
  },
  {
    subId: '25',
    title: 'Response object with invalid base64 in payment-response header',
    target: 'parsePaymentResponse',
    input: {
      headers: {
        get: (h) => (h === 'payment-response' ? '!invalid_b64!' : null),
      },
    },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'Invalid base64 header is ignored and the parser falls back to a safe ok=false object',
  },
  {
    subId: '26',
    title: 'Response object with valid JSON base64 in payment-response header',
    target: 'parsePaymentResponse',
    input: {
      headers: {
        get: (h) => (h === 'payment-response' ? Buffer.from('{"ok":true,"tx_hash":"tx_hdr"}').toString('base64') : null),
      },
    },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'Valid header base64 is decoded and parsed successfully',
  },

  // --- buildPaymentSignature: requirement & option validations ---
  {
    subId: '27',
    title: 'buildPaymentSignature: requirements null',
    target: 'buildPaymentSignature',
    requirements: null,
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'requirements must be an object',
  },
  {
    subId: '28',
    title: 'buildPaymentSignature: requirements as array',
    target: 'buildPaymentSignature',
    requirements: [],
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'Array requirements throws TypeError',
  },
  {
    subId: '29',
    title: 'buildPaymentSignature: requirements as primitive string',
    target: 'buildPaymentSignature',
    requirements: 'invalid',
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'String requirements throws TypeError',
  },
  {
    subId: '30',
    title: 'buildPaymentSignature: options as array',
    target: 'buildPaymentSignature',
    requirements: VALID_REQUIREMENTS,
    options: [],
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'Array options throws TypeError',
  },
  {
    subId: '31',
    title: 'buildPaymentSignature: payTo missing in requirements',
    target: 'buildPaymentSignature',
    requirements: { ...VALID_REQUIREMENTS, payTo: undefined },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'payTo must be a non-empty string',
  },
  {
    subId: '32',
    title: 'buildPaymentSignature: payTo empty string',
    target: 'buildPaymentSignature',
    requirements: { ...VALID_REQUIREMENTS, payTo: '' },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'payTo empty string throws TypeError',
  },
  {
    subId: '33',
    title: 'buildPaymentSignature: payTo with uppercase characters',
    target: 'buildPaymentSignature',
    requirements: { ...VALID_REQUIREMENTS, payTo: 'BOB.near' },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Uppercase characters in payTo violate recipient format',
  },
  {
    subId: '34',
    title: 'buildPaymentSignature: payTo with illegal symbol (@)',
    target: 'buildPaymentSignature',
    requirements: { ...VALID_REQUIREMENTS, payTo: 'bob@near' },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Symbol @ not allowed in recipient',
  },
  {
    subId: '35',
    title: 'buildPaymentSignature: payTo length 65 bytes (exceeds max)',
    target: 'buildPaymentSignature',
    requirements: { ...VALID_REQUIREMENTS, payTo: 'b'.repeat(65) },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Recipient longer than 64 bytes throws RangeError',
  },
  {
    subId: '36',
    title: 'buildPaymentSignature: amount non-numeric string',
    target: 'buildPaymentSignature',
    requirements: { ...VALID_REQUIREMENTS, amount: 'one_hundred' },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Non-numeric amount throws RangeError',
  },
  {
    subId: '37',
    title: 'buildPaymentSignature: amount floating point ("12.5")',
    target: 'buildPaymentSignature',
    requirements: { ...VALID_REQUIREMENTS, amount: '12.5' },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Floating point amount throws RangeError',
  },
  {
    subId: '38',
    title: 'buildPaymentSignature: amount negative string ("-50")',
    target: 'buildPaymentSignature',
    requirements: { ...VALID_REQUIREMENTS, amount: '-50' },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Negative amount throws RangeError',
  },
  {
    subId: '39',
    title: 'buildPaymentSignature: asset missing or empty',
    target: 'buildPaymentSignature',
    requirements: { ...VALID_REQUIREMENTS, asset: '' },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'asset must be a non-empty string',
  },
  {
    subId: '40',
    title: 'buildPaymentSignature: mandateId missing',
    target: 'buildPaymentSignature',
    requirements: { payTo: 'bob.near', amount: '1000', asset: 'NEAR' },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'mandate must be specified in requirements',
  },
  {
    subId: '41',
    title: 'buildPaymentSignature: mandateId negative BigInt (-1n)',
    target: 'buildPaymentSignature',
    requirements: { ...VALID_REQUIREMENTS, mandate: -1n },
    options: {},
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Negative mandateId throws RangeError',
  },
  {
    subId: '42',
    title: 'buildPaymentSignature: agentId missing in options',
    target: 'buildPaymentSignature',
    requirements: VALID_REQUIREMENTS,
    options: { agentId: '' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'agentId must be a non-empty string',
  },
  {
    subId: '43',
    title: 'buildPaymentSignature: keyPair missing in options',
    target: 'buildPaymentSignature',
    requirements: VALID_REQUIREMENTS,
    options: { agentId: 'agent.testnet', keyPair: null },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'keyPair must be a near-api-js KeyPair',
  },
  {
    subId: '44',
    title: 'buildPaymentSignature: contractId missing in options and requirements',
    target: 'buildPaymentSignature',
    requirements: VALID_REQUIREMENTS,
    options: {
      agentId: 'agent.testnet',
      keyPair: { getPublicKey: () => 'ed25519:test' },
      contractId: '',
    },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'contractId must be a non-empty string',
  },
];

/**
 * Parametric generator: builds Category 8 test cases from variation vectors.
 *
 * @param {Array<object>} [variations]
 * @returns {Array<object>}
 */
export function generateCategory8Cases(variations = FORMAT_PARSING_VARIATIONS) {
  return variations.map((v) => {
    const expected = {
      label: v.expectedLabel || 'BLOCKED',
    };
    if (v.expectedCode) {
      expected.code = v.expectedCode;
    }
    return {
      id: `KAT-C-08-${v.subId}`,
      category: 8,
      layer: 'C',
      title: v.title,
      params: {
        target: v.target,
        input: v.input,
        requirements: v.requirements,
        options: v.options,
      },
      expected,
    };
  });
}
