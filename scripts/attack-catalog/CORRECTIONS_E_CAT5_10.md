# CORRECTIONS_E_CAT5_10 — expected.code kategori 10 & 5 vs `contracts/amanat/src/lib.rs`

Sumber kebenaran: `contracts/amanat/src/lib.rs` (urutan cek tiap method) dan tabel kode di
`contracts/amanat/README.md` (baris 60-63, 48). Hanya `expected.code` yang diubah; label tidak
pernah diubah. Semua baris di bawah berlabel `BLOCKED` sebelum dan sesudah koreksi.

## Koreksi

| kasus | kode lama | kode baru | bukti (baris lib.rs) | label tidak berubah |
| --- | --- | --- | --- | --- |
| KAT-E-10-03 double revoke | `NOT_ACTIVE` | `ALREADY_REVOKED` | 747: `require(status == Active, err::ALREADY_REVOKED)` di `revoke` | ya (BLOCKED) |
| KAT-E-10-08 withdraw melebihi free | `INSUFFICIENT_FREE_BALANCE` | `AMOUNT_EXCEEDS_FREE` | 770: `require(amount <= free, err::AMOUNT_EXCEEDS_FREE)` | ya (BLOCKED) |
| KAT-E-10-21 resolve_stale belum stale | `REQUEST_NOT_STALE` | `NOT_STALE_YET` | 825: `require(block_height - p.height >= STALE_BLOCKS, err::NOT_STALE_YET)` | ya (BLOCKED) |
| KAT-E-05-15 tighten oleh agent | `UNAUTHORIZED` | `UNAUTHORIZED_OWNER_OR_GUARDIAN` | 660: `require(caller == owner \|\| guardian, err::UNAUTHORIZED_OWNER_OR_GUARDIAN)` | ya (BLOCKED) |
| KAT-E-05-16 tighten oleh stranger | `UNAUTHORIZED` | `UNAUTHORIZED_OWNER_OR_GUARDIAN` | 660 (sama) | ya (BLOCKED) |
| KAT-E-05-19 revoke oleh agent | `UNAUTHORIZED` | `UNAUTHORIZED_OWNER_OR_GUARDIAN` | 746: `require(caller == owner \|\| guardian, err::UNAUTHORIZED_OWNER_OR_GUARDIAN)` | ya (BLOCKED) |
| KAT-E-05-20 revoke oleh stranger | `UNAUTHORIZED` | `UNAUTHORIZED_OWNER_OR_GUARDIAN` | 746 (sama) | ya (BLOCKED) |
| KAT-E-05-69, -72, -74, -76, -77, -78, -84, -97 (seed tighten) | `UNAUTHORIZED` | `UNAUTHORIZED_OWNER_OR_GUARDIAN` | 660 (sama) | ya (BLOCKED) |

Total kasus diubah: **15** (3 kategori 10 + 12 kategori 5).

## Tidak diubah — kode kontrak sudah cocok

Seluruh kasus lain di kedua file sudah cocok dengan urutan cek lib.rs, termasuk:
`NOT_ACTIVE` (507-508, 632, 661, 705), `MANDATE_STILL_ACTIVE` (766), `INSUFFICIENT_GAS` (497, 763),
`NOT_STRICTER`/`NOT_LOOSER` (666/672/677/680/688, 709/714/719/731/733), `BUDGET_BELOW_CAP` (668),
`CAP_BELOW_THRESHOLD` (673), `NO_SUCH_RECIPIENT` (682), `EXPIRY_NOT_IN_FUTURE` (689),
`BUDGET_ABOVE_DEPOSITED` (710), `CAP_ABOVE_BUDGET` (715), `THRESHOLD_ABOVE_CAP` (720),
`DUPLICATE_RECIPIENT` (725), `TOO_MANY_RECIPIENTS` (727), `UNAUTHORIZED_AGENT` (505),
`UNAUTHORIZED_GUARDIAN` (631, 704, 820), `UNAUTHORIZED_OWNER` (765), `OWNER_IS_AGENT` (402),
`GUARDIAN_IS_OWNER` (404), `GUARDIAN_IS_AGENT` (403), `INSUFFICIENT_STORAGE_DEPOSIT` (398),
`INSUFFICIENT_APPROVAL_DEPOSIT` (629), `ALREADY_APPROVED` (636), `TOO_MANY_APPROVALS` (637),
`APPROVAL_NOT_IN_FUTURE` (634), `NEEDS_APPROVAL`/`APPROVAL_USED`/`APPROVAL_EXPIRED` (541-546),
`RECIPIENT_NOT_ALLOWED` (514-515).

## Kode yang bukan `AMANAT_ERR` (dari near-sdk / VM)

| kasus | kode | asal kode | tindakan |
| --- | --- | --- | --- |
| KAT-E-05-29..36 (`on_payment_done`/`on_withdraw_done` eksternal) | `METHOD_IS_PRIVATE` | bukan `AMANAT_ERR`; macro `#[private]` (lib.rs:589, 792) memanggil `panic_str("Method <name> is private")` dari near-sdk-macros-5.30 (`impl_item_method_info.rs:187`) | `classifyTxError` sekarang memetakan teks "is private" ke `METHOD_IS_PRIVATE` (sebelumnya regex generik menangkap "Method") |
| KAT-E-05-49..68 (deposit pada method non-payable) | `METHOD_NOT_PAYABLE` | bukan `AMANAT_ERR`; method tanpa `#[payable]` (lib.rs:489, 657, 701, 743, 818) ditolak near-sdk dengan `panic_str("Method <name> doesn't accept deposit")` (`impl_item_method_info.rs:156`) | `classifyTxError` sekarang memetakan teks "doesn't accept deposit" ke `METHOD_NOT_PAYABLE` |

Catatan & Aturan Penurunan (H4):
Build wasm release (strip=true, opt-level="z") mengubah panic internal near-sdk (method non-payable & private callback) menjadi `WebAssembly trap: An unreachable opcode was executed` tanpa pesan panic utf8 (lihat `.agy/results/D1d-tighten-and-last-four.report.md`).
Untuk mengklasifikasikan kegagalan trap ini secara jujur tanpa melonggarkan penilaian dan tanpa membaca `expected`, ditambahkan fungsi klasifikasi murni `inferVmRejection({ method, deposit, callerIsContractItself, txFailedWithTrap })`:
1. `METHOD_IS_PRIVATE`: hanya bila method adalah `on_payment_done` atau `on_withdraw_done`, pemanggil bukan akun kontrak itu sendiri (`callerIsContractItself === false`), dan tx gagal dengan trap.
2. `METHOD_NOT_PAYABLE`: hanya bila method termasuk set non-payable dari `contracts/amanat/src/lib.rs` (`request_payment`, `withdraw`, `tighten`, `loosen`, `revoke`, `resolve_stale`; hanya `create_mandate` dan `approve_intent` yang `#[payable]`), deposit terlampir > 0, dan tx gagal dengan trap.
3. Di luar kondisi tersebut, hasil tetap `TX_FAILED`.
Bukti keadaan: setelah kasus dieksekusi, snapshot mandate (`spent`, `reserved`, status) dan saldo merchant diverifikasi tidak bermutasi (`detectMandateBreach`), membuktikan penolakan tuntas. Catatan kasus menyertakan: "kode diturunkan dari bentuk panggilan karena wasm rilis tidak mengeluarkan pesan panic".

Keterbatasan penurunan ini:
- Mengasumsikan trap yang terjadi pada method non-payable berdeposit > 0 atau private callback eksternal dipicu oleh guard near-sdk; bila terjadi trap VM lain (misal out-of-gas ekstrem sebelum method guard), klasifikasi tetap mengidentifikasikannya sebagai penolakan method guard.
- Bergantung pada metadata pemanggilan (nama method, deposit, identitas pemanggil) dan konfirmasi status Failure on-chain, bukan string error langsung dari VM.

## Temuan (tidak diubah, sesuai batas tugas)

| kasus | harapan lama | menurut kontrak | alasan tidak diubah |
| --- | --- | --- | --- |
| KAT-E-05-09 loosen Budget 1500000 oleh guardian | `INERT` / null | `BLOCKED` / `BUDGET_ABOVE_DEPOSITED` (710), karena deposited = 1250000 (testnet.mjs:717/803) | label harus berubah INERT -> BLOCKED; tugas melarang mengubah label |
| KAT-E-10-20 loosen recipient ke-17 | `BLOCKED` / `TOO_MANY_RECIPIENTS` | dengan setup nyata (1 recipient) penambahan ke-2 diterima -> `INERT` (723-729); `TOO_MANY_RECIPIENTS` hanya bila list sudah 16 | setup 16 recipient tidak ada; kode untuk kondisi "ke-17" sudah benar, jadi data tidak diubah |
| KAT-E-10-21 resolve_stale belum stale | `BLOCKED` / `NOT_STALE_YET` (setelah koreksi) | tanpa `Pending`, cek 822 (`NO_SUCH_PENDING`) mendahului 825 | state prep pending/stale belum ada; kode kondisi "belum stale" sudah benar |
| KAT-E-05-25 resolve_stale oleh guardian | `INERT` / null | tanpa pending/stale: `NO_SUCH_PENDING` (822) atau `NOT_STALE_YET` (825) | label harus berubah INERT -> BLOCKED; tugas melarang |
