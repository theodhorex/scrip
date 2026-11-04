import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  createTestnetSession,
  executeLayerE,
  classifyTxResult,
  classifyTxError,
  getCallerAccount,
  getMandateIndexForCase,
  routeMethod,
  callAsOwner,
  T,
  mapCallerInArgs,
  inferVmRejection,
} from '../layers/testnet.mjs';
import { generateCategory10Cases } from '../cases/layer_e/approval_lifecycle.mjs';
import { generateCategory5Cases } from '../cases/layer_e/access_identity.mjs';

test('owner method mapping: classifyTxResult and classifyTxError detect AMANAT_ERR', async () => {
  assert.equal(typeof classifyTxResult, 'function');
  assert.equal(typeof classifyTxError, 'function');

  // Test classifyTxResult with AMANAT_ERR in logs
  const mockResLog = {
    transaction: { hash: 'TX_TEST_1' },
    receipts_outcome: [
      { outcome: { logs: ['AMANAT_ERR: NOT_ACTIVE'] } },
    ],
  };
  const c1 = classifyTxResult(mockResLog);
  assert.equal(c1.label, 'BLOCKED');
  assert.equal(c1.code, 'NOT_ACTIVE');
  assert.equal(c1.txHash, 'TX_TEST_1');

  // Test classifyTxResult with EVENT_JSON rejected
  const mockResRejected = {
    transaction: { hash: 'TX_TEST_2' },
    receipts_outcome: [
      { outcome: { logs: ['EVENT_JSON:{"event":"rejected","data":[{"code":"NOT_ACTIVE"}]}'] } },
    ],
  };
  const c2 = classifyTxResult(mockResRejected);
  assert.equal(c2.label, 'BLOCKED');
  assert.equal(c2.code, 'NOT_ACTIVE');

  // Test classifyTxError with panic message
  const mockErrPanic = new Error('Smart contract panicked: AMANAT_ERR:UNAUTHORIZED_AGENT');
  const c3 = await classifyTxError(mockErrPanic);
  assert.equal(c3.label, 'BLOCKED');
  assert.equal(c3.code, 'UNAUTHORIZED_AGENT');

  // Test classifyTxError with transactionResult inline logs
  const mockErrTrap = new Error('WebAssembly trap');
  mockErrTrap.transactionResult = {
    transaction_outcome: { id: 'TX_FAILED_HASH' },
    receipts_outcome: [{ outcome: { logs: ['AMANAT_ERR: MANDATE_STILL_ACTIVE'] } }],
  };
  const c4 = await classifyTxError(mockErrTrap);
  assert.equal(c4.label, 'BLOCKED');
  assert.equal(c4.code, 'MANDATE_STILL_ACTIVE');
  assert.equal(c4.txHash, 'TX_FAILED_HASH');
});

test('session initialization includes stranger account in createdAccounts', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 4 });
  try {
    assert.ok(session.strangerId, 'session.strangerId must be defined');
    assert.ok(session.strangerKey, 'session.strangerKey must be defined');
    assert.match(session.strangerId, /amst_/);
  } finally {
    await session.closeSession();
  }
});

test('category 10 owner methods route through funderAcc (owner), not the relay', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 4 });
  try {
    // Method -> transport routing is what the real path uses to bypass /relay (which only allows request_payment).
    assert.equal(routeMethod('revoke'), 'owner');
    assert.equal(routeMethod('withdraw'), 'owner');
    assert.equal(routeMethod('tighten'), 'owner');
    assert.equal(routeMethod('loosen'), 'guardian');
    assert.equal(routeMethod('resolve_stale'), 'guardian');
    assert.equal(routeMethod('approve_intent'), 'approve_intent');
    assert.equal(routeMethod('request_payment'), 'relay');

    const mandateId = session.mandates[0].id;
    // The dry mock enforces owner == session.funderId, so this only passes if callAsOwner uses funderAcc.
    const revoked = await callAsOwner(session, 'revoke', { mandate_id: mandateId }, { gas: T(30) });
    assert.equal(classifyTxResult(revoked).label, 'INERT');
    assert.equal((await session.viewMandate(mandateId)).status, 'Revoked');

    // Double revoke reaches the contract and is rejected with NOT_ACTIVE (not METHOD_NOT_ALLOWED).
    const doubleRevoke = await callAsOwner(session, 'revoke', { mandate_id: mandateId }, { gas: T(30) });
    assert.equal(classifyTxResult(doubleRevoke).code, 'NOT_ACTIVE');

    // Owner withdraw on a revoked mandate succeeds and moves the withdrawn balance.
    const withdrawn = await callAsOwner(session, 'withdraw', { mandate_id: mandateId, amount: '100000' }, { gas: T(60) });
    assert.equal(classifyTxResult(withdrawn).label, 'INERT');
    assert.equal((await session.viewMandate(mandateId)).withdrawn, '100000');
  } finally {
    await session.closeSession();
  }
});

test('category 10 cases use dedicated mandates per lifecycle group', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 40 });
  try {
    const cases = generateCategory10Cases();
    const byId = new Map(cases.map((c) => [c.id, c]));
    const idx = (id) => getMandateIndexForCase(byId.get(id), session);

    // Revocation group 10-01..05 must share mandate 0 so status carries across cases in order.
    for (let n = 1; n <= 5; n++) {
      assert.equal(idx(`KAT-E-10-${String(n).padStart(2, '0')}`), 0, `10-0${n} must stay on the revocation mandate`);
    }
    assert.equal(idx('KAT-E-10-06'), 1, 'withdraw-on-active must not see the revoked mandate');
    assert.equal(idx('KAT-E-10-07'), 2, 'withdraw-on-revoked group needs its own mandate');
    assert.equal(idx('KAT-E-10-08'), 2);
    assert.equal(idx('KAT-E-10-09'), 1, 'insufficient-gas withdraw stays on an active mandate');

    // Seeded status-dependent cases must be routed to a mandate in the required state.
    const notActive = cases.find((c) => c.expected.code === 'NOT_ACTIVE' && c.id.endsWith('60'));
    assert.ok(notActive, 'seeded NOT_ACTIVE case must exist');
    assert.equal(getMandateIndexForCase(notActive, session), 0);

    // Active lifecycle modifications (tighten/loosen) are spread over the remaining mandates.
    const active = idx('KAT-E-10-10');
    assert.ok(active >= 3, `active tighten case must avoid revoked groups, got ${active}`);
    assert.notEqual(idx('KAT-E-10-14'), 0);
  } finally {
    await session.closeSession();
  }
});

test('classifyTxError maps near-sdk method guards to METHOD_NOT_PAYABLE / METHOD_IS_PRIVATE', async () => {
  const payable = await classifyTxError(new Error("Smart contract panicked: Method request_payment doesn't accept deposit"));
  assert.equal(payable.label, 'BLOCKED');
  assert.equal(payable.code, 'METHOD_NOT_PAYABLE');

  const priv = await classifyTxError(new Error('Smart contract panicked: Method on_payment_done is private'));
  assert.equal(priv.label, 'BLOCKED');
  assert.equal(priv.code, 'METHOD_IS_PRIVATE');
});

test('corrected expected codes match the contract panic codes', () => {
  const cat10 = new Map(generateCategory10Cases().map((c) => [c.id, c]));
  assert.equal(cat10.get('KAT-E-10-03').expected.code, 'ALREADY_REVOKED');
  assert.equal(cat10.get('KAT-E-10-08').expected.code, 'AMOUNT_EXCEEDS_FREE');
  assert.equal(cat10.get('KAT-E-10-21').expected.code, 'NOT_STALE_YET');

  const cat5 = new Map(generateCategory5Cases().map((c) => [c.id, c]));
  assert.equal(cat5.get('KAT-E-05-15').expected.code, 'UNAUTHORIZED_OWNER_OR_GUARDIAN');
  assert.equal(cat5.get('KAT-E-05-19').expected.code, 'UNAUTHORIZED_OWNER_OR_GUARDIAN');
});

test('category 5 stranger uses a real valid key and is rejected by the contract', async () => {
  const session = await createTestnetSession({ dry: true, mandatesCount: 4 });
  try {
    const stranger = getCallerAccount(session, 'stranger.testnet');
    assert.equal(stranger.accountId, session.strangerId, 'stranger senderId must be the real sub-account, not a placeholder');
    assert.notEqual(stranger.accountId, session.getAgent(0).id, 'stranger must not be the mandate agent');
    assert.ok(
      session.createdAccounts.some((a) => a.id === session.strangerId),
      'stranger account must exist in createdAccounts (valid full-access key)'
    );

    const mandateId = session.mandates[0].id;
    const call = (methodName, args) => stranger.callFunctionRaw({
      contractId: session.contractId,
      methodName,
      args,
      gas: T(60),
      deposit: 0n,
    });

    // Each method is rejected by the CONTRACT (authorization), not by the NEAR runtime missing the key.
    const pay = classifyTxResult(await call('request_payment', { mandate_id: mandateId, recipient: 'merchant.testnet', amount: '1000', nonce: 1 }));
    assert.equal(pay.code, 'UNAUTHORIZED_AGENT');
    const loosen = classifyTxResult(await call('loosen', { mandate_id: mandateId, change: { Budget: '1500000' } }));
    assert.equal(loosen.code, 'UNAUTHORIZED_GUARDIAN');
    const withdraw = classifyTxResult(await call('withdraw', { mandate_id: mandateId, amount: '1000' }));
    assert.equal(withdraw.code, 'UNAUTHORIZED_OWNER');
    const tighten = classifyTxResult(await call('tighten', { mandate_id: mandateId, change: { Budget: '1000000' } }));
    assert.equal(tighten.code, 'UNAUTHORIZED');
  } finally {
    await session.closeSession();
  }
});

test('symbolic caller mapping for KAT-E-05-37 and 05-38, preserving 05-39', () => {
  const realSigner = 'funder_real.testnet';
  const cat5 = new Map(generateCategory5Cases().map((c) => [c.id, c]));

  // KAT-E-05-37: owner == agent (caller: 'alice.testnet', args.agent: 'alice.testnet')
  const c37 = cat5.get('KAT-E-05-37');
  assert.equal(c37.params.senderId, 'alice.testnet');
  assert.equal(c37.params.args.agent, 'alice.testnet');
  const mappedArgs37 = mapCallerInArgs(c37.params.args, c37.params.senderId, realSigner);
  assert.equal(mappedArgs37.agent, realSigner, '05-37 args.agent must map to real signer accountId');
  assert.equal(mappedArgs37.guardian, c37.params.args.guardian, '05-37 guardian must not change');

  // KAT-E-05-38: guardian == owner (caller: 'alice.testnet', args.guardian: 'alice.testnet')
  const c38 = cat5.get('KAT-E-05-38');
  assert.equal(c38.params.senderId, 'alice.testnet');
  assert.equal(c38.params.args.guardian, 'alice.testnet');
  const mappedArgs38 = mapCallerInArgs(c38.params.args, c38.params.senderId, realSigner);
  assert.equal(mappedArgs38.guardian, realSigner, '05-38 args.guardian must map to real signer accountId');
  assert.equal(mappedArgs38.agent, c38.params.args.agent, '05-38 agent must not change');

  // KAT-E-05-39: guardian == agent (caller: 'alice.testnet', args.agent: 'bob.testnet', args.guardian: 'bob.testnet')
  const c39 = cat5.get('KAT-E-05-39');
  assert.equal(c39.params.senderId, 'alice.testnet');
  assert.equal(c39.params.args.agent, 'bob.testnet');
  assert.equal(c39.params.args.guardian, 'bob.testnet');
  const mappedArgs39 = mapCallerInArgs(c39.params.args, c39.params.senderId, realSigner);
  assert.equal(mappedArgs39.agent, 'bob.testnet', '05-39 args.agent must remain unchanged');
  assert.equal(mappedArgs39.guardian, 'bob.testnet', '05-39 args.guardian must remain unchanged');

  // Negative / safety checks: do not map strangers or mismatched callers
  const customArgs = { agent: 'stranger.testnet', guardian: 'guardian.testnet', recipients: ['merchant.testnet'] };
  const mappedCustom = mapCallerInArgs(customArgs, 'alice.testnet', realSigner);
  assert.deepEqual(mappedCustom, customArgs, 'Mismatched caller name must not modify any arg');
});

test('inferVmRejection: positive tests for private callbacks and non-payable methods', () => {
  // (i) #[private] callback methods called externally
  assert.equal(
    inferVmRejection({ method: 'on_payment_done', callerIsContractItself: false, txFailedWithTrap: true }),
    'METHOD_IS_PRIVATE'
  );
  assert.equal(
    inferVmRejection({ method: 'on_withdraw_done', callerIsContractItself: false, txFailedWithTrap: true }),
    'METHOD_IS_PRIVATE'
  );

  // (ii) non-payable methods with deposit > 0
  const nonPayable = ['request_payment', 'withdraw', 'tighten', 'loosen', 'revoke', 'resolve_stale'];
  for (const m of nonPayable) {
    assert.equal(
      inferVmRejection({ method: m, deposit: 1n, txFailedWithTrap: true }),
      'METHOD_NOT_PAYABLE',
      `Method ${m} with deposit 1n should infer METHOD_NOT_PAYABLE`
    );
    assert.equal(
      inferVmRejection({ method: m, deposit: '1000000000000000000000', txFailedWithTrap: true }),
      'METHOD_NOT_PAYABLE',
      `Method ${m} with deposit string should infer METHOD_NOT_PAYABLE`
    );
  }
});

test('inferVmRejection: negative tests ensuring classification cannot produce false positives', () => {
  // Method payable + deposit + trap -> TX_FAILED (not METHOD_NOT_PAYABLE)
  assert.equal(
    inferVmRejection({ method: 'create_mandate', deposit: '50000000000000000000000', txFailedWithTrap: true }),
    'TX_FAILED',
    'Payable create_mandate with deposit + trap must NOT infer METHOD_NOT_PAYABLE'
  );
  assert.equal(
    inferVmRejection({ method: 'approve_intent', deposit: 2000000000000000000000n, txFailedWithTrap: true }),
    'TX_FAILED',
    'Payable approve_intent with deposit + trap must NOT infer METHOD_NOT_PAYABLE'
  );

  // Method non-payable with deposit 0 + trap -> TX_FAILED
  assert.equal(
    inferVmRejection({ method: 'request_payment', deposit: 0n, txFailedWithTrap: true }),
    'TX_FAILED',
    'request_payment with deposit 0 must NOT infer METHOD_NOT_PAYABLE'
  );
  assert.equal(
    inferVmRejection({ method: 'withdraw', deposit: '0', txFailedWithTrap: true }),
    'TX_FAILED',
    'withdraw with deposit 0 must NOT infer METHOD_NOT_PAYABLE'
  );
  assert.equal(
    inferVmRejection({ method: 'tighten', deposit: null, txFailedWithTrap: true }),
    'TX_FAILED',
    'tighten with null deposit must NOT infer METHOD_NOT_PAYABLE'
  );

  // on_* called by the contract itself -> NOT METHOD_IS_PRIVATE
  assert.equal(
    inferVmRejection({ method: 'on_payment_done', callerIsContractItself: true, txFailedWithTrap: true }),
    'TX_FAILED',
    'on_payment_done called by contract itself must NOT infer METHOD_IS_PRIVATE'
  );
  assert.equal(
    inferVmRejection({ method: 'on_withdraw_done', callerIsContractItself: true, txFailedWithTrap: true }),
    'TX_FAILED',
    'on_withdraw_done called by contract itself must NOT infer METHOD_IS_PRIVATE'
  );

  // Trap on other methods -> TX_FAILED
  assert.equal(
    inferVmRejection({ method: 'unknown_method', deposit: 100n, txFailedWithTrap: true }),
    'TX_FAILED',
    'Unknown method must return TX_FAILED'
  );
  assert.equal(
    inferVmRejection({ method: 'get_mandate', deposit: 0n, txFailedWithTrap: true }),
    'TX_FAILED'
  );

  // No trap -> TX_FAILED
  assert.equal(
    inferVmRejection({ method: 'request_payment', deposit: 100n, txFailedWithTrap: false }),
    'TX_FAILED',
    'Without trap, must return TX_FAILED'
  );
});

test('classifyTxError integrates inferVmRejection on trap errors with caller context', async () => {
  const trapErr = new Error('WebAssembly trap: An `unreachable` opcode was executed.');

  // Non-payable method with deposit
  const resPayable = await classifyTxError(trapErr, null, 'agent.testnet', {
    method: 'request_payment',
    deposit: 100n,
    contractId: 'contract.testnet',
  });
  assert.equal(resPayable.label, 'BLOCKED');
  assert.equal(resPayable.code, 'METHOD_NOT_PAYABLE');
  assert.match(resPayable.note, /kode diturunkan dari bentuk panggilan karena wasm rilis tidak mengeluarkan pesan panic/);

  // Private callback method called externally
  const resPrivate = await classifyTxError(trapErr, null, 'agent.testnet', {
    method: 'on_payment_done',
    deposit: 0n,
    contractId: 'contract.testnet',
  });
  assert.equal(resPrivate.label, 'BLOCKED');
  assert.equal(resPrivate.code, 'METHOD_IS_PRIVATE');
  assert.match(resPrivate.note, /kode diturunkan dari bentuk panggilan karena wasm rilis tidak mengeluarkan pesan panic/);

  // Payable method with deposit on trap: must stay TX_FAILED
  const resMandate = await classifyTxError(trapErr, null, 'alice.testnet', {
    method: 'create_mandate',
    deposit: 50000000000000000000000n,
    contractId: 'contract.testnet',
  });
  assert.equal(resMandate.label, 'BLOCKED');
  assert.equal(resMandate.code, 'TX_FAILED');
});
