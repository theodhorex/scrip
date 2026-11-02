# Mutation testing: `contracts/scrip/src/lib.rs`

Generated 2026-10-30 16:48 by `.agy/mutation/report.py` from the saved cargo-mutants results.

## Result

| Outcome | Mutants |
|---|---|
| Total generated | 197 |
| Caught (a test failed) | 175 |
| Missed (all tests passed) | 1 |
| Timeout (not decided) | 0 |
| Unviable (did not compile) | 21 |
| Not tested | 0 |

Mutation score on decided viable mutants: **175/176 = 99.4%** (timeouts and untested excluded; unviable excluded as they cannot be run).

## How it was run (honest account)

- Tool: `cargo mutants` on `lib.rs`, tests = `cargo test --lib` (unit and property tests), `--timeout 120`, 2 jobs, in a copy of the repo tree because the tests read `docs/vectors/`.
- The first run (`out/`) was interrupted by a laptop reboot after 183 of 197 mutants; its partial results were saved in the project folder.
- A second run (`out2/`, `--timeout 300`) re-ran the 14 untested mutants and the 25 that timed out under heavy CPU load. The final status above takes the second run when it exists.
- This is therefore a merge of two runs, not one clean run. A clean full rerun is planned after the code freeze.

## Missed mutants

- `contracts/scrip/src/lib.rs:322:40: replace | with ^ in from_hex32` **(equivalent mutant)**

An equivalent mutant cannot be killed by any test: in `from_hex32` the high nibble is shifted left by 4 bits, so its low bits are zero and `|`, `^` and `+` give the same result.

## Timeouts

None.

## Not tested

None.

## Reproduce

```bash
scripts/mutants.sh        # from the repo root; takes about two hours on a 12-core laptop
```
