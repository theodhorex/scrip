# Video script (under 3 minutes) - draft for Theo to record

Record the landing page (`web/`) plus a terminal for the testnet links. Every number below comes from `results/`; show the file or the explorer link when saying it.

| Time | On screen | Say |
|---|---|---|
| 0:00-0:20 | Hero: the agent is hijacked, the payment swings toward the attacker | "An AI agent with a full key can be talked into paying anyone. In our demo, a naive agent paid 0.8 of its 1.0 USDC to an attacker after one injected line." (`results/demo.json`, naive tx link) |
| 0:20-1:00 | Hero again, then the rule machine: send to an unknown recipient | "With Scrip the agent holds a key that can only call one method. The contract checks the recipient, the per-payment cap and the budget. The same injected payment is rejected: RECIPIENT_NOT_ALLOWED, and the funds stay." (Scrip tx link, `rejected` event) |
| 1:00-1:50 | The race: naive 1.40, Scrip 1.00 | "We fired 30 pre-signed payments of 0.1 in about ten seconds against a 1.0 budget. The naive contract paid 1.4. Scrip stopped at exactly 1.0, because it reserves before it transfers." (`results/attack.json`) |
| 1:50-2:30 | Guardian chapter, then the proof timeline | "A guardian can tighten at any time but can only loosen inside safe bounds, and large payments need an approval tied to the exact payment. Here is the full lifecycle on testnet: deploy, fund, pay, five refused attacks, revoke, withdraw, and no leftover accounts." (`results/gate.json`, explorer links) |
| 2:30-3:00 | README "What does not exist yet" | "Honest limits: testnet only, no third-party audit, and the demo agent is a script, not an LLM. Keys can be stolen. Funds can't, beyond the budget you set." Show the repo link. |

Notes: do not say "first" or "only"; do not show market numbers. Keep the English captions on. Rehearse once so the hero loop lands on the rejection around 0:40.
