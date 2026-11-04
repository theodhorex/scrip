// Layer E (Testnet) Generator: Step 3 - Access and Identity (Category 5)
// Conforms strictly to contracts/scrip/README.md specification:
// - Authorization matrix: predecessor_account_id checks on each method
// - Prohibited identity combinations: owner == agent, guardian == owner
// - Payable vs non-payable guards (rejecting deposits on non-payable methods)
// - Minimum storage deposit thresholds on create_mandate / approve_intent
// Total cases: 100

export const SEED_CAT5 = 0x20261030_05;

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
 * Generates Category 5 cases: caller access control, identity combinations, deposit guards.
 * Total: 100 cases.
 */
export function generateCategory5Cases() {
  const cases = [];
  let index = 1;

  const pushCase = ({ title, method, caller, deposit = '0', args, expectedLabel, expectedCode, note, extraParams = {} }) => {
    const id = `KAT-E-05-${String(index).padStart(2, '0')}`;
    cases.push({
      id,
      category: 5,
      layer: 'E',
      title,
      params: {
        mandate_id: DEFAULT_MANDATE_ID,
        transport: 'rpc', // RPC invocation allows custom predecessor senderId
        method: method || 'request_payment',
        senderId: caller,
        deposit,
        args: args || {
          mandate_id: DEFAULT_MANDATE_ID,
          recipient: 'merchant.testnet',
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

  // 1-40. Authorization Matrix across methods and caller roles
  // 1. request_payment: agent only
  pushCase({
    title: 'request_payment called by authorized agent',
    method: 'request_payment',
    caller: 'agent.testnet',
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Authorized agent succeeds',
  });
  pushCase({
    title: 'request_payment called by owner (unauthorized agent)',
    method: 'request_payment',
    caller: 'owner.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_AGENT',
    note: 'Owner cannot call request_payment',
  });
  pushCase({
    title: 'request_payment called by guardian (unauthorized agent)',
    method: 'request_payment',
    caller: 'guardian.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_AGENT',
    note: 'Guardian cannot call request_payment',
  });
  pushCase({
    title: 'request_payment called by stranger (unauthorized agent)',
    method: 'request_payment',
    caller: 'stranger.testnet',
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_AGENT',
    note: 'Predecessor is not the assigned agent',
  });

  // 2. approve_intent: guardian only
  pushCase({
    title: 'approve_intent called by authorized guardian',
    method: 'approve_intent',
    caller: 'guardian.testnet',
    deposit: '2000000000000000000000', // 2 mNEAR
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 10, approval_expires_at_ms: Date.now() + 3600000 },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Authorized guardian approve succeeds',
  });
  pushCase({
    title: 'approve_intent called by agent (unauthorized guardian)',
    method: 'approve_intent',
    caller: 'agent.testnet',
    deposit: '2000000000000000000000',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 11, approval_expires_at_ms: Date.now() + 3600000 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_GUARDIAN',
    note: 'Agent cannot approve its own intent',
  });
  pushCase({
    title: 'approve_intent called by owner (unauthorized guardian)',
    method: 'approve_intent',
    caller: 'owner.testnet',
    deposit: '2000000000000000000000',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 12, approval_expires_at_ms: Date.now() + 3600000 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_GUARDIAN',
    note: 'Owner cannot approve intents, guardian required',
  });
  pushCase({
    title: 'approve_intent called by stranger (unauthorized guardian)',
    method: 'approve_intent',
    caller: 'stranger.testnet',
    deposit: '2000000000000000000000',
    args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '500000', nonce: 13, approval_expires_at_ms: Date.now() + 3600000 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_GUARDIAN',
    note: 'Stranger cannot approve intents',
  });

  // 3. loosen: guardian only
  pushCase({
    title: 'loosen called by authorized guardian',
    method: 'loosen',
    caller: 'guardian.testnet',
    args: { mandate_id: 1, change: { Budget: '1250000' } },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Guardian is authorized to loosen limits; prep lowers budget to 1000000 first so raising it to the 1250000 deposit ceiling is a legal loosening',
    extraParams: { loosenBudgetPrep: '1000000' },
  });
  pushCase({
    title: 'loosen called by owner (unauthorized guardian)',
    method: 'loosen',
    caller: 'owner.testnet',
    args: { mandate_id: 1, change: { Budget: '1500000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_GUARDIAN',
    note: 'Owner cannot loosen limits; requires guardian',
  });
  pushCase({
    title: 'loosen called by agent (unauthorized guardian)',
    method: 'loosen',
    caller: 'agent.testnet',
    args: { mandate_id: 1, change: { Budget: '1500000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_GUARDIAN',
    note: 'Agent cannot loosen limits',
  });
  pushCase({
    title: 'loosen called by stranger (unauthorized guardian)',
    method: 'loosen',
    caller: 'stranger.testnet',
    args: { mandate_id: 1, change: { Budget: '1500000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_GUARDIAN',
    note: 'Stranger cannot loosen limits',
  });

  // 4. tighten: owner or guardian
  pushCase({
    title: 'tighten called by authorized owner',
    method: 'tighten',
    caller: 'owner.testnet',
    args: { mandate_id: 1, change: { Budget: '1000000' } },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Owner can tighten mandate',
  });
  pushCase({
    title: 'tighten called by authorized guardian',
    method: 'tighten',
    caller: 'guardian.testnet',
    args: { mandate_id: 1, change: { Budget: '1000000' } },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Guardian can tighten mandate',
  });
  pushCase({
    title: 'tighten called by agent (unauthorized)',
    method: 'tighten',
    caller: 'agent.testnet',
    args: { mandate_id: 1, change: { Budget: '1000000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_OWNER_OR_GUARDIAN',
    note: 'lib.rs:660: tighten requires owner or guardian, panics UNAUTHORIZED_OWNER_OR_GUARDIAN',
  });
  pushCase({
    title: 'tighten called by stranger (unauthorized)',
    method: 'tighten',
    caller: 'stranger.testnet',
    args: { mandate_id: 1, change: { Budget: '1000000' } },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_OWNER_OR_GUARDIAN',
    note: 'lib.rs:660: tighten requires owner or guardian, panics UNAUTHORIZED_OWNER_OR_GUARDIAN',
  });

  // 5. revoke: owner or guardian
  pushCase({
    title: 'revoke called by authorized owner',
    method: 'revoke',
    caller: 'owner.testnet',
    args: { mandate_id: 1 },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Owner can revoke mandate',
  });
  pushCase({
    title: 'revoke called by authorized guardian',
    method: 'revoke',
    caller: 'guardian.testnet',
    args: { mandate_id: 1 },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Guardian can revoke mandate',
  });
  pushCase({
    title: 'revoke called by agent (unauthorized)',
    method: 'revoke',
    caller: 'agent.testnet',
    args: { mandate_id: 1 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_OWNER_OR_GUARDIAN',
    note: 'lib.rs:746: revoke requires owner or guardian, panics UNAUTHORIZED_OWNER_OR_GUARDIAN',
  });
  pushCase({
    title: 'revoke called by stranger (unauthorized)',
    method: 'revoke',
    caller: 'stranger.testnet',
    args: { mandate_id: 1 },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_OWNER_OR_GUARDIAN',
    note: 'lib.rs:746: revoke requires owner or guardian, panics UNAUTHORIZED_OWNER_OR_GUARDIAN',
  });

  // 6. withdraw: owner only
  pushCase({
    title: 'withdraw called by authorized owner on revoked mandate',
    method: 'withdraw',
    caller: 'owner.testnet',
    args: { mandate_id: 1, amount: '10000' },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Owner can withdraw from revoked mandate',
    extraParams: { mandateRevoked: true },
  });
  pushCase({
    title: 'withdraw called by guardian (unauthorized owner)',
    method: 'withdraw',
    caller: 'guardian.testnet',
    args: { mandate_id: 1, amount: '10000' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_OWNER',
    note: 'Guardian cannot withdraw funds; owner only',
  });
  pushCase({
    title: 'withdraw called by agent (unauthorized owner)',
    method: 'withdraw',
    caller: 'agent.testnet',
    args: { mandate_id: 1, amount: '10000' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_OWNER',
    note: 'Agent cannot withdraw funds',
  });
  pushCase({
    title: 'withdraw called by stranger (unauthorized owner)',
    method: 'withdraw',
    caller: 'stranger.testnet',
    args: { mandate_id: 1, amount: '10000' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_OWNER',
    note: 'Stranger cannot withdraw funds',
  });

  // 7. resolve_stale: guardian only
  pushCase({
    title: 'resolve_stale called by authorized guardian',
    method: 'resolve_stale',
    caller: 'guardian.testnet',
    args: { mandate_id: 1, request_id: 1, transferred: true },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Guardian resolves a stale Pending; transferred=true is required by lib.rs:827 (F4), prep creates a Pending >= 200 blocks old',
    extraParams: { isStale: true, pendingRequest: 'stale' },
  });
  pushCase({
    title: 'resolve_stale called by owner (unauthorized guardian)',
    method: 'resolve_stale',
    caller: 'owner.testnet',
    args: { mandate_id: 1, request_id: 1, transferred: false },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_GUARDIAN',
    note: 'Owner cannot resolve stale requests',
  });
  pushCase({
    title: 'resolve_stale called by agent (unauthorized guardian)',
    method: 'resolve_stale',
    caller: 'agent.testnet',
    args: { mandate_id: 1, request_id: 1, transferred: false },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_GUARDIAN',
    note: 'Agent cannot resolve stale requests',
  });
  pushCase({
    title: 'resolve_stale called by stranger (unauthorized guardian)',
    method: 'resolve_stale',
    caller: 'stranger.testnet',
    args: { mandate_id: 1, request_id: 1, transferred: false },
    expectedLabel: 'BLOCKED',
    expectedCode: 'UNAUTHORIZED_GUARDIAN',
    note: 'Stranger cannot resolve stale requests',
  });

  // 8. #[private] callbacks: contract only
  const privateCallers = ['agent.testnet', 'owner.testnet', 'guardian.testnet', 'stranger.testnet'];
  for (const c of privateCallers) {
    pushCase({
      title: `Private callback on_payment_done invoked externally by ${c}`,
      method: 'on_payment_done',
      caller: c,
      args: { mandate_id: 1, request_id: 1 },
      expectedLabel: 'BLOCKED',
      expectedCode: 'METHOD_IS_PRIVATE',
      note: 'Private callback can only be called by contract itself',
    });
    pushCase({
      title: `Private callback on_withdraw_done invoked externally by ${c}`,
      method: 'on_withdraw_done',
      caller: c,
      args: { mandate_id: 1, amount: '10000' },
      expectedLabel: 'BLOCKED',
      expectedCode: 'METHOD_IS_PRIVATE',
      note: 'Private callback can only be called by contract itself',
    });
  }

  // 41-55. create_mandate identity combinations & storage deposit
  const createBase = {
    agent: 'agent.testnet',
    guardian: 'guardian.testnet',
    token: 'usdc.testnet',
    budget: '1250000',
    per_payment_cap: '500000',
    approval_threshold: '500000',
    recipients: ['merchant.testnet'],
    expires_at_ms: Date.now() + 86400000,
  };

  pushCase({
    title: 'create_mandate with owner == agent',
    method: 'create_mandate',
    caller: 'alice.testnet',
    deposit: '50000000000000000000000', // 0.05 NEAR
    args: { ...createBase, agent: 'alice.testnet' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'OWNER_IS_AGENT',
    note: 'Contract rejects owner == agent',
  });
  pushCase({
    title: 'create_mandate with guardian == owner',
    method: 'create_mandate',
    caller: 'alice.testnet',
    deposit: '50000000000000000000000',
    args: { ...createBase, guardian: 'alice.testnet' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GUARDIAN_IS_OWNER',
    note: 'Contract rejects guardian == owner',
  });
  pushCase({
    title: 'create_mandate with guardian == agent',
    method: 'create_mandate',
    caller: 'alice.testnet',
    deposit: '50000000000000000000000',
    args: { ...createBase, agent: 'bob.testnet', guardian: 'bob.testnet' },
    expectedLabel: 'BLOCKED',
    expectedCode: 'GUARDIAN_IS_AGENT',
    note: 'Contract rejects guardian == agent',
  });

  // Storage deposit underpayment on create_mandate (< 0.05 NEAR)
  const underDeposits = [
    { title: 'create_mandate with 0 NEAR attached', dep: '0' },
    { title: 'create_mandate with 1 yoctoNEAR attached', dep: '1' },
    { title: 'create_mandate with 0.001 NEAR attached', dep: '1000000000000000000000' },
    { title: 'create_mandate with 0.01 NEAR attached', dep: '10000000000000000000000' },
    { title: 'create_mandate with 0.049 NEAR attached', dep: '49000000000000000000000' },
    { title: 'create_mandate with 0.049999 NEAR attached', dep: '49999000000000000000000' },
  ];
  for (const ud of underDeposits) {
    pushCase({
      title: ud.title,
      method: 'create_mandate',
      caller: 'alice.testnet',
      deposit: ud.dep,
      args: { ...createBase },
      expectedLabel: 'BLOCKED',
      expectedCode: 'INSUFFICIENT_STORAGE_DEPOSIT',
      note: 'create_mandate requires >= 0.05 NEAR storage deposit',
    });
  }

  // Exact & surplus deposits on create_mandate
  pushCase({
    title: 'create_mandate with exact 0.05 NEAR storage deposit',
    method: 'create_mandate',
    caller: 'alice.testnet',
    deposit: '50000000000000000000000',
    args: { ...createBase },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Exact 0.05 NEAR is accepted',
  });
  pushCase({
    title: 'create_mandate with 0.1 NEAR deposit (excess refunded to owner)',
    method: 'create_mandate',
    caller: 'alice.testnet',
    deposit: '100000000000000000000000',
    args: { ...createBase },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Excess deposit refunded to owner',
  });
  pushCase({
    title: 'create_mandate with 1 NEAR deposit (excess refunded to owner)',
    method: 'create_mandate',
    caller: 'alice.testnet',
    deposit: '1000000000000000000000000',
    args: { ...createBase },
    expectedLabel: 'INERT',
    expectedCode: null,
    note: 'Surplus storage deposit safely refunded',
  });

  // 56-75. Deposit on non-payable methods (rejecting attached deposit)
  const nonPayableMethods = [
    { method: 'request_payment', caller: 'agent.testnet', args: { mandate_id: 1, recipient: 'merchant.testnet', amount: '1000', nonce: 99 } },
    { method: 'withdraw', caller: 'owner.testnet', args: { mandate_id: 1, amount: '1000' } },
    { method: 'tighten', caller: 'owner.testnet', args: { mandate_id: 1, change: { Budget: '1000000' } } },
    { method: 'loosen', caller: 'guardian.testnet', args: { mandate_id: 1, change: { Budget: '1500000' } } },
    { method: 'revoke', caller: 'owner.testnet', args: { mandate_id: 1 } },
  ];
  const deposits = ['1', '1000000000000000000000', '10000000000000000000000', '1000000000000000000000000'];
  for (const m of nonPayableMethods) {
    for (const d of deposits) {
      pushCase({
        title: `Non-payable method ${m.method} called with attached deposit ${d}`,
        method: m.method,
        caller: m.caller,
        deposit: d,
        args: m.args,
        expectedLabel: 'BLOCKED',
        expectedCode: 'METHOD_NOT_PAYABLE',
        note: 'NEAR runtime rejects attached deposit on non-payable methods',
      });
    }
  }

  // 76-100. Property-based seeded variations for access control & caller identities (32 cases)
  const rng = mulberry32(SEED_CAT5);
  for (let i = 0; i < 32; i++) {
    const r = rng();
    let method = 'request_payment';
    let caller = 'random_attacker.testnet';
    let expectedCode = 'UNAUTHORIZED_AGENT';
    // Well-formed args are required: borsh decoding runs before the contract's authorization check,
    // so a missing field would abort with TX_FAILED before the UNAUTHORIZED_* branch is reached.
    let args = { mandate_id: 1, recipient: 'merchant.testnet', amount: '100000', nonce: 76 + i };

    if (r < 0.25) {
      method = 'loosen';
      caller = `intruder_${i}.testnet`;
      expectedCode = 'UNAUTHORIZED_GUARDIAN';
      args = { mandate_id: 1, change: { Budget: '1500000' } };
    } else if (r < 0.5) {
      method = 'withdraw';
      caller = `thief_${i}.testnet`;
      expectedCode = 'UNAUTHORIZED_OWNER';
      args = { mandate_id: 1, amount: '1000' };
    } else if (r < 0.75) {
      method = 'tighten';
      caller = `agent_${i}.testnet`;
      expectedCode = 'UNAUTHORIZED_OWNER_OR_GUARDIAN';
      args = { mandate_id: 1, change: { Budget: '1000000' } };
    } else {
      method = 'request_payment';
      caller = `impostor_${i}.testnet`;
      expectedCode = 'UNAUTHORIZED_AGENT';
    }

    pushCase({
      title: `Seeded unauthorized caller attempt #${i + 1} (${caller} on ${method})`,
      method,
      caller,
      args,
      expectedLabel: 'BLOCKED',
      expectedCode,
      note: `Seeded authorization violation (seed: ${SEED_CAT5})`,
    });
  }

  return cases;
}

export function generateAccessIdentityCases() {
  return generateCategory5Cases();
}
