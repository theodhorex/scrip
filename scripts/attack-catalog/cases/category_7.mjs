// Parametric generator for Category 7: Gas and Resources (Layer B - Facilitator HTTP)
// Based on PRD v1.3, facilitator/README.md, and validate.mjs specification:
// - fc.gas must be >= policy.minGas (default: 60 Tgas = 60_000_000_000_000)
// - fc.gas must be <= policy.maxGas (default: 100 Tgas = 100_000_000_000_000)
// - fc.deposit must be strictly 0n (DEPOSIT_NOT_ZERO)
// - da.nonce must be > 0n (NONCE_INVALID) and > keyNonce (NONCE_TOO_LOW)
// - da.maxBlockHeight must be >= current + minBlockHeightMargin (EXPIRES_TOO_SOON)
// - da.maxBlockHeight must be <= current + maxBlockHeightWindow (EXPIRES_TOO_FAR)

const TGAS = 10n ** 12n;
const U64_MAX = (1n << 64n) - 1n;
const U128_MAX = (1n << 128n) - 1n;

const BASE_PARAMS = {
  method: 'POST',
  path: '/relay',
  headers: {
    'content-type': 'application/json',
  },
};

export const CATEGORY_7_VARIATIONS = [
  // --- 1. Gas below minGas (60 Tgas) ---
  {
    subId: '01',
    title: 'Gas zero (0 Tgas)',
    delegate: { gas: 0n, nonce: 701n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_LOW',
    reason: 'Gas must be at least 60 Tgas',
  },
  {
    subId: '02',
    title: 'Gas 1 gas unit',
    delegate: { gas: 1n, nonce: 702n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_LOW',
    reason: 'Gas below minGas is rejected',
  },
  {
    subId: '03',
    title: 'Gas 1 Tgas (1,000,000,000,000)',
    delegate: { gas: TGAS, nonce: 703n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_LOW',
    reason: '1 Tgas is well below 60 Tgas policy threshold',
  },
  {
    subId: '04',
    title: 'Gas 10 Tgas',
    delegate: { gas: 10n * TGAS, nonce: 704n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_LOW',
    reason: '10 Tgas is below policy minimum',
  },
  {
    subId: '05',
    title: 'Gas 30 Tgas',
    delegate: { gas: 30n * TGAS, nonce: 705n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_LOW',
    reason: '30 Tgas is below policy minimum',
  },
  {
    subId: '06',
    title: 'Gas 50 Tgas',
    delegate: { gas: 50n * TGAS, nonce: 706n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_LOW',
    reason: '50 Tgas is below 60 Tgas policy threshold',
  },
  {
    subId: '07',
    title: 'Gas 59 Tgas',
    delegate: { gas: 59n * TGAS, nonce: 707n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_LOW',
    reason: '59 Tgas is 1 Tgas below policy minimum',
  },
  {
    subId: '08',
    title: 'Gas exactly 1 unit below minGas (59.999... Tgas)',
    delegate: { gas: 60n * TGAS - 1n, nonce: 708n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_LOW',
    reason: 'Boundary check: minGas - 1 must fail',
  },

  // --- 2. Gas above maxGas (100 Tgas) ---
  {
    subId: '09',
    title: 'Gas exactly 1 unit above maxGas (100.000...1 Tgas)',
    delegate: { gas: 100n * TGAS + 1n, nonce: 709n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_HIGH',
    reason: 'Boundary check: maxGas + 1 must fail',
  },
  {
    subId: '10',
    title: 'Gas 101 Tgas',
    delegate: { gas: 101n * TGAS, nonce: 710n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_HIGH',
    reason: '101 Tgas exceeds policy maxGas of 100 Tgas',
  },
  {
    subId: '11',
    title: 'Gas 150 Tgas',
    delegate: { gas: 150n * TGAS, nonce: 711n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_HIGH',
    reason: '150 Tgas exceeds policy maxGas',
  },
  {
    subId: '12',
    title: 'Gas 200 Tgas',
    delegate: { gas: 200n * TGAS, nonce: 712n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_HIGH',
    reason: '200 Tgas exceeds policy maxGas',
  },
  {
    subId: '13',
    title: 'Gas 300 Tgas (NEAR block gas limit)',
    delegate: { gas: 300n * TGAS, nonce: 713n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_HIGH',
    reason: '300 Tgas exceeds policy maxGas',
  },
  {
    subId: '14',
    title: 'Gas u64::MAX (2^64 - 1)',
    delegate: { gas: U64_MAX, nonce: 714n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GAS_TOO_HIGH',
    reason: 'Maximum possible u64 gas exceeds policy maxGas',
  },

  // --- 3. Non-zero deposit variations ---
  {
    subId: '15',
    title: 'Deposit 1 yoctoNEAR',
    delegate: { deposit: 1n, nonce: 715n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'DEPOSIT_NOT_ZERO',
    reason: 'Relayed delegates must specify zero attached deposit',
  },
  {
    subId: '16',
    title: 'Deposit 100 yoctoNEAR',
    delegate: { deposit: 100n, nonce: 716n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'DEPOSIT_NOT_ZERO',
    reason: 'Non-zero deposit rejected',
  },
  {
    subId: '17',
    title: 'Deposit 1 milliNEAR (10^21 yoctoNEAR)',
    delegate: { deposit: 10n ** 21n, nonce: 717n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'DEPOSIT_NOT_ZERO',
    reason: 'Non-zero deposit rejected',
  },
  {
    subId: '18',
    title: 'Deposit 1 NEAR (10^24 yoctoNEAR)',
    delegate: { deposit: 10n ** 24n, nonce: 718n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'DEPOSIT_NOT_ZERO',
    reason: 'NEAR transfer attempt via relay deposit rejected',
  },
  {
    subId: '19',
    title: 'Deposit 100 NEAR',
    delegate: { deposit: 100n * 10n ** 24n, nonce: 719n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'DEPOSIT_NOT_ZERO',
    reason: 'Large deposit rejected',
  },
  {
    subId: '20',
    title: 'Deposit u128::MAX (2^128 - 1)',
    delegate: { deposit: U128_MAX, nonce: 720n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'DEPOSIT_NOT_ZERO',
    reason: 'Maximum u128 deposit rejected',
  },

  // --- 4. Nonce and block height resources ---
  {
    subId: '21',
    title: 'Delegate nonce zero (0n)',
    delegate: { nonce: 0n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NONCE_INVALID',
    reason: 'DelegateAction nonce must be strictly positive non-zero',
  },
  {
    subId: '22',
    title: 'Delegate nonce lower than on-chain key nonce (nonce 5 < keyNonce 10)',
    delegate: { nonce: 5n },
    keyNonce: 10n,
    expectedLabel: 'BLOCKED',
    expectedCode: 'NONCE_TOO_LOW',
    reason: 'Delegate nonce must strictly exceed on-chain access key nonce',
  },
  {
    subId: '23',
    title: 'Delegate nonce equal to on-chain key nonce (nonce 10 == keyNonce 10)',
    delegate: { nonce: 10n },
    keyNonce: 10n,
    expectedLabel: 'BLOCKED',
    expectedCode: 'NONCE_TOO_LOW',
    reason: 'Delegate nonce equal to keyNonce is rejected (must be greater)',
  },
  {
    subId: '24',
    title: 'Delegate maxBlockHeight in the past (height 1000, maxBlockHeight 900)',
    delegate: { maxBlockHeight: 900n, nonce: 724n },
    height: 1000,
    expectedLabel: 'BLOCKED',
    expectedCode: 'EXPIRES_TOO_SOON',
    reason: 'Past block height rejected',
  },
  {
    subId: '25',
    title: 'Delegate maxBlockHeight below safety margin (height 1000, margin 5, max 1004)',
    delegate: { maxBlockHeight: 1004n, nonce: 725n },
    height: 1000,
    expectedLabel: 'BLOCKED',
    expectedCode: 'EXPIRES_TOO_SOON',
    reason: 'Block height below minBlockHeightMargin rejected',
  },
  {
    subId: '26',
    title: 'Delegate maxBlockHeight beyond window (height 1000, window 200, max 1201)',
    delegate: { maxBlockHeight: 1201n, nonce: 726n },
    height: 1000,
    expectedLabel: 'BLOCKED',
    expectedCode: 'EXPIRES_TOO_FAR',
    reason: 'Block height beyond maxBlockHeightWindow rejected',
  },
];

/**
 * Parametric generator: builds Category 7 test cases for Layer B.
 *
 * @param {Array<object>} [variations]
 * @returns {Array<object>}
 */
export function generateCategory7Cases(variations = CATEGORY_7_VARIATIONS) {
  return variations.map((v) => {
    const expected = {
      label: v.expectedLabel || 'BLOCKED',
    };
    if (v.expectedCode) {
      expected.code = v.expectedCode;
    }
    return {
      id: `KAT-B-07-${v.subId}`,
      category: 7,
      layer: 'B',
      title: v.title,
      params: {
        ...BASE_PARAMS,
        delegate: v.delegate,
        keyNonce: v.keyNonce,
        height: v.height,
      },
      expected,
    };
  });
}
