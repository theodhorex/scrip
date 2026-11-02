# scrip_naive (negative control)

Single-mandate comparator used by the attack demos. With the default `naive` feature it checks the budget but only deducts
it in the callback, so concurrent requests can overrun the budget (measured on testnet: 1.50 USDC paid against a 1.25 budget).
It derives from the pre-hackathon S2 spike and is declared as such. Never deploy it for real funds.
`cargo build --release --target wasm32-unknown-unknown` (default features = naive).
