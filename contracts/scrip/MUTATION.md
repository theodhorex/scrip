# Mutation testing: `contracts/scrip/src/lib.rs`

Clean rerun, 10 to 12 Nov 2026 (the October run is superseded). Results are from `cargo mutants` output, not hand-edited.

## Result

| Outcome | Mutants |
|---|---|
| Total generated | 198 |
| Caught (a test failed) | 176 |
| Missed (all tests passed) | 1 |
| Timeout (not decided) | 0 |
| Unviable (did not compile) | 21 |
| Not tested | 0 |

Mutation score on decided viable mutants: **176/177 = 99.4%** (unviable excluded as they cannot be run).

## How it was run (honest account)

- Tool: `cargo mutants` on `lib.rs`, tests = `cargo test --lib` (138 unit and property tests), in a copy of the repo tree because the tests read `docs/vectors/`. Baseline: 138 tests pass on the unmutated tree.
- It was one logical run split across three invocations of `cargo mutants --iterate`: the first was stopped after about 106 mutants (owner left the machine), the later ones resumed and skipped mutants already caught or unviable.
- Under heavy CPU load, 5 to 7 mutants in `request_payment` and `approve_intent` hit the 300 s timeout. They were re-run with longer timeouts (600 s, then 900 s) and every one was caught. Timeouts were never counted as caught.
- Integration tests (`tests/`) need a prebuilt `ft_mock.wasm` and are not part of this mutation run.

## Missed mutants

- `contracts/scrip/src/lib.rs:331:40: replace | with ^ in from_hex32` **(equivalent mutant)**

An equivalent mutant cannot be killed by any test: in `from_hex32` the high nibble is shifted left by 4 bits, so its low bits are zero and `|` and `^` give the same result.

## Timeouts

None remaining.

## Not tested

None.

## Reproduce

```bash
scripts/mutants.sh        # from the repo root; takes about two hours on a 12-core laptop
```
