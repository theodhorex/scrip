// Layer E (Testnet) Generator: Step 5 - Token and Recipient (Categories 1 and 11)
// Conforms strictly to contracts/scrip/README.md specification:
// - Category 1: Recipient allowlist, homoglyphs, subaccounts, implicit 64-hex (~35 cases)
// - Category 11: Token isolation, ft_on_transfer validation, zero amounts, wrong tokens (~25 cases)
// Total cases: 60

export const SEED_CAT1 = 0x20261030_01;
export const SEED_CAT11 = 0x20261030_11;

function mulberry32(seed) {
  let a = seed >>> 0;
  return function () {
    let t = (a += 0x6d2b79f5);
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const DEFAULT_MANDATE_ID = 1;

/**
 * Generates Category 1 cases: recipient address validation and allowlist enforcement.
 * Total: 35 cases.
 */
export function generateCategory1Cases() {
  const cases = [];
  let index = 1;

  const pushCase = ({ title, recipient, expectedLabel, expectedCode, note, extraParams = {} }) => {
    const id = `KAT-E-01-${String(index).padStart(2, '0')}`;
    cases.push({
      id,
      category: 1,
      layer: 'E',
      title,
      params: {
        mandate_id: DEFAULT_MANDATE_ID,
        method: 'request_payment',
        recipient, // target recipient
        args: {
          mandate_id: DEFAULT_MANDATE_ID,
          recipient,
          amount: '100000',
          nonce: index,
        },
        ...extraParams,
      },
      expected: {
        label: expectedLabel,
        code: expectedCode,
      },
    });
    index++;
  };

  // 1-5. Valid vs basic unregistered recipient
  pushCase({
    title: 'Payment to authorized registered recipient (merchant.testnet)',
    recipient: 'merchant.testnet',
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Recipient in mandate allowlist succeeds',
  });
  pushCase({
    title: 'Payment to unauthorized recipient (attacker.testnet)',
    recipient: 'attacker.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Contract Step 3: recipient not in allowlist triggers RECIPIENT_NOT_ALLOWED',
  });
  pushCase({
    title: 'Payment to unauthorized third party (alice.testnet)',
    recipient: 'alice.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Allowlist strictly enforced',
  });
  pushCase({
    title: 'Payment to agent self-address (agent attempting to drain to self)',
    recipient: 'agent.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Agent is not an allowed recipient',
  });
  pushCase({
    title: 'Payment to contract self-address (scrip.testnet)',
    recipient: 'scrip.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Contract itself is not an allowed recipient',
  });

  // 6-12. Lookalike, homoglyph, uppercase, whitespace variations
  pushCase({
    title: 'Recipient with uppercase letters (MERCHANT.testnet)',
    recipient: 'MERCHANT.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'NEAR account IDs are case-sensitive and must be lowercase',
  });
  pushCase({
    title: 'Recipient with mixed-case letters (Merchant.testnet)',
    recipient: 'Merchant.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Case mismatch rejected',
  });
  pushCase({
    title: 'Recipient with leading space ( merchant.testnet)',
    recipient: ' merchant.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Whitespace in recipient address rejected',
  });
  pushCase({
    title: 'Recipient with trailing space (merchant.testnet )',
    recipient: 'merchant.testnet ',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Whitespace in recipient address rejected',
  });
  pushCase({
    title: 'Recipient with tab character in address',
    recipient: 'merchant\t.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Illegal character in account ID',
  });
  pushCase({
    title: 'Recipient with Cyrillic lookalike homoglyph (a -> Cyrillic а)',
    recipient: 'merch\u0430nt.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Homoglyph substitution blocked by exact allowlist string matching',
  });

  // 13-18. Subaccounts and implicit 64-hex addresses
  pushCase({
    title: 'Unauthorized subaccount of merchant (sub.merchant.testnet)',
    recipient: 'sub.merchant.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Subaccounts are separate accounts and not auto-whitelisted',
  });
  pushCase({
    title: 'Unauthorized prefix subaccount (shop.merchant.testnet)',
    recipient: 'shop.merchant.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Subaccount not in allowlist',
  });
  pushCase({
    title: 'Implicit 64-hex account address',
    recipient: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Valid NEAR implicit address format but not in allowlist',
  });
  pushCase({
    title: 'Non-existent account on testnet (nonexistent12345.testnet)',
    recipient: 'nonexistent12345.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Unregistered account not in allowlist',
  });
  pushCase({
    title: 'Empty string recipient ("")',
    recipient: '',
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Empty recipient address rejected',
  });

  // 19-35. Property-based seeded variations for unauthorized recipients (19 cases)
  const rng = mulberry32(SEED_CAT1);
  for (let i = 0; i < 19; i++) {
    const r = rng();
    const subId = Math.floor(rng() * 10000);
    let recipient;

    if (r < 0.3) {
      recipient = `unauth_merchant_${subId}.testnet`;
    } else if (r < 0.6) {
      recipient = `fake_partner_${subId}.testnet`;
    } else {
      recipient = `sub${subId}.merchant.testnet`;
    }

    pushCase({
      title: `Seeded unauthorized recipient variation #${i + 1} (${recipient})`,
      recipient,
      expectedLabel: 'BLOCKED',
      expectedCode: 'RECIPIENT_NOT_ALLOWED',
      note: `Seeded recipient validation vector (seed: ${SEED_CAT1})`,
    });
  }

  return cases;
}

/**
 * Generates Category 11 cases: ft_on_transfer funding, token allowlist, zero amounts.
 * Total: 25 cases.
 */
export function generateCategory11Cases() {
  const cases = [];
  let index = 1;

  const pushCase = ({ title, method = 'ft_on_transfer', caller, args, expectedLabel, expectedCode, note, extraParams = {} }) => {
    const id = `KAT-E-11-${String(index).padStart(2, '0')}`;
    cases.push({
      id,
      category: 11,
      layer: 'E',
      title,
      params: {
        mandate_id: DEFAULT_MANDATE_ID,
        transport: 'rpc',
        method,
        senderId: caller || 'usdc.testnet', // ft_on_transfer caller is the token contract
        args: args || {
          sender_id: 'owner.testnet',
          amount: '1250000',
          msg: JSON.stringify({ mandate_id: 1 }),
        },
        ...extraParams,
      },
      expected: {
        label: expectedLabel,
        code: expectedCode,
      },
    });
    index++;
  };

  // 1-5. Valid vs unauthorized token contract (K-3 token isolation)
  pushCase({
    title: 'ft_on_transfer from legitimate registered token (usdc.testnet)',
    caller: 'usdc.testnet',
    args: { sender_id: 'owner.testnet', amount: '1250000', msg: JSON.stringify({ mandate_id: 1 }) },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Legitimate token funding accepted',
  });
  pushCase({
    title: 'ft_on_transfer from counterfeit token contract (fake_usdc.testnet)',
    caller: 'fake_usdc.testnet',
    args: { sender_id: 'owner.testnet', amount: '1250000', msg: JSON.stringify({ mandate_id: 1 }) },
    expectedLabel: 'BLOCKED',
    expectedCode: 'INVALID_TOKEN',
    note: 'Contract checks token == mandate.token; mismatches refunded in full',
  });
  pushCase({
    title: 'ft_on_transfer from malicious token contract attempting state injection',
    caller: 'malicious_token.testnet',
    args: { sender_id: 'attacker.testnet', amount: '10000000', msg: JSON.stringify({ mandate_id: 1 }) },
    expectedLabel: 'BLOCKED',
    expectedCode: 'INVALID_TOKEN',
    note: 'Token address mismatch triggers full refund',
  });

  // 6-12. Funding amount and target mandate validations
  pushCase({
    title: 'ft_on_transfer with amount zero ("0")',
    caller: 'usdc.testnet',
    args: { sender_id: 'owner.testnet', amount: '0', msg: JSON.stringify({ mandate_id: 1 }) },
    expectedLabel: 'BLOCKED',
    expectedCode: 'ZERO_AMOUNT',
    note: 'Zero amount funding refunded in full',
  });
  pushCase({
    title: 'ft_on_transfer targeting non-existent mandate ID (999999)',
    caller: 'usdc.testnet',
    args: { sender_id: 'owner.testnet', amount: '100000', msg: JSON.stringify({ mandate_id: 999999 }) },
    expectedLabel: 'BLOCKED',
    expectedCode: 'MANDATE_NOT_FOUND',
    note: 'Non-existent mandate refunded in full',
  });
  pushCase({
    title: 'ft_on_transfer targeting revoked mandate',
    caller: 'usdc.testnet',
    args: { sender_id: 'owner.testnet', amount: '100000', msg: JSON.stringify({ mandate_id: 1 }) },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NOT_ACTIVE',
    note: 'Cannot fund revoked mandate; refunded in full',
    extraParams: { mandateRevoked: true },
  });

  // 13-17. Malformed msg payload variations
  pushCase({
    title: 'ft_on_transfer with malformed unparseable JSON msg',
    caller: 'usdc.testnet',
    args: { sender_id: 'owner.testnet', amount: '100000', msg: '{malformed_json}' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'INVALID_MSG',
    note: 'JSON parse failure in ft_on_transfer triggers full refund',
  });
  pushCase({
    title: 'ft_on_transfer with empty msg string',
    caller: 'usdc.testnet',
    args: { sender_id: 'owner.testnet', amount: '100000', msg: '' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'INVALID_MSG',
    note: 'Empty msg string triggers full refund',
  });
  pushCase({
    title: 'ft_on_transfer with missing mandate_id field in msg',
    caller: 'usdc.testnet',
    args: { sender_id: 'owner.testnet', amount: '100000', msg: JSON.stringify({ wrong_key: 1 }) },
    expectedLabel: 'BLOCKED',
    expectedCode: 'INVALID_MSG',
    note: 'Missing mandate_id field triggers full refund',
  });
  pushCase({
    title: 'ft_on_transfer with string mandate_id in msg ({"mandate_id": "abc"})',
    caller: 'usdc.testnet',
    args: { sender_id: 'owner.testnet', amount: '100000', msg: JSON.stringify({ mandate_id: 'abc' }) },
    expectedLabel: 'BLOCKED',
    expectedCode: 'INVALID_MSG',
    note: 'Non-numeric mandate_id triggers full refund',
  });

  // 18-25. Property-based seeded variations for token operations (15 cases)
  const rng = mulberry32(SEED_CAT11);
  for (let i = 0; i < 15; i++) {
    const r = rng();
    let title;
    let expectedCode;
    let caller = 'usdc.testnet';
    let msg = JSON.stringify({ mandate_id: 1 });

    if (r < 0.35) {
      title = `Seeded counterfeit token transfer #${i + 1}`;
      caller = `counterfeit_token_${i}.testnet`;
      expectedCode = 'INVALID_TOKEN';
    } else if (r < 0.7) {
      title = `Seeded transfer to non-existent mandate #${1000 + i}`;
      msg = JSON.stringify({ mandate_id: 9000 + i });
      expectedCode = 'MANDATE_NOT_FOUND';
    } else {
      title = `Seeded malformed funding msg payload #${i + 1}`;
      msg = `corrupt_msg_payload_${i}`;
      expectedCode = 'INVALID_MSG';
    }

    pushCase({
      title,
      caller,
      args: { sender_id: 'owner.testnet', amount: '100000', msg },
      expectedLabel: 'BLOCKED',
      expectedCode,
      note: `Seeded token transfer vector (seed: ${SEED_CAT11})`,
    });
  }

  return cases;
}

/**
 * Combines Step 5 cases (Category 1 & Category 11).
 * Total: 60 cases.
 */
export function generateTokenRecipientCases() {
  const cat1 = generateCategory1Cases();
  const cat11 = generateCategory11Cases();
  return [...cat1, ...cat11];
}
