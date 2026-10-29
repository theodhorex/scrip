import test from "node:test";
import assert from "node:assert/strict";
import {
  formatUsdcFixed,
  shortenAccount,
  mapAttackData,
  mapDemoData,
  RACE_DATA,
  HERO_DEMO_DATA,
} from "../src/lib/landing-data.ts";

test("formats 6-decimal USDC units to 2-decimal strings (1400000 -> 1.40)", () => {
  assert.equal(formatUsdcFixed("1400000"), "1.40");
  assert.equal(formatUsdcFixed("1000000"), "1.00");
  assert.equal(formatUsdcFixed("100000"), "0.10");
  assert.equal(formatUsdcFixed("400000"), "0.40");
  assert.equal(formatUsdcFixed("800000"), "0.80");
  assert.equal(formatUsdcFixed("200000"), "0.20");
  assert.equal(formatUsdcFixed("0"), "0.00");
});

test("shortens long NEAR testnet accounts cleanly", () => {
  assert.equal(
    shortenAccount("dmm42992.envtest-theo-1747.testnet"),
    "dmm42992…testnet",
  );
  assert.equal(shortenAccount("shop.testnet"), "shop.testnet");
});

test("verifies real attack.json facts: 30 x 0.10 USDC, budget 1.00, naive 1.40 (+0.40), Amanat 1.00", () => {
  assert.equal(RACE_DATA.network, "testnet");
  assert.equal(RACE_DATA.totalAttempts, 30);
  assert.equal(RACE_DATA.paymentUsdc, "0.10");
  assert.equal(RACE_DATA.budgetUsdc, "1.00");

  assert.equal(RACE_DATA.naive.spentUsdc, "1.40");
  assert.equal(RACE_DATA.naive.overBudgetUsdc, "0.40");
  assert.equal(RACE_DATA.naive.paymentsPaid, 14);
  assert.equal(RACE_DATA.naive.exceededBudget, true);
  assert.equal(RACE_DATA.naive.burstSeconds, "10.1");

  assert.equal(RACE_DATA.amanat.spentUsdc, "1.00");
  assert.equal(RACE_DATA.amanat.overBudgetUsdc, "0.00");
  assert.equal(RACE_DATA.amanat.paymentsPaid, 10);
  assert.equal(RACE_DATA.amanat.exceededBudget, false);
});

test("verifies real demo.json facts: naive loses 0.80 to attacker, Amanat rejects injection & overcharge, attacker +0.00", () => {
  assert.equal(HERO_DEMO_DATA.network, "testnet");
  assert.equal(HERO_DEMO_DATA.fundedUsdc, "1.00");

  assert.equal(HERO_DEMO_DATA.honest.amountUsdc, "0.20");
  assert.equal(HERO_DEMO_DATA.honest.paid, true);

  assert.equal(HERO_DEMO_DATA.injected.amountUsdc, "0.80");
  assert.equal(HERO_DEMO_DATA.injected.paidByNaive, true);
  assert.equal(HERO_DEMO_DATA.injected.paidByAmanat, false);
  assert.equal(HERO_DEMO_DATA.injected.rejectionCode, "RECIPIENT_NOT_ALLOWED");
  assert.ok(HERO_DEMO_DATA.attackerAccount.startsWith("dmx"));

  assert.equal(HERO_DEMO_DATA.overcharge.amountUsdc, "0.60");
  assert.equal(HERO_DEMO_DATA.overcharge.paidByAmanat, false);
  assert.equal(HERO_DEMO_DATA.overcharge.rejectionCode, "OVER_PER_PAYMENT_CAP");

  assert.equal(HERO_DEMO_DATA.naiveAttackerGainedUsdc, "0.80");
  assert.equal(HERO_DEMO_DATA.amanatAttackerGainedUsdc, "0.00");
  assert.equal(HERO_DEMO_DATA.amanatRemainingUsdc, "0.80");
});

test("rejects malformed JSON inputs in mapAttackData and mapDemoData", () => {
  assert.throws(() => mapAttackData([]), /attack\.json/);
  assert.throws(() => mapAttackData([{}]), /attack\.json/);
  assert.throws(() => mapDemoData(null), /demo\.json/);
  assert.throws(() => mapDemoData({}), /demo\.json/);
});
