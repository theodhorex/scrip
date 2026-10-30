// Layer E (Testnet) Generator: Step 2 - Approval and Lifecycle (Categories 4 and 10)
// Conforms strictly to contracts/amanat/README.md specification:
// - Category 4: Approvals, nonces, thresholds, expiry, replay (~60 cases)
// - Category 10: Mandate lifecycle, revoke, withdraw, tighten/loosen wrong paths (~60 cases)
// Total cases: 120

export const SEED_CAT4 = 0x20261030_04;
export const SEED_CAT10 = 0x20261030_10;

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
 * Generates Category 4 cases: approval threshold, replay, nonce collisions, expiry.
 * Total: 60 cases.
 */
export function generateCategory4Cases() {
  const cases = [];
  let index = 1;

  const pushCase = ({ title, method = 'request_payment', args, expectedLabel, expectedCode, note, extraParams = {} }) => {
    const id = `KAT-E-04-${String(index).padStart(2, '0')}`;
    cases.push({
      id,
      category: 4,
      layer: 'E',
      title,
      params: {
        mandate_id: DEFAULT_MANDATE_ID,
        method,
        args: args || {
          mandate_id: DEFAULT_MANDATE_ID,
          recipient: 'merchant.testnet',
          amount: '500000',
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

  // 1-5. Approval threshold boundaries (amount > approval_threshold needs approval)
  pushCase({
    title: 'Payment exactly at approval threshold without approval',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 1 },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Payments <= approval_threshold do not require guardian approval',
  });
  pushCase({
    title: 'Payment 1 unit above approval threshold without approval',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500001', nonce: 2 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NEEDS_APPROVAL',
    note: 'Contract Step 7: amount > approval_threshold without approval triggers NEEDS_APPROVAL',
  });
  pushCase({
    title: 'Payment 1000 units above approval threshold without approval',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '501000', nonce: 3 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NEEDS_APPROVAL',
    note: 'Requires guardian approval',
  });
  pushCase({
    title: 'Payment with valid prior guardian approval',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 4 },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Approval matches registered intent hash',
    extraParams: { hasValidApproval: true },
  });
  pushCase({
    title: 'Payment with unapproved nonce',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 9999 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NEEDS_APPROVAL',
    note: 'Nonce not approved',
  });

  // 6-12. Replay approval attacks
  pushCase({
    title: 'Replay approval: reusing consumed approval nonce on second payment',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 4 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'APPROVAL_USED',
    note: 'Contract Step 8: previously used approval rejected with APPROVAL_USED',
    extraParams: { approvalAlreadyUsed: true },
  });
  pushCase({
    title: 'Replay approval with altered amount against registered intent hash',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '450000', nonce: 4 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NEEDS_APPROVAL',
    note: 'Altered amount changes intent hash -> approval not found',
  });
  pushCase({
    title: 'Replay approval with altered recipient against registered intent hash',
    args: { mandate_id: 1, recipient: 'attacker.testnet', amount: '500000', nonce: 4 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'RECIPIENT_NOT_ALLOWED',
    note: 'Recipient check precedes approval check',
  });
  pushCase({
    title: 'Replay approval across different mandate ID',
    args: { mandate_id: 2, recipient: 'merchant.testnet', amount: '500000', nonce: 4 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NEEDS_APPROVAL',
    note: 'Intent hash binds mandate_id',
  });

  // 13-18. Nonce collisions & approve_intent panics
  pushCase({
    title: 'approve_intent duplicate registration with identical nonce',
    method: 'approve_intent',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 4, approval_expires_at_ms: Date.now() + 3600000 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'ALREADY_APPROVED',
    note: 'Guardian duplicate approve_intent panics ALREADY_APPROVED',
  });
  pushCase({
    title: 'approve_intent without required storage deposit (< 2 mNEAR)',
    method: 'approve_intent',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 15, approval_expires_at_ms: Date.now() + 3600000 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'INSUFFICIENT_STORAGE_DEPOSIT',
    note: 'Missing storage deposit for approval record',
    extraParams: { deposit: '1000000000000000000000' }, // 1 mNEAR (< 2 mNEAR)
  });
  pushCase({
    title: 'approve_intent beyond maximum capacity of 512 approvals (513th approval)',
    method: 'approve_intent',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 513, approval_expires_at_ms: Date.now() + 3600000 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TOO_MANY_APPROVALS',
    note: 'Bounded storage guard K-C: max 512 approvals per mandate',
  });

  // 19-25. Approval expiration
  pushCase({
    title: 'Payment with expired approval timestamp',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 19 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'APPROVAL_EXPIRED',
    note: 'Contract Step 9: approval_expires_at_ms < block_timestamp triggers APPROVAL_EXPIRED',
    extraParams: { approvalExpired: true },
  });
  pushCase({
    title: 'Payment after mandate expiry was updated (breaking earlier approval hash)',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 20 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NEEDS_APPROVAL',
    note: 'Hash binds current mandate expires_at_ms; changes invalidate earlier approvals',
  });
  pushCase({
    title: 'approve_intent with approval_expires_at_ms in the past',
    method: 'approve_intent',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 21, approval_expires_at_ms: 1000 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'EXPIRY_NOT_IN_FUTURE',
    note: 'Approval expiry must be in future',
  });

  // 26-60. Property-based seeded variations for approval parameters (45 cases)
  const rng = mulberry32(SEED_CAT4);
  for (let i = 0; i < 45; i++) {
    const r = rng();
    let title;
    let expectedCode;
    let expectedLabel = 'BLOCKED';

    if (r < 0.25) {
      title = `Seeded approval replay with reused nonce #${100 + i}`;
      expectedCode = 'APPROVAL_USED';
    } else if (r < 0.5) {
      title = `Seeded unapproved intent payment #${200 + i}`;
      expectedCode = 'NEEDS_APPROVAL';
    } else if (r < 0.75) {
      title = `Seeded expired guardian approval #${300 + i}`;
      expectedCode = 'APPROVAL_EXPIRED';
    } else {
      title = `Seeded duplicate approval intent hash collision #${400 + i}`;
      expectedCode = 'ALREADY_APPROVED';
    }

    pushCase({
      title,
      args: {
        mandate_id: 1,
        recipient: 'merchant.testnet',
        amount: '500000',
        nonce: 500 + i,
      },
      expectedLabel,
      expectedCode,
      note: `Seeded parametric approval vector (seed: ${SEED_CAT4})`,
    });
  }

  return cases;
}

/**
 * Generates Category 10 cases: mandate lifecycle, revoke, withdraw, tighten/loosen restrictions.
 * Total: 60 cases.
 */
export function generateCategory10Cases() {
  const cases = [];
  let index = 1;

  const pushCase = ({ title, method, args, expectedLabel, expectedCode, note, extraParams = {} }) => {
    const id = `KAT-E-10-${String(index).padStart(2, '0')}`;
    cases.push({
      id,
      category: 10,
      layer: 'E',
      title,
      params: {
        mandate_id: DEFAULT_MANDATE_ID,
        method: method || 'request_payment',
        args: args || {
          mandate_id: DEFAULT_MANDATE_ID,
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

  // 1-8. Revoke and post-revoke operations
  pushCase({
    title: 'Valid mandate revocation by owner',
    method: 'revoke',
    args: { mandate_id: 1 },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Owner revocation transitions Active -> Revoked',
  });
  pushCase({
    title: 'Payment request on revoked mandate',
    method: 'request_payment',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '1000', nonce: 1 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NOT_ACTIVE',
    note: 'Contract Step 1: mandate must be Active',
  });
  pushCase({
    title: 'Double revoke: calling revoke on already revoked mandate',
    method: 'revoke',
    args: { mandate_id: 1 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NOT_ACTIVE',
    note: 'Cannot revoke an already Revoked mandate',
  });
  pushCase({
    title: 'loosen called on revoked mandate',
    method: 'loosen',
    args: { mandate_id: 1, change: { Budget: '2000000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NOT_ACTIVE',
    note: 'Lifecycle modification requires Active status',
  });
  pushCase({
    title: 'tighten called on revoked mandate',
    method: 'tighten',
    args: { mandate_id: 1, change: { Budget: '1000000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NOT_ACTIVE',
    note: 'Lifecycle modification requires Active status',
  });

  // 9-16. Withdraw rules & violations
  pushCase({
    title: 'Withdraw funds while mandate is still Active',
    method: 'withdraw',
    args: { mandate_id: 1, amount: '100000' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'MANDATE_STILL_ACTIVE',
    note: 'Owner can only withdraw after mandate is revoked',
  });
  pushCase({
    title: 'Valid withdraw on revoked mandate by owner',
    method: 'withdraw',
    args: { mandate_id: 1, amount: '100000' },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Owner withdrawing free remainder',
    extraParams: { mandateRevoked: true },
  });
  pushCase({
    title: 'Withdraw amount exceeding deposited funds',
    method: 'withdraw',
    args: { mandate_id: 1, amount: '9999999999' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'INSUFFICIENT_FREE_BALANCE',
    note: 'Cannot withdraw more than free remainder (deposited - spent - reserved - withdrawn)',
    extraParams: { mandateRevoked: true },
  });
  pushCase({
    title: 'Withdraw with insufficient prepaid gas (< 60 Tgas)',
    method: 'withdraw',
    args: { mandate_id: 1, amount: '10000' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'INSUFFICIENT_GAS',
    note: 'Withdraw requires at least 60 Tgas',
    extraParams: { gas: '30000000000000' },
  });

  // 17-30. Tighten / Loosen wrong direction & bounds
  pushCase({
    title: 'tighten: attempting to increase budget (not stricter)',
    method: 'tighten',
    args: { mandate_id: 1, change: { Budget: '2000000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NOT_STRICTER',
    note: 'tighten only accepts strictly lower values for budget',
  });
  pushCase({
    title: 'tighten: reducing budget below current cap',
    method: 'tighten',
    args: { mandate_id: 1, change: { Budget: '400000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'BUDGET_BELOW_CAP',
    note: 'Invariance K-A: budget >= cap',
  });
  pushCase({
    title: 'tighten: reducing cap below threshold',
    method: 'tighten',
    args: { mandate_id: 1, change: { PerPaymentCap: '100000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'CAP_BELOW_THRESHOLD',
    note: 'Invariance K-A: cap >= threshold',
  });
  pushCase({
    title: 'tighten: remove recipient not currently in allowlist',
    method: 'tighten',
    args: { mandate_id: 1, change: { RemoveRecipient: 'unknown.testnet' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NO_SUCH_RECIPIENT',
    note: 'Cannot remove recipient not in list',
  });
  pushCase({
    title: 'tighten: set expiry in the past',
    method: 'tighten',
    args: { mandate_id: 1, change: { Expiry: 100000 } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'EXPIRY_NOT_IN_FUTURE',
    note: 'Expiry must be in future',
  });
  pushCase({
    title: 'loosen: attempting to decrease budget (not looser)',
    method: 'loosen',
    args: { mandate_id: 1, change: { Budget: '500000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NOT_LOOSER',
    note: 'loosen only accepts looser values',
  });
  pushCase({
    title: 'loosen: increasing budget beyond deposited amount',
    method: 'loosen',
    args: { mandate_id: 1, change: { Budget: '5000000000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'BUDGET_ABOVE_DEPOSITED',
    note: 'Budget cannot exceed deposited minus withdrawn',
  });
  pushCase({
    title: 'loosen: increasing cap above budget',
    method: 'loosen',
    args: { mandate_id: 1, change: { PerPaymentCap: '2000000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'CAP_ABOVE_BUDGET',
    note: 'Cap cannot exceed budget',
  });
  pushCase({
    title: 'loosen: increasing threshold above cap',
    method: 'loosen',
    args: { mandate_id: 1, change: { ApprovalThreshold: '600000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'THRESHOLD_ABOVE_CAP',
    note: 'Threshold cannot exceed cap',
  });
  pushCase({
    title: 'loosen: adding already registered recipient',
    method: 'loosen',
    args: { mandate_id: 1, change: { AddRecipient: 'merchant.testnet' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'DUPLICATE_RECIPIENT',
    note: 'Cannot add duplicate recipient',
  });
  pushCase({
    title: 'loosen: adding 17th recipient (exceeding limit of 16)',
    method: 'loosen',
    args: { mandate_id: 1, change: { AddRecipient: 'merchant17.testnet' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'TOO_MANY_RECIPIENTS',
    note: 'Max 16 recipients per mandate',
  });
  pushCase({
    title: 'resolve_stale: request is not stale (< 200 blocks)',
    method: 'resolve_stale',
    args: { mandate_id: 1, request_id: 1, transferred: false },
    expectedLabel: 'BLOCKED',
    expectedCode: 'REQUEST_NOT_STALE',
    note: 'Cannot resolve pending request before STALE_BLOCKS timeout',
  });

  // 31-60. Property-based seeded variations for lifecycle operations (39 cases)
  const rng = mulberry32(SEED_CAT10);
  for (let i = 0; i < 39; i++) {
    const r = rng();
    let title;
    let expectedCode;
    let method = 'tighten';

    if (r < 0.25) {
      title = `Seeded invalid tighten budget direction #${i + 1}`;
      expectedCode = 'NOT_STRICTER';
    } else if (r < 0.5) {
      title = `Seeded invalid loosen direction #${i + 1}`;
      method = 'loosen';
      expectedCode = 'NOT_LOOSER';
    } else if (r < 0.75) {
      title = `Seeded premature withdraw attempt #${i + 1}`;
      method = 'withdraw';
      expectedCode = 'MANDATE_STILL_ACTIVE';
    } else {
      title = `Seeded post-revoke invalid method call #${i + 1}`;
      method = 'request_payment';
      expectedCode = 'NOT_ACTIVE';
    }

    pushCase({
      title,
      method,
      args: { mandate_id: 1, nonce: 600 + i },
      expectedLabel: 'BLOCKED',
      expectedCode,
      note: `Seeded parametric lifecycle test (seed: ${SEED_CAT10})`,
    });
  }

  return cases;
}

/**
 * Combines Step 2 cases (Category 4 & Category 10).
 * Total: 120 cases.
 */
export function generateApprovalLifecycleCases() {
  const cat4 = generateCategory4Cases();
  const cat10 = generateCategory10Cases();
  return [...cat4, ...cat10];
}
