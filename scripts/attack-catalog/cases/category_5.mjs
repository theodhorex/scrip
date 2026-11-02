// Parametric generator for Category 5: Access and Identity (Layer B - Facilitator HTTP)
// Based on PRD v1.3, facilitator/README.md, and policy.mjs specification:
// - senderId must be in policy.allowedAgents (default: ['agent1.testnet'])
// - receiverId must be policy.contractId (default: 'scrip.testnet')
// - fc.methodName must be in policy.allowedMethods (default: ['request_payment'])
// - exactly one FunctionCall action allowed
// - access key verified on-chain must be restricted FunctionCall key with non-zero allowance

class AccessKeyDoesNotExistError extends Error {}
class AccountDoesNotExistError extends Error {}

const TGAS = 10n ** 12n;

const BASE_PARAMS = {
  method: 'POST',
  path: '/relay',
  headers: {
    'content-type': 'application/json',
  },
};

export const CATEGORY_5_VARIATIONS = [
  // --- 1. Sender account variations (allowedAgents) ---
  {
    subId: '01',
    title: 'Sender is unauthorized testnet account (attacker.testnet)',
    delegate: { senderId: 'attacker.testnet', nonce: 501n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'AGENT_NOT_ALLOWED',
    reason: 'Only accounts listed in allowedAgents are permitted',
  },
  {
    subId: '02',
    title: 'Sender is unauthorized testnet account (mallory.testnet)',
    delegate: { senderId: 'mallory.testnet', nonce: 502n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'AGENT_NOT_ALLOWED',
    reason: 'Unauthorized agent blocked by policy allowlist',
  },
  {
    subId: '03',
    title: 'Sender is the contract itself (scrip.testnet)',
    delegate: { senderId: 'scrip.testnet', nonce: 503n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'AGENT_NOT_ALLOWED',
    reason: 'Contract cannot act as an agent without being in allowedAgents',
  },
  {
    subId: '04',
    title: 'Sender is relayer account (relayer.testnet)',
    delegate: { senderId: 'relayer.testnet', nonce: 504n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'AGENT_NOT_ALLOWED',
    reason: 'Relayer is not in allowedAgents list',
  },
  {
    subId: '05',
    title: 'Sender is mainnet account (agent1.near)',
    delegate: { senderId: 'agent1.near', nonce: 505n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'AGENT_NOT_ALLOWED',
    reason: 'Mainnet account IDs rejected fail-closed on testnet policy',
  },
  {
    subId: '06',
    title: 'Sender is another mainnet account (alice.near)',
    delegate: { senderId: 'alice.near', nonce: 506n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'AGENT_NOT_ALLOWED',
    reason: 'Non-testnet account ID rejected by isTestnetId',
  },
  {
    subId: '07',
    title: 'Sender is subaccount of allowed agent (sub.agent1.testnet)',
    delegate: { senderId: 'sub.agent1.testnet', nonce: 507n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'AGENT_NOT_ALLOWED',
    reason: 'Subaccounts do not inherit agent allowlist permissions',
  },
  {
    subId: '08',
    title: 'Sender is 64-character implicit hex account',
    delegate: {
      senderId: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
      nonce: 508n,
    },
    expectedLabel: 'BLOCKED',
    expectedCode: 'AGENT_NOT_ALLOWED',
    reason: 'Implicit accounts rejected by testnet policy',
  },
  {
    subId: '09',
    title: 'Sender is uppercase account ID (AGENT1.TESTNET)',
    delegate: { senderId: 'AGENT1.TESTNET', nonce: 509n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'AGENT_NOT_ALLOWED',
    reason: 'Uppercase NEAR account ID rejected by isTestnetId',
  },
  {
    subId: '10',
    title: 'Sender is random stranger account (bob.testnet)',
    delegate: { senderId: 'bob.testnet', nonce: 510n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'AGENT_NOT_ALLOWED',
    reason: 'Random testnet account not in allowedAgents',
  },

  // --- 2. Receiver contract variations ---
  {
    subId: '11',
    title: 'Receiver is foreign testnet contract (other-contract.testnet)',
    delegate: { receiverId: 'other-contract.testnet', nonce: 511n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'WRONG_RECEIVER',
    reason: 'Receiver must strictly match policy contractId',
  },
  {
    subId: '12',
    title: 'Receiver is USDC token contract (usdc.testnet)',
    delegate: { receiverId: 'usdc.testnet', nonce: 512n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'WRONG_RECEIVER',
    reason: 'Targeting token contract directly via facilitator is forbidden',
  },
  {
    subId: '13',
    title: 'Receiver is relayer account (relayer.testnet)',
    delegate: { receiverId: 'relayer.testnet', nonce: 513n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'WRONG_RECEIVER',
    reason: 'Relayer cannot be the delegate receiver',
  },
  {
    subId: '14',
    title: 'Receiver is agent account (agent1.testnet)',
    delegate: { receiverId: 'agent1.testnet', nonce: 514n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'WRONG_RECEIVER',
    reason: 'Self-targeting delegate receiver rejected',
  },
  {
    subId: '15',
    title: 'Receiver is mainnet contract (scrip.near)',
    delegate: { receiverId: 'scrip.near', nonce: 515n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'WRONG_RECEIVER',
    reason: 'Mainnet receiver rejected on testnet policy',
  },
  {
    subId: '16',
    title: 'Receiver is subaccount of contract (sub.scrip.testnet)',
    delegate: { receiverId: 'sub.scrip.testnet', nonce: 516n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'WRONG_RECEIVER',
    reason: 'Subaccounts do not match contractId',
  },

  // --- 3. Unallowed methods via /relay ---
  {
    subId: '17',
    title: 'Relay method approve_intent (disallowed method)',
    delegate: { rawActionMethod: 'approve_intent', nonce: 517n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'approve_intent cannot be relayed by facilitator',
  },
  {
    subId: '18',
    title: 'Relay method revoke_mandate (disallowed method)',
    delegate: { rawActionMethod: 'revoke_mandate', nonce: 518n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'revoke_mandate must be called directly by owner or guardian',
  },
  {
    subId: '19',
    title: 'Relay method withdraw (disallowed method)',
    delegate: { rawActionMethod: 'withdraw', nonce: 519n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'withdraw must be signed by mandate owner, not relayed',
  },
  {
    subId: '20',
    title: 'Relay method create_mandate (disallowed method)',
    delegate: { rawActionMethod: 'create_mandate', nonce: 520n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'create_mandate is an owner transaction',
  },
  {
    subId: '21',
    title: 'Relay method resolve_stale (disallowed method)',
    delegate: { rawActionMethod: 'resolve_stale', nonce: 521n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'resolve_stale is not in allowedMethods',
  },
  {
    subId: '22',
    title: 'Relay method tighten_mandate (disallowed method)',
    delegate: { rawActionMethod: 'tighten_mandate', nonce: 522n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'tighten_mandate is not in allowedMethods',
  },
  {
    subId: '23',
    title: 'Relay method drain_mandate (disallowed method)',
    delegate: { rawActionMethod: 'drain_mandate', nonce: 523n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'drain_mandate is not in allowedMethods',
  },
  {
    subId: '24',
    title: 'Relay method ft_transfer (disallowed method)',
    delegate: { rawActionMethod: 'ft_transfer', nonce: 524n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'ft_transfer is not in allowedMethods',
  },
  {
    subId: '25',
    title: 'Relay method ft_transfer_call (disallowed method)',
    delegate: { rawActionMethod: 'ft_transfer_call', nonce: 525n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'ft_transfer_call is not in allowedMethods',
  },
  {
    subId: '26',
    title: 'Relay method storage_deposit (disallowed method)',
    delegate: { rawActionMethod: 'storage_deposit', nonce: 526n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'storage_deposit is not in allowedMethods',
  },
  {
    subId: '27',
    title: 'Relay method storage_unregister (disallowed method)',
    delegate: { rawActionMethod: 'storage_unregister', nonce: 527n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'storage_unregister is not in allowedMethods',
  },
  {
    subId: '28',
    title: 'Relay method update_owner (disallowed method)',
    delegate: { rawActionMethod: 'update_owner', nonce: 528n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'update_owner is not in allowedMethods',
  },
  {
    subId: '29',
    title: 'Relay method add_guardian (disallowed method)',
    delegate: { rawActionMethod: 'add_guardian', nonce: 529n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'add_guardian is not in allowedMethods',
  },
  {
    subId: '30',
    title: 'Relay method remove_guardian (disallowed method)',
    delegate: { rawActionMethod: 'remove_guardian', nonce: 530n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'remove_guardian is not in allowedMethods',
  },
  {
    subId: '31',
    title: 'Relay method execute (disallowed method)',
    delegate: { rawActionMethod: 'execute', nonce: 531n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'execute is not in allowedMethods',
  },
  {
    subId: '32',
    title: 'Relay method new (constructor re-initialization attack)',
    delegate: { rawActionMethod: 'new', nonce: 532n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'Initialization methods are strictly disallowed',
  },
  {
    subId: '33',
    title: 'Relay method REQUEST_PAYMENT (uppercase variation)',
    delegate: { rawActionMethod: 'REQUEST_PAYMENT', nonce: 533n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'Method matching is case-sensitive',
  },
  {
    subId: '34',
    title: 'Relay method admin_override (backdoor probe)',
    delegate: { rawActionMethod: 'admin_override', nonce: 534n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'METHOD_NOT_ALLOWED',
    reason: 'Unknown admin method blocked',
  },

  // --- 4. Action structure variations ---
  {
    subId: '35',
    title: 'Delegate with zero actions',
    delegate: { actionType: 'empty', nonce: 535n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'WRONG_ACTION_COUNT',
    reason: 'Exactly one action required',
  },
  {
    subId: '36',
    title: 'Delegate with multiple actions (batching attack)',
    delegate: { actionType: 'multiple', nonce: 536n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'WRONG_ACTION_COUNT',
    reason: 'Facilitator rejects multi-action delegate calls',
  },
  {
    subId: '37',
    title: 'Delegate action is Transfer instead of FunctionCall',
    delegate: { actionType: 'transfer', nonce: 537n },
    expectedLabel: 'BLOCKED',
    expectedCode: 'NOT_FUNCTION_CALL',
    reason: 'Only FunctionCall actions are allowed',
  },

  // --- 5. Access key permissions on-chain ---
  {
    subId: '38',
    title: 'Access key has FullAccess permission on-chain',
    delegate: { nonce: 538n },
    keyPermission: 'FullAccess',
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    reason: 'FullAccess keys are strictly forbidden from relaying',
  },
  {
    subId: '39',
    title: 'Access key receiver is another contract on-chain',
    delegate: { nonce: 539n },
    keyPermission: {
      FunctionCall: {
        allowance: '1000000000000000000000000',
        receiver_id: 'other-app.testnet',
        method_names: ['request_payment'],
      },
    },
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    reason: 'Access key receiver must match policy contractId',
  },
  {
    subId: '40',
    title: 'Access key method_names is empty array on-chain',
    delegate: { nonce: 540n },
    keyPermission: {
      FunctionCall: {
        allowance: '1000000000000000000000000',
        receiver_id: 'scrip.testnet',
        method_names: [],
      },
    },
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    reason: 'Key with empty method_names array is rejected',
  },
  {
    subId: '41',
    title: 'Access key method_names has wrong method on-chain (approve_intent)',
    delegate: { nonce: 541n },
    keyPermission: {
      FunctionCall: {
        allowance: '1000000000000000000000000',
        receiver_id: 'scrip.testnet',
        method_names: ['approve_intent'],
      },
    },
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    reason: 'Key must be restricted to allowedMethods',
  },
  {
    subId: '42',
    title: 'Access key method_names has mixed unallowed method',
    delegate: { nonce: 542n },
    keyPermission: {
      FunctionCall: {
        allowance: '1000000000000000000000000',
        receiver_id: 'scrip.testnet',
        method_names: ['request_payment', 'drain_mandate'],
      },
    },
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    reason: 'All methods on key must be allowed by policy',
  },
  {
    subId: '43',
    title: 'Access key allowance is zero on-chain',
    delegate: { nonce: 543n },
    keyPermission: {
      FunctionCall: {
        allowance: '0',
        receiver_id: 'scrip.testnet',
        method_names: ['request_payment'],
      },
    },
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    reason: 'Access key with zero allowance is rejected',
  },
  {
    subId: '44',
    title: 'Access key not registered on sender account (AccessKeyDoesNotExist)',
    delegate: { nonce: 544n },
    onKey: () => {
      throw new AccessKeyDoesNotExistError('key not found');
    },
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    reason: 'Non-existent access key throws on RPC and is blocked',
  },
  {
    subId: '45',
    title: 'Sender account does not exist on-chain (AccountDoesNotExist)',
    delegate: { nonce: 545n },
    onKey: () => {
      throw new AccountDoesNotExistError('account not found');
    },
    expectedLabel: 'BLOCKED',
    expectedCode: 'KEY_NOT_ALLOWED',
    reason: 'Non-existent account throws on RPC and is blocked',
  },
];

/**
 * Parametric generator: builds Category 5 test cases for Layer B.
 *
 * @param {Array<object>} [variations]
 * @returns {Array<object>}
 */
export function generateCategory5Cases(variations = CATEGORY_5_VARIATIONS) {
  return variations.map((v) => {
    const expected = {
      label: v.expectedLabel || 'BLOCKED',
    };
    if (v.expectedCode) {
      expected.code = v.expectedCode;
    }
    return {
      id: `KAT-B-05-${v.subId}`,
      category: 5,
      layer: 'B',
      title: v.title,
      params: {
        ...BASE_PARAMS,
        delegate: v.delegate,
        keyPermission: v.keyPermission,
        onKey: v.onKey,
      },
      expected,
    };
  });
}
