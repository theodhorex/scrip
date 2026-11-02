// Parametric generators for C2 Attack Catalog Extension (Layer C: Offline Client & Parser)
// Conforms to .agy/BRIEF_BACKEND.md, web/docs/RENCANA_ATTACK_2500.md, and client/src/ specifications.
// Expected outcomes derived strictly from specifications without modifying production code.

import { createHash } from 'node:crypto';
import * as nearApi from '../../../client/node_modules/near-api-js/lib/index.js';
import { buildRequestPayment } from '../../../client/src/delegate.mjs';

const { KeyPair } = nearApi;

const TGAS = 10n ** 12n;
const U64_MAX = (1n << 64n) - 1n;
const U64_MAX_PLUS_1 = 1n << 64n;
const U128_MAX = (1n << 128n) - 1n;
const U128_MAX_PLUS_1 = (1n << 128n).toString();

const BASE_PARAMS = {
  mandateId: 1n,
  recipient: 'bob.near',
  amount: '1000',
  nonce: 1n,
  expiresAtMs: 1700000000000n,
  contractId: 'scrip.testnet',
};

// =============================================================================
// CATEGORY 1: Recipient Address Attacks (Client Parser) - 26 Cases
// =============================================================================
export const CAT1_VARIATIONS = [
  { subId: '01', title: 'Homoglyph Cyrillic o in recipient', recipient: 'b\u043eb.near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '02', title: 'Homoglyph Cyrillic a in recipient', recipient: '\u0430lice.near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '03', title: 'Homoglyph Greek alpha in recipient', recipient: '\u03b1lice.near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '04', title: 'Homoglyph Fullwidth Latin a in recipient', recipient: '\uff41lice.near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '05', title: 'Uppercase all-caps recipient', recipient: 'ALICE.TESTNET', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '06', title: 'Mixed-case recipient address', recipient: 'Alice.Near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '07', title: 'Single uppercase letter at end', recipient: 'alice.neaR', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '08', title: 'Space in middle of recipient', recipient: 'alice bob.near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '09', title: 'Tab control character in recipient', recipient: 'alice\t.near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '10', title: 'Newline character in recipient', recipient: 'alice\n.near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '11', title: 'Carriage return character in recipient', recipient: 'alice\r.near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '12', title: 'Null byte in middle of recipient', recipient: 'alice\x00.near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '13', title: 'Leading null byte in recipient', recipient: '\x00alice.near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '14', title: 'Trailing null byte in recipient', recipient: 'alice.near\x00', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '15', title: 'Recipient length exactly 63 bytes (valid max-1)', recipient: 'a'.repeat(63), expectedLabel: 'INERT', expectedCode: null },
  { subId: '16', title: 'Recipient length exactly 64 bytes (valid boundary)', recipient: 'a'.repeat(64), expectedLabel: 'INERT', expectedCode: null },
  { subId: '17', title: 'Recipient length 65 bytes (exceeds max 64 by 1)', recipient: 'a'.repeat(65), expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '18', title: 'Recipient length 2000 bytes (DoS buffer payload)', recipient: 'a'.repeat(2000), expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '19', title: 'Multi-level nested subaccount (valid dots)', recipient: 'a.b.c.d.e.f.near', expectedLabel: 'INERT', expectedCode: null },
  { subId: '20', title: '64-hex implicit account ID (valid length & charset)', recipient: '0123456789abcdef'.repeat(4), expectedLabel: 'INERT', expectedCode: null },
  { subId: '21', title: 'Invalid punctuation @ in recipient', recipient: 'alice@near', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '22', title: 'Slash directory traversal attempt in recipient', recipient: 'alice/../../bob', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '23', title: 'Recipient identical to contract account itself', recipient: 'scrip.testnet', expectedLabel: 'INERT', expectedCode: null },
  { subId: '24', title: 'Recipient identical to agent account itself', recipient: 'agent.testnet', expectedLabel: 'INERT', expectedCode: null },
  { subId: '25', title: 'Recipient as non-string Number type', recipient: 123456, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '26', title: 'Recipient as boolean false type', recipient: false, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
];

export function generateC2Category1Cases(variations = CAT1_VARIATIONS) {
  return variations.map((v) => {
    const expected = { label: v.expectedLabel };
    if (v.expectedCode) expected.code = v.expectedCode;
    return {
      id: `KAT-C2-01-${v.subId}`,
      category: 1,
      layer: 'C',
      title: v.title,
      params: {
        ...BASE_PARAMS,
        recipient: v.recipient,
      },
      expected,
    };
  });
}

// =============================================================================
// CATEGORY 2: Amount Attacks (Client Parser) - 26 Cases
// =============================================================================
export const CAT2_VARIATIONS = [
  { subId: '01', title: 'Zero amount transfer (canonical decimal 0)', amount: '0', expectedLabel: 'INERT', expectedCode: null },
  { subId: '02', title: 'One yocto unit transfer (minimum positive)', amount: '1', expectedLabel: 'INERT', expectedCode: null },
  { subId: '03', title: 'Amount u64::MAX as decimal string', amount: U64_MAX.toString(), expectedLabel: 'INERT', expectedCode: null },
  { subId: '04', title: 'Amount u64::MAX + 1 as decimal string', amount: (U64_MAX + 1n).toString(), expectedLabel: 'INERT', expectedCode: null },
  { subId: '05', title: 'Amount u128::MAX boundary decimal string', amount: U128_MAX.toString(), expectedLabel: 'INERT', expectedCode: null },
  { subId: '06', title: 'Amount u128::MAX - 1 decimal string', amount: (U128_MAX - 1n).toString(), expectedLabel: 'INERT', expectedCode: null },
  { subId: '07', title: 'Amount u128::MAX + 1 (overflow 128 bits)', amount: U128_MAX_PLUS_1, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '08', title: 'Amount 2^256 integer overflow attempt', amount: (1n << 256n).toString(), expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '09', title: 'Negative amount -1', amount: '-1', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '10', title: 'Signed negative zero -0', amount: '-0', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '11', title: 'Large negative amount -10^24', amount: '-1000000000000000000000000', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '12', title: 'Decimal fraction 100.5', amount: '100.5', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '13', title: 'Decimal fraction with leading zero 0.000001', amount: '0.000001', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '14', title: 'Decimal with trailing dot 100.', amount: '100.', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '15', title: 'Decimal starting with dot .5', amount: '.5', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '16', title: 'Scientific notation lowercase 1e18', amount: '1e18', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '17', title: 'Scientific notation uppercase with sign 2E+6', amount: '2E+6', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '18', title: 'Scientific notation negative exponent 1e-18', amount: '1e-18', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '19', title: 'Hexadecimal prefix 0x10', amount: '0x10', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '20', title: 'Hexadecimal literal 0xdeadbeef', amount: '0xdeadbeef', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '21', title: 'Leading space in amount " 1000"', amount: ' 1000', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '22', title: 'Trailing space in amount "1000 "', amount: '1000 ', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '23', title: 'Internal space separator "1 000"', amount: '1 000', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '24', title: 'Non-canonical leading zero "007"', amount: '007', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '25', title: 'Non-numeric alphabetic amount "one_million"', amount: 'one_million', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '26', title: 'Amount passed as JS Number literal 1000', amount: 1000, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
];

export function generateC2Category2Cases(variations = CAT2_VARIATIONS) {
  return variations.map((v) => {
    const expected = { label: v.expectedLabel };
    if (v.expectedCode) expected.code = v.expectedCode;
    return {
      id: `KAT-C2-02-${v.subId}`,
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

// =============================================================================
// CATEGORY 4: Client Approvals and Nonce (Client Intent Hash) - 26 Cases
// =============================================================================
export const CAT4_VARIATIONS = [
  { subId: '01', title: 'Nonce zero as BigInt (0n)', patch: { nonce: 0n }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '02', title: 'Nonce one as BigInt (1n)', patch: { nonce: 1n }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '03', title: 'Nonce Number.MAX_SAFE_INTEGER (2^53 - 1)', patch: { nonce: Number.MAX_SAFE_INTEGER }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '04', title: 'Nonce 2^53 as Number (unsafe integer)', patch: { nonce: Number.MAX_SAFE_INTEGER + 1 }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '05', title: 'Nonce 2^53 as BigInt (valid u64 BigInt)', patch: { nonce: BigInt(Number.MAX_SAFE_INTEGER + 1) }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '06', title: 'Nonce u64::MAX as BigInt (2^64 - 1)', patch: { nonce: U64_MAX }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '07', title: 'Nonce u64::MAX + 1 as BigInt (2^64)', patch: { nonce: U64_MAX_PLUS_1 }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '08', title: 'Nonce negative BigInt (-1n)', patch: { nonce: -1n }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '09', title: 'Nonce negative Number (-10)', patch: { nonce: -10 }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '10', title: 'Nonce float Number (1.25)', patch: { nonce: 1.25 }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '11', title: 'Nonce string ("1")', patch: { nonce: '1' }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '12', title: 'Nonce boolean true', patch: { nonce: true }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '13', title: 'Expiration timestamp zero (0n)', patch: { expiresAtMs: 0n }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '14', title: 'Expiration timestamp u64::MAX (2^64 - 1)', patch: { expiresAtMs: U64_MAX }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '15', title: 'Expiration timestamp u64::MAX + 1 (2^64)', patch: { expiresAtMs: U64_MAX_PLUS_1 }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '16', title: 'Expiration timestamp negative BigInt (-1n)', patch: { expiresAtMs: -1n }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '17', title: 'Expiration timestamp float Number (1700000000000.5)', patch: { expiresAtMs: 1700000000000.5 }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '18', title: 'Expiration timestamp string ("1700000000000")', patch: { expiresAtMs: '1700000000000' }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '19', title: 'Mandate ID zero (0n)', patch: { mandateId: 0n }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '20', title: 'Mandate ID u64::MAX (2^64 - 1)', patch: { mandateId: U64_MAX }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '21', title: 'Mandate ID u64::MAX + 1 (2^64)', patch: { mandateId: U64_MAX_PLUS_1 }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '22', title: 'Mandate ID negative BigInt (-1n)', patch: { mandateId: -1n }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '23', title: 'Mandate ID float Number (10.5)', patch: { mandateId: 10.5 }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '24', title: 'Mandate ID string ("1")', patch: { mandateId: '1' }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '25', title: 'Mandate ID null value', patch: { mandateId: null }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '26', title: 'Single-field alteration: nonce shifted by 1 produces valid intent', patch: { nonce: 2n }, expectedLabel: 'INERT', expectedCode: null },
];

export function generateC2Category4Cases(variations = CAT4_VARIATIONS) {
  return variations.map((v) => {
    const expected = { label: v.expectedLabel };
    if (v.expectedCode) expected.code = v.expectedCode;
    return {
      id: `KAT-C2-04-${v.subId}`,
      category: 4,
      layer: 'C',
      title: v.title,
      params: {
        ...BASE_PARAMS,
        ...v.patch,
      },
      expected,
    };
  });
}

const VALID_SIGN_PARAMS = {
  agentId: 'agent.testnet',
  contractId: 'scrip.testnet',
  nonce: 1n,
  maxBlockHeight: 1000n,
};

// =============================================================================
// CATEGORY 6: Delegate Actions and Keys (Client NEP-366) - 32 Cases
// =============================================================================
export const CAT6_VARIATIONS = [
  // Bit-flips at various positions across Ed25519 signature
  { subId: '01', title: 'Ed25519 signature bit-flip byte 1 bit 0', target: 'tamperedSignatureCustom', params: { bitFlipByte: 1, bitFlipBit: 0 }, expectedLabel: 'BLOCKED', expectedCode: 'SignatureVerificationError' },
  { subId: '02', title: 'Ed25519 signature bit-flip byte 7 bit 3', target: 'tamperedSignatureCustom', params: { bitFlipByte: 7, bitFlipBit: 3 }, expectedLabel: 'BLOCKED', expectedCode: 'SignatureVerificationError' },
  { subId: '03', title: 'Ed25519 signature bit-flip byte 15 bit 7', target: 'tamperedSignatureCustom', params: { bitFlipByte: 15, bitFlipBit: 7 }, expectedLabel: 'BLOCKED', expectedCode: 'SignatureVerificationError' },
  { subId: '04', title: 'Ed25519 signature bit-flip byte 31 bit 1', target: 'tamperedSignatureCustom', params: { bitFlipByte: 31, bitFlipBit: 1 }, expectedLabel: 'BLOCKED', expectedCode: 'SignatureVerificationError' },
  { subId: '05', title: 'Ed25519 signature bit-flip byte 47 bit 4', target: 'tamperedSignatureCustom', params: { bitFlipByte: 47, bitFlipBit: 4 }, expectedLabel: 'BLOCKED', expectedCode: 'SignatureVerificationError' },
  { subId: '06', title: 'Ed25519 signature bit-flip byte 63 bit 0', target: 'tamperedSignatureCustom', params: { bitFlipByte: 63, bitFlipBit: 0 }, expectedLabel: 'BLOCKED', expectedCode: 'SignatureVerificationError' },
  { subId: '07', title: 'Ed25519 signature bit-flip byte 63 bit 7 (last bit)', target: 'tamperedSignatureCustom', params: { bitFlipByte: 63, bitFlipBit: 7 }, expectedLabel: 'BLOCKED', expectedCode: 'SignatureVerificationError' },

  // Public key mismatch and receiver tampered
  { subId: '08', title: 'Signer public key mismatched with verifying key', target: 'tamperedSignatureCustom', params: { tamperPublicKey: true }, expectedLabel: 'BLOCKED', expectedCode: 'SignatureVerificationError' },
  { subId: '09', title: 'DelegateAction receiver tampered in digest', target: 'tamperedSignatureCustom', params: { tamperReceiver: true }, expectedLabel: 'BLOCKED', expectedCode: 'SignatureVerificationError' },

  // signDelegate parameter validations
  { subId: '10', title: 'signDelegate: agentId empty string', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, agentId: '' }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '11', title: 'signDelegate: agentId length 65 bytes', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, agentId: 'a'.repeat(65) }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '12', title: 'signDelegate: agentId non-string Number', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, agentId: 123 }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '13', title: 'signDelegate: contractId empty string', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, contractId: '' }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '14', title: 'signDelegate: contractId length 65 bytes', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, contractId: 'c'.repeat(65) }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '15', title: 'signDelegate: contractId non-string boolean', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, contractId: true }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '16', title: 'signDelegate: nonce boundary 0n', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, nonce: 0n }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '17', title: 'signDelegate: nonce boundary u64::MAX', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, nonce: U64_MAX }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '18', title: 'signDelegate: nonce exceeds u64::MAX + 1', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, nonce: U64_MAX_PLUS_1 }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '19', title: 'signDelegate: nonce negative BigInt (-1n)', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, nonce: -1n }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '20', title: 'signDelegate: maxBlockHeight boundary 0n', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, maxBlockHeight: 0n }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '21', title: 'signDelegate: maxBlockHeight boundary u64::MAX', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, maxBlockHeight: U64_MAX }, expectedLabel: 'INERT', expectedCode: null },
  { subId: '22', title: 'signDelegate: maxBlockHeight exceeds u64::MAX + 1', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, maxBlockHeight: U64_MAX_PLUS_1 }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '23', title: 'signDelegate: maxBlockHeight negative BigInt (-1n)', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, maxBlockHeight: -1n }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '24', title: 'signDelegate: keyPair null value', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, keyPair: null }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '25', title: 'signDelegate: keyPair empty object without getPublicKey', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, keyPair: {} }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '26', title: 'signDelegate: action null value', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, action: null }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '27', title: 'signDelegate: action string literal', target: 'signDelegate', params: { ...VALID_SIGN_PARAMS, action: 'request_payment' }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },

  // buildRequestPayment gas validations
  { subId: '28', title: 'buildRequestPayment: prepaid gas 0n (refused)', target: 'buildRequestPayment', params: { contractId: 'scrip.testnet', mandateId: 1n, recipient: 'bob.near', amount: '1000', nonce: 1n, gas: 0n }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '29', title: 'buildRequestPayment: prepaid gas 59 Tgas (below 60 Tgas)', target: 'buildRequestPayment', params: { contractId: 'scrip.testnet', mandateId: 1n, recipient: 'bob.near', amount: '1000', nonce: 1n, gas: 59n * TGAS }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '30', title: 'buildRequestPayment: prepaid gas u64::MAX + 1n', target: 'buildRequestPayment', params: { contractId: 'scrip.testnet', mandateId: 1n, recipient: 'bob.near', amount: '1000', nonce: 1n, gas: U64_MAX_PLUS_1 }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '31', title: 'buildRequestPayment: prepaid gas as Number instead of BigInt', target: 'buildRequestPayment', params: { contractId: 'scrip.testnet', mandateId: 1n, recipient: 'bob.near', amount: '1000', nonce: 1n, gas: 100000000000000 }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '32', title: 'buildRequestPayment: prepaid gas exactly 60 Tgas (MIN_GAS boundary)', target: 'buildRequestPayment', params: { contractId: 'scrip.testnet', mandateId: 1n, recipient: 'bob.near', amount: '1000', nonce: 1n, gas: 60n * TGAS }, expectedLabel: 'INERT', expectedCode: null },
];

export function generateC2Category6Cases(variations = CAT6_VARIATIONS) {
  return variations.map((v) => {
    const expected = { label: v.expectedLabel };
    if (v.expectedCode) expected.code = v.expectedCode;
    return {
      id: `KAT-C2-06-${v.subId}`,
      category: 6,
      layer: 'C',
      title: v.title,
      params: {
        target: v.target,
        params: v.params,
        ...v.params,
      },
      expected,
    };
  });
}

// =============================================================================
// CATEGORY 8: Format and Parsing (Client Responses & Payment Signatures) - 30 Cases
// =============================================================================
export const CAT8_VARIATIONS = [
  // parsePaymentResponse variations
  { subId: '01', title: 'Base64 with corrupted special characters', target: 'parsePaymentResponse', input: 'bad!!!base64===', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '02', title: 'Base64 with invalid padding (3 equal signs)', target: 'parsePaymentResponse', input: 'abc===', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '03', title: 'Base64 with internal equal sign delimiter', target: 'parsePaymentResponse', input: 'ab=c', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '04', title: 'Base64url without padding containing valid JSON', target: 'parsePaymentResponse', input: Buffer.from('{"ok":true,"txHash":"tx_url_123"}').toString('base64url'), expectedLabel: 'INERT', expectedCode: null },
  { subId: '05', title: 'Deeply nested JSON object (depth 100)', target: 'parsePaymentResponse', input: '{"ok":true,"wrap":'.repeat(100) + '{"status":200}' + '}'.repeat(100), expectedLabel: 'INERT', expectedCode: null },
  { subId: '06', title: 'Deeply nested JSON array (depth 100)', target: 'parsePaymentResponse', input: '['.repeat(100) + '1' + ']'.repeat(100), expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '07', title: 'Duplicate JSON keys in response', target: 'parsePaymentResponse', input: '{"ok":false,"ok":true,"tx_hash":"tx_dup_key_1"}', expectedLabel: 'INERT', expectedCode: null },
  { subId: '08', title: 'Prototype pollution attempt via __proto__ property', target: 'parsePaymentResponse', input: '{"__proto__":{"admin":true},"ok":true,"tx_hash":"tx_proto"}', expectedLabel: 'INERT', expectedCode: null },
  { subId: '09', title: 'Constructor prototype pollution attempt', target: 'parsePaymentResponse', input: '{"constructor":{"prototype":{"admin":true}},"ok":true,"tx_hash":"tx_const"}', expectedLabel: 'INERT', expectedCode: null },
  { subId: '10', title: 'Unicode zero-width space in tx_hash', target: 'parsePaymentResponse', input: '{"ok":true,"tx_hash":"tx_\u200B123"}', expectedLabel: 'INERT', expectedCode: null },
  { subId: '11', title: 'Unicode emoji in tx_hash field', target: 'parsePaymentResponse', input: '{"ok":true,"tx_hash":"tx_\uD83D\uDD12_lock"}', expectedLabel: 'INERT', expectedCode: null },
  { subId: '12', title: 'Null byte character in tx_hash', target: 'parsePaymentResponse', input: '{"ok":true,"tx_hash":"tx_\u0000_null"}', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '13', title: 'Raw boolean true response input', target: 'parsePaymentResponse', input: true, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '14', title: 'Raw integer HTTP status 404 response input', target: 'parsePaymentResponse', input: 404, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '15', title: 'Raw array [1,2,3] response input', target: 'parsePaymentResponse', input: [1, 2, 3], expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '16', title: 'Null response input', target: 'parsePaymentResponse', input: null, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '17', title: 'Undefined response input', target: 'parsePaymentResponse', input: undefined, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '18', title: 'Empty string response input', target: 'parsePaymentResponse', input: '', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '19', title: 'Unclosed malformed JSON string', target: 'parsePaymentResponse', input: '{"ok":true,"tx_hash":"tx_incomplete', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },

  // relayBodyFor variations
  { subId: '20', title: 'relayBodyFor: empty string base64 argument', target: 'relayBodyFor', input: '', expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '21', title: 'relayBodyFor: non-canonical base64 length (length % 4 !== 0)', target: 'relayBodyFor', input: 'AAAAA', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '22', title: 'relayBodyFor: base64 containing illegal whitespace', target: 'relayBodyFor', input: 'AAAA BBBB', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },

  // parseRequestResult variations
  { subId: '23', title: 'parseRequestResult: plain non-JSON text', target: 'parseRequestResult', input: 'payment settlement pending confirmation', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '24', title: 'parseRequestResult: multiple variants in single body', target: 'parseRequestResult', input: '{"Reserved":{"request_id":"1"},"Settled":{"request_id":"1"}}', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '25', title: 'parseRequestResult: unknown result variant', target: 'parseRequestResult', input: '{"UnknownVariant":{"request_id":"1"}}', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '26', title: 'parseRequestResult: unknown reject code in Rejected variant', target: 'parseRequestResult', input: '{"Rejected":{"code":"CUSTOM_UNKNOWN_REJECT"}}', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '27', title: 'parseRequestResult: negative request_id in Reserved', target: 'parseRequestResult', input: '{"Reserved":{"request_id":"-5"}}', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '28', title: 'parseRequestResult: request_id out of u64 range (2^64)', target: 'parseRequestResult', input: '{"Reserved":{"request_id":"18446744073709551616"}}', expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },
  { subId: '29', title: 'parseRequestResult: non-string number input', target: 'parseRequestResult', input: 12345, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '30', title: 'parseRequestResult: valid base64 encoded Reserved result', target: 'parseRequestResult', input: Buffer.from('{"Reserved":{"request_id":"42"}}').toString('base64'), expectedLabel: 'INERT', expectedCode: null },
];

export function generateC2Category8Cases(variations = CAT8_VARIATIONS) {
  return variations.map((v) => {
    const expected = { label: v.expectedLabel };
    if (v.expectedCode) expected.code = v.expectedCode;
    return {
      id: `KAT-C2-08-${v.subId}`,
      category: 8,
      layer: 'C',
      title: v.title,
      params: {
        target: v.target,
        input: v.input,
      },
      expected,
    };
  });
}

// =============================================================================
// CATEGORY 12: Absurd and Out of Scope Attacks - 26 Cases
// =============================================================================
export const CAT12_VARIATIONS = [
  // Out of scope threat model scenarios (acknowledged protocol boundaries)
  { subId: '01', title: 'Byzantine RPC node lies about transaction finality', isOutOfScope: true, reason: 'Client trusts RPC provider; dishonest RPC is outside client defense scope', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '02', title: 'Owner full-access master private key leaked', isOutOfScope: true, reason: 'Protocol protects scoped agent function-call keys; owner key breach is out of scope', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '03', title: 'Malicious FT token contract returns falsified balance', isOutOfScope: true, reason: 'External token contract logic integrity is outside client scope', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '04', title: 'Host operating system clock jumped backward by 100 years', isOutOfScope: true, reason: 'Expiration validation relies on monotonic host system clock', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '05', title: 'Host runtime out-of-memory (OOM) abort', isOutOfScope: true, reason: 'Process termination due to host memory limits is not handled by client SDK', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '06', title: 'Operating system CSPRNG entropy exhaustion failure', isOutOfScope: true, reason: 'Cryptographic entropy source is an operating system guarantee', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '07', title: 'Multi-gigabyte payment payload HTTP stream injection', isOutOfScope: true, reason: 'Network buffer boundaries belong to reverse proxy / gateway layer', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '08', title: 'Underlying blockchain consensus reorganization / hard fork', isOutOfScope: true, reason: 'Deep L1 reorganizations are external to client SDK', expectedLabel: 'OUT_OF_SCOPE' },

  // Absurd inputs to intentHash (wrong types and non-objects)
  { subId: '09', title: 'Symbol passed as mandateId to intentHash', target: 'intentHash', input: { ...BASE_PARAMS, mandateId: Symbol('mandate') }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '10', title: 'Function passed as recipient to intentHash', target: 'intentHash', input: { ...BASE_PARAMS, recipient: () => 'bob.near' }, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '11', title: 'Array passed as root input to intentHash', target: 'intentHash', input: [BASE_PARAMS], expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '12', title: 'Null passed as root input to intentHash', target: 'intentHash', input: null, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '13', title: 'Number primitive passed as root input to intentHash', target: 'intentHash', input: 42, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '14', title: 'Undefined passed as root input to intentHash', target: 'intentHash', input: undefined, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },

  // Absurd inputs to buildPaymentSignature
  { subId: '15', title: 'Circular reference in requirements extra object', target: 'circularReference', input: (() => { const c = {}; c.self = c; return c; })(), expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '16', title: 'Symbol passed as requirements object', target: 'buildPaymentSignature', requirements: Symbol('req'), options: {}, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '17', title: 'Function passed as requirements object', target: 'buildPaymentSignature', requirements: () => {}, options: {}, expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
  { subId: '18', title: 'Regex catastrophic backtracking attempt on recipient', target: 'intentHash', input: { ...BASE_PARAMS, recipient: 'a'.repeat(30) + '!' }, expectedLabel: 'BLOCKED', expectedCode: 'RangeError' },

  // Additional out of scope threat model scenarios
  { subId: '19', title: 'Global prototype override on Object.prototype.toString', isOutOfScope: true, reason: 'Host environment prototype poisoning prior to SDK invocation is out of scope', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '20', title: 'Man-in-the-middle TLS termination on facilitator endpoint', isOutOfScope: true, reason: 'Transport layer encryption integrity is guaranteed by HTTPS infrastructure', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '21', title: 'Cryptographic zero-knowledge proof forgery on L1', isOutOfScope: true, reason: 'L1 cryptographic assumptions are external to client SDK', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '22', title: 'Hardware cosmic-ray bit-flip in RAM during execution', isOutOfScope: true, reason: 'Hardware fault tolerance is outside software protocol threat model', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '23', title: 'Side-channel microarchitectural cache-timing attack', isOutOfScope: true, reason: 'Standard Node crypto SHA-256 implementation is trusted as primitive', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '24', title: 'Relayer colluding with malicious block validator', isOutOfScope: true, reason: 'Validator collusion is outside client application layer guarantees', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '25', title: 'Contract state deleted via NEAR governance upgrade', isOutOfScope: true, reason: 'Network-wide governance interventions are outside client protocol guarantees', expectedLabel: 'OUT_OF_SCOPE' },
  { subId: '26', title: 'Non-existent property getter throwing custom error', target: 'intentHash', input: Object.defineProperty({}, 'mandateId', { get() { throw new TypeError('Property access denied'); } }), expectedLabel: 'BLOCKED', expectedCode: 'TypeError' },
];

export function generateC2Category12Cases(variations = CAT12_VARIATIONS) {
  return variations.map((v) => {
    const expected = { label: v.expectedLabel };
    if (v.expectedCode) expected.code = v.expectedCode;
    return {
      id: `KAT-C2-12-${v.subId}`,
      category: 12,
      layer: 'C',
      title: v.title,
      params: {
        isOutOfScope: v.isOutOfScope,
        reason: v.reason,
        target: v.target,
        input: v.input,
        requirements: v.requirements,
        options: v.options,
      },
      expected,
    };
  });
}

/**
 * Returns all C2 extra cases.
 * Total: 26 + 26 + 26 + 32 + 30 + 26 = 166 cases.
 *
 * @returns {Array<object>}
 */
export function generateC2Cases() {
  return [
    ...generateC2Category1Cases(),
    ...generateC2Category2Cases(),
    ...generateC2Category4Cases(),
    ...generateC2Category6Cases(),
    ...generateC2Category8Cases(),
    ...generateC2Category12Cases(),
  ];
}
