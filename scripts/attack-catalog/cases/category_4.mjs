// Parametric generator for Category 4: Approvals and Nonce (Layer C - Client Parser)
// Based on PRD 3.4 and client/README.md specification:
// mandateId/nonce/expiresAtMs: BigInt or safe-integer Number.
// Throws TypeError (wrong type, non-integer Number) / RangeError (range, non-safe integer).

const U64_MAX = (1n << 64n) - 1n;
const U64_MAX_PLUS_1 = 1n << 64n;
const UNSAFE_INT = Number.MAX_SAFE_INTEGER + 2;

const BASE_PARAMS = {
  mandateId: 1n,
  recipient: 'bob.near',
  amount: '1000',
  nonce: 1n,
  expiresAtMs: 1700000000000n,
  contractId: 'amanat.testnet',
};

/**
 * Parameter strategies for nonce, expiration, and mandateId variations.
 * Expected labels and codes derived strictly from client/README.md design.
 */
export const NONCE_APPROVAL_VARIATIONS = [
  // --- Nonce variations ---
  {
    subId: '01',
    title: 'Nonce zero as BigInt (0n)',
    paramPatch: { nonce: 0n },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: '0 is a valid u64 integer',
  },
  {
    subId: '02',
    title: 'Nonce zero as safe-integer Number (0)',
    paramPatch: { nonce: 0 },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: '0 is a valid safe-integer Number',
  },
  {
    subId: '03',
    title: 'Nonce standard safe-integer Number (1000)',
    paramPatch: { nonce: 1000 },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'Safe-integer numbers are allowed by client parser',
  },
  {
    subId: '04',
    title: 'Nonce maximum u64 value (2^64 - 1)',
    paramPatch: { nonce: U64_MAX },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'u64::MAX is within valid range',
  },
  {
    subId: '05',
    title: 'Nonce exceeds u64 maximum by 1 (2^64)',
    paramPatch: { nonce: U64_MAX_PLUS_1 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Values > 2^64-1 throw RangeError out of u64 range',
  },
  {
    subId: '06',
    title: 'Nonce negative BigInt (-1n)',
    paramPatch: { nonce: -1n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Negative values throw RangeError out of u64 range',
  },
  {
    subId: '07',
    title: 'Nonce negative Number (-1)',
    paramPatch: { nonce: -1 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Negative numbers throw RangeError out of u64 range',
  },
  {
    subId: '08',
    title: 'Nonce floating point Number (1.5)',
    paramPatch: { nonce: 1.5 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'Non-integer numbers throw TypeError',
  },
  {
    subId: '09',
    title: 'Nonce NaN value',
    paramPatch: { nonce: NaN },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'NaN is not an integer and throws TypeError',
  },
  {
    subId: '10',
    title: 'Nonce positive Infinity',
    paramPatch: { nonce: Infinity },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'Infinity is not an integer and throws TypeError',
  },
  {
    subId: '11',
    title: 'Nonce negative Infinity',
    paramPatch: { nonce: -Infinity },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: '-Infinity is not an integer and throws TypeError',
  },
  {
    subId: '12',
    title: 'Nonce as decimal string ("1")',
    paramPatch: { nonce: '1' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'Nonce must be BigInt or safe-integer Number, string throws TypeError',
  },
  {
    subId: '13',
    title: 'Nonce as hex string ("0x01")',
    paramPatch: { nonce: '0x01' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'Hex string throws TypeError',
  },
  {
    subId: '14',
    title: 'Nonce as unsafe integer (> Number.MAX_SAFE_INTEGER)',
    paramPatch: { nonce: UNSAFE_INT },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Unsafe integers require BigInt and throw RangeError',
  },
  {
    subId: '15',
    title: 'Nonce null value',
    paramPatch: { nonce: null },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'null is not BigInt or Number and throws TypeError',
  },
  {
    subId: '16',
    title: 'Nonce undefined value',
    paramPatch: { nonce: undefined },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'undefined throws TypeError',
  },
  {
    subId: '17',
    title: 'Nonce boolean true',
    paramPatch: { nonce: true },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'boolean throws TypeError',
  },

  // --- expiresAtMs variations ---
  {
    subId: '18',
    title: 'expiresAtMs zero as BigInt (0n)',
    paramPatch: { expiresAtMs: 0n },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: '0 is a valid u64 timestamp',
  },
  {
    subId: '19',
    title: 'expiresAtMs zero as safe-integer Number (0)',
    paramPatch: { expiresAtMs: 0 },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: '0 is a valid safe-integer timestamp',
  },
  {
    subId: '20',
    title: 'expiresAtMs maximum u64 value (2^64 - 1)',
    paramPatch: { expiresAtMs: U64_MAX },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'u64::MAX is within valid range',
  },
  {
    subId: '21',
    title: 'expiresAtMs exceeds u64 maximum by 1 (2^64)',
    paramPatch: { expiresAtMs: U64_MAX_PLUS_1 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Values > 2^64-1 throw RangeError out of u64 range',
  },
  {
    subId: '22',
    title: 'expiresAtMs negative BigInt (-1n)',
    paramPatch: { expiresAtMs: -1n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Negative values throw RangeError',
  },
  {
    subId: '23',
    title: 'expiresAtMs negative Number (-1000)',
    paramPatch: { expiresAtMs: -1000 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Negative numbers throw RangeError',
  },
  {
    subId: '24',
    title: 'expiresAtMs floating point Number (1700000000.5)',
    paramPatch: { expiresAtMs: 1700000000.5 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'Float numbers throw TypeError',
  },
  {
    subId: '25',
    title: 'expiresAtMs NaN value',
    paramPatch: { expiresAtMs: NaN },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'NaN throws TypeError',
  },
  {
    subId: '26',
    title: 'expiresAtMs Infinity',
    paramPatch: { expiresAtMs: Infinity },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'Infinity throws TypeError',
  },
  {
    subId: '27',
    title: 'expiresAtMs as string ("1700000000000")',
    paramPatch: { expiresAtMs: '1700000000000' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'String throws TypeError',
  },
  {
    subId: '28',
    title: 'expiresAtMs as unsafe integer (> Number.MAX_SAFE_INTEGER)',
    paramPatch: { expiresAtMs: UNSAFE_INT },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Unsafe integers throw RangeError',
  },
  {
    subId: '29',
    title: 'expiresAtMs null value',
    paramPatch: { expiresAtMs: null },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'null throws TypeError',
  },
  {
    subId: '30',
    title: 'expiresAtMs undefined value',
    paramPatch: { expiresAtMs: undefined },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'undefined throws TypeError',
  },

  // --- mandateId variations ---
  {
    subId: '31',
    title: 'mandateId zero as BigInt (0n)',
    paramPatch: { mandateId: 0n },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: '0 is a valid u64 mandateId',
  },
  {
    subId: '32',
    title: 'mandateId zero as safe-integer Number (0)',
    paramPatch: { mandateId: 0 },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: '0 is a valid safe-integer mandateId',
  },
  {
    subId: '33',
    title: 'mandateId maximum u64 value (2^64 - 1)',
    paramPatch: { mandateId: U64_MAX },
    expectedLabel: 'INERT',
    expectedCode: null,
    reason: 'u64::MAX is valid mandateId range',
  },
  {
    subId: '34',
    title: 'mandateId exceeds u64 maximum by 1 (2^64)',
    paramPatch: { mandateId: U64_MAX_PLUS_1 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Values > 2^64-1 throw RangeError',
  },
  {
    subId: '35',
    title: 'mandateId negative BigInt (-1n)',
    paramPatch: { mandateId: -1n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Negative values throw RangeError',
  },
  {
    subId: '36',
    title: 'mandateId negative Number (-1)',
    paramPatch: { mandateId: -1 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Negative numbers throw RangeError',
  },
  {
    subId: '37',
    title: 'mandateId floating point Number (1.5)',
    paramPatch: { mandateId: 1.5 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'Floating point mandateId throws TypeError',
  },
  {
    subId: '38',
    title: 'mandateId NaN value',
    paramPatch: { mandateId: NaN },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'NaN throws TypeError',
  },
  {
    subId: '39',
    title: 'mandateId as string ("1")',
    paramPatch: { mandateId: '1' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'String mandateId throws TypeError',
  },
  {
    subId: '40',
    title: 'mandateId as unsafe integer (> Number.MAX_SAFE_INTEGER)',
    paramPatch: { mandateId: UNSAFE_INT },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RangeError',
    reason: 'Unsafe integers throw RangeError',
  },
  {
    subId: '41',
    title: 'mandateId null value',
    paramPatch: { mandateId: null },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'null throws TypeError',
  },
  {
    subId: '42',
    title: 'mandateId object payload ({ id: 1 })',
    paramPatch: { mandateId: { id: 1 } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TypeError',
    reason: 'Object mandateId throws TypeError',
  },
];

/**
 * Parametric generator: builds Category 4 test cases from variation vectors.
 *
 * @param {Array<object>} [variations]
 * @returns {Array<object>}
 */
export function generateCategory4Cases(variations = NONCE_APPROVAL_VARIATIONS) {
  return variations.map((v) => {
    const expected = {
      label: v.expectedLabel || 'BLOCKED',
    };
    if (v.expectedCode) {
      expected.code = v.expectedCode;
    }
    return {
      id: `KAT-C-04-${v.subId}`,
      category: 4,
      layer: 'C',
      title: v.title,
      params: {
        ...BASE_PARAMS,
        ...v.paramPatch,
      },
      expected,
    };
  });
}
