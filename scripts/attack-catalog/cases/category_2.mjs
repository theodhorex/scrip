// Parametric generator for Category 2: Amount Attacks (Layer C - Client Parser)
// Based on PRD 3.4 and client/README.md specification: amount must be canonical decimal string, u128

const U128_MAX_PLUS_1 = (1n << 128n).toString(); // 340282366920938463463374607431768211456

const BASE_PARAMS = {
  mandateId: 1n,
  recipient: 'bob.near',
  nonce: 1n,
  expiresAtMs: 1700000000000n,
  contractId: 'amanat.testnet',
};

/**
 * Parameter strategies for amount malformations and boundary violations.
 * Expected values derived strictly from design specifications.
 */
export const AMOUNT_VARIATIONS = [
  {
    subId: '01',
    title: 'Zero amount transfer request (amount = 0)',
    amount: '0',
    expectedLabel: 'INERT',
    expectedCode: null,
    // Catatan tertulis: harapan awal salah tempat: lapis C hanya memeriksa format; penolakan nol diuji di lapis A
    reason: 'harapan awal salah tempat: lapis C hanya memeriksa format; penolakan nol diuji di lapis A',
  },
  {
    subId: '02',
    title: 'Amount u128::MAX + 1 (integer overflow beyond 128 bits)',
    amount: U128_MAX_PLUS_1,
    expectedCode: 'RangeError',
    reason: 'Must not exceed 128-bit unsigned integer maximum',
  },
  {
    subId: '03',
    title: 'Negative amount (-1)',
    amount: '-1',
    expectedCode: 'RangeError',
    reason: 'Negative amounts are disallowed in unsigned transfers',
  },
  {
    subId: '04',
    title: 'Large negative amount (-1000000000)',
    amount: '-1000000000',
    expectedCode: 'RangeError',
    reason: 'Negative signed amounts must be blocked from underflow',
  },
  {
    subId: '05',
    title: 'Decimal floating point amount (1.5)',
    amount: '1.5',
    expectedCode: 'RangeError',
    reason: 'Token amounts must be integer indivisible base units',
  },
  {
    subId: '06',
    title: 'Fractional decimal amount (0.0001)',
    amount: '0.0001',
    expectedCode: 'RangeError',
    reason: 'Decimals with leading zero are not canonical integer strings',
  },
  {
    subId: '07',
    title: 'Scientific notation amount (1e18)',
    amount: '1e18',
    expectedCode: 'RangeError',
    reason: 'Exponential notation contains non-digit characters',
  },
  {
    subId: '08',
    title: 'Uppercase scientific notation with plus (1E+24)',
    amount: '1E+24',
    expectedCode: 'RangeError',
    reason: 'Exponential syntax is disallowed in canonical format',
  },
  {
    subId: '09',
    title: 'Non-numeric string amount ("one_hundred")',
    amount: 'one_hundred',
    expectedCode: 'RangeError',
    reason: 'Alphabetic text cannot represent numeric token amount',
  },
  {
    subId: '10',
    title: 'Non-canonical leading zero amount ("0100")',
    amount: '0100',
    expectedCode: 'RangeError',
    reason: 'Leading zeros violate canonical decimal digits requirement',
  },
];

/**
 * Parametric generator: builds Category 2 test cases from variation vectors.
 *
 * @param {Array<object>} [variations]
 * @returns {Array<object>}
 */
export function generateCategory2Cases(variations = AMOUNT_VARIATIONS) {
  return variations.map((v) => {
    const expected = {
      label: v.expectedLabel || 'BLOCKED',
    };
    if (v.expectedCode) {
      expected.code = v.expectedCode;
    }
    return {
      id: `KAT-C-02-${v.subId}`,
      category: 2,
      layer: 'C',
      title: v.title,
      params: {
        ...BASE_PARAMS,
        amount: v.amount,
      },
      expected,
    };
  });
}
