// Parametric generator for Category 1: Recipient Address Attacks (Layer C - Client Parser)
// Based on PRD 3.4 and client/README.md specification: recipient must match 1..64 chars of [a-z0-9._-]

const BASE_PARAMS = {
  mandateId: 1n,
  amount: '1000',
  nonce: 1n,
  expiresAtMs: 1700000000000n,
  contractId: 'amanat.testnet',
};

/**
 * Parameter strategies for recipient address malformations
 */
export const RECIPIENT_VARIATIONS = [
  {
    subId: '01',
    title: 'Uppercase characters in recipient',
    recipient: 'ALICE.near',
    expectedCode: 'RangeError',
    reason: 'Must match [a-z0-9._-] (lowercase ASCII only)',
  },
  {
    subId: '02',
    title: 'Space inside recipient address',
    recipient: 'alice .near',
    expectedCode: 'RangeError',
    reason: 'Whitespace is illegal in account IDs',
  },
  {
    subId: '03',
    title: 'Null byte injection in recipient',
    recipient: 'alice\0.near',
    expectedCode: 'RangeError',
    reason: 'Null bytes are illegal control characters',
  },
  {
    subId: '04',
    title: 'Recipient length 65 bytes (exceeds max 64 by 1)',
    recipient: 'a'.repeat(65),
    expectedCode: 'RangeError',
    reason: 'Maximum recipient length is 64 bytes',
  },
  {
    subId: '05',
    title: 'Extreme length recipient (2000 bytes DoS payload)',
    recipient: 'a'.repeat(2000),
    expectedCode: 'RangeError',
    reason: 'Must be blocked by length constraint before memory exhaustion',
  },
  {
    subId: '06',
    title: 'Leading space in recipient',
    recipient: ' alice.near',
    expectedCode: 'RangeError',
    reason: 'Leading whitespace is not allowed',
  },
  {
    subId: '07',
    title: 'Trailing space in recipient',
    recipient: 'alice.near ',
    expectedCode: 'RangeError',
    reason: 'Trailing whitespace is not allowed',
  },
  {
    subId: '08',
    title: 'Homoglyph Cyrillic character in recipient',
    recipient: '\u0430lice.near', // Cyrillic small letter a
    expectedCode: 'RangeError',
    reason: 'Non-ASCII characters must be blocked',
  },
  {
    subId: '09',
    title: 'Special punctuation symbols in recipient',
    recipient: 'alice$bob.near',
    expectedCode: 'RangeError',
    reason: 'Dollar sign not in [a-z0-9._-]',
  },
  {
    subId: '10',
    title: 'Empty recipient string (0 bytes)',
    recipient: '',
    expectedCode: 'RangeError',
    reason: 'Recipient must be at least 1 character',
  },
];

/**
 * Parametric generator: builds Category 1 test cases from variation vectors.
 *
 * @param {Array<object>} [variations]
 * @returns {Array<object>}
 */
export function generateCategory1Cases(variations = RECIPIENT_VARIATIONS) {
  return variations.map((v) => ({
    id: `KAT-C-01-${v.subId}`,
    category: 1,
    layer: 'C',
    title: v.title,
    params: {
      ...BASE_PARAMS,
      recipient: v.recipient,
    },
    expected: {
      label: 'BLOCKED',
      code: v.expectedCode,
    },
  }));
}
