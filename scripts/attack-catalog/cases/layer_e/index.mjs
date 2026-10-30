// Aggregator for Layer E (Testnet) Attack Cases
import {
  generatePaymentBudgetCases,
  generateCategory2Cases,
  generateCategory3Cases,
} from './payment_budget.mjs';

import {
  generateApprovalLifecycleCases,
  generateCategory4Cases,
  generateCategory10Cases,
} from './approval_lifecycle.mjs';

import {
  generateAccessIdentityCases,
  generateCategory5Cases,
} from './access_identity.mjs';

import {
  generateDelegateGasCases,
  generateCategory6Cases,
  generateCategory7Cases,
} from './delegate_gas.mjs';

import {
  generateTokenRecipientCases,
  generateCategory1Cases,
  generateCategory11Cases,
} from './token_recipient.mjs';

import {
  generateComparisonCases,
} from './comparison.mjs';

export {
  generatePaymentBudgetCases,
  generateCategory2Cases,
  generateCategory3Cases,
  generateApprovalLifecycleCases,
  generateCategory4Cases,
  generateCategory10Cases,
  generateAccessIdentityCases,
  generateCategory5Cases,
  generateDelegateGasCases,
  generateCategory6Cases,
  generateCategory7Cases,
  generateTokenRecipientCases,
  generateCategory1Cases,
  generateCategory11Cases,
  generateComparisonCases,
};

export function getLayerECases() {
  return [
    ...generatePaymentBudgetCases(),
    ...generateApprovalLifecycleCases(),
    ...generateAccessIdentityCases(),
    ...generateDelegateGasCases(),
    ...generateTokenRecipientCases(),
  ];
}

export function getLayerEComparisonCases() {
  return generateComparisonCases();
}
