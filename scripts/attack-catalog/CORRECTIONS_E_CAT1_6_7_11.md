# CORRECTIONS_E_CAT1_6_7_11: harness and expected.code vs `facilitator/src/*.mjs` and `lib.rs`

Bukti PM: `.agy/catalog-out/final2/wave{7,8,9}.json` (BREACH = 0). Semua temuan di bawah adalah FAIL harness/spesifikasi,
bukan kebocoran. Label (BLOCKED/INERT) tidak diubah pada satu pun kasus. Tidak ada jaringan yang dipakai di pekerjaan ini;
bukti berupa tes offline `test/relay-attack.test.mjs` yang menjalankan kode fasilitator asli.

## (A) Kategori 6: serangan tidak pernah dikirim

Akar (dibuktikan dari kode): cabang relay `executeLayerE` (`layers/testnet.mjs`, sebelum perbaikan sekitar baris 2238-2283) hanya
membaca `forgedKey`, `senderId`, `nonce`, `gas`, `method`, `args`. Parameter `keyAllowedMethods`, `keyType`, `keyAllowance`,
`keyReceiverId`, `delegateReceiverId`, `maxBlockHeight`, `actionsCount`, `invalidSignature` diabaikan; `maxBlockHeight` selalu
head+100, receiver selalu kontrak, satu action, kunci selalu `agent.fcKey` yang sah. Delegate yang sah dirilis, hasil
"Transaction confirmed" = INERT (KAT-E-06-01..08, 12, 13, 16, 17). Kasus seeded 18..45 bahkan tidak punya parameter serangan sama sekali.

Perbaikan: `layers/relay_attack.mjs` (`planRelayAttack`, `buildAttackDelegate`) menerapkan setiap parameter dan gagal tertutup bila
parameter rusak; kunci yang diserang dibuat sungguhan di akun agen (`addFunctionCallAccessKey` / `addFullAccessKey`); bila gagal
dibuat atau nonce kunci tak terbaca, kasus `SKIPPED` (bukan verdict). Keputusan tetap di fasilitator `/relay`. Kasus seeded diberi
parameter serangan sesuai judulnya.

| kasus | kode lama | kode baru | bukti |
| --- | --- | --- | --- |
| 06-01..03 key method lain | `KEY_NOT_ALLOWED` | sama | keycheck.mjs:13 (`method_names.every(in allowedMethods)`) |
| 06-04 FullAccess | `KEY_NOT_ALLOWED` | sama | keycheck.mjs:10-11 (`'FullAccess'` bukan objek FunctionCall) |
| 06-05 allowance 0 | `KEY_NOT_ALLOWED` | sama | keycheck.mjs:14-16 |
| 06-06 key receiver usdc | `RECEIVER_NOT_ALLOWED` | `KEY_NOT_ALLOWED` | keycheck.mjs:11 (`receiver_id !== contractId`); `RECEIVER_NOT_ALLOWED` tidak ada di fasilitator |
| 06-07, 06-08 receiver delegate lain | `RECEIVER_NOT_ALLOWED` | `WRONG_RECEIVER` | validate.mjs:98 |
| 06-11 kunci acak (forged) | `INVALID_SIGNATURE` | `KEY_NOT_ALLOWED` | tanda tangan sah, kunci tak ada di akun: keycheck.mjs:60-66; hasil nyata wave7 juga `KEY_NOT_ALLOWED` |
| 06-12 payload diubah setelah tanda tangan | `INVALID_SIGNATURE` | `BAD_SIGNATURE` | validate.mjs:134. Catatan: bit flip nama method kena `METHOD_NOT_ALLOWED` (validate.mjs:102) lebih dulu, jadi yang diubah field nonce |
| 06-13 maxBlockHeight lampau | `EXPIRED_DELEGATE` | `EXPIRES_TOO_SOON` | validate.mjs:84, dipanggil dari relay.mjs:201 |
| 06-14 nonce 1 | `INVALID_NONCE` | `NONCE_TOO_LOW` | relay.mjs:224-225; hasil nyata wave7 sama |
| 06-15 nonce 0 | `INVALID_NONCE` | `NONCE_INVALID` | validate.mjs:121; hasil nyata wave7 sama |
| 06-16, 06-17 0 / 2 action | `ACTION_NOT_ALLOWED` | `WRONG_ACTION_COUNT` | validate.mjs:99 |
| 06-09, 06-10 agen mandat lain | `UNAUTHORIZED_AGENT` | sama | lib.rs:505 (sudah PASS di wave7) |
| seeded: forged signature | `INVALID_SIGNATURE` | `BAD_SIGNATURE` (param `invalidSignature`) | validate.mjs:134 |
| seeded: expired | `EXPIRED_DELEGATE` | `EXPIRES_TOO_SOON` (param `maxBlockHeight: 100`) | validate.mjs:84 |
| seeded: nonce | `INVALID_NONCE` | `NONCE_TOO_LOW` (param `nonce: 1`) | relay.mjs:225 |
| seeded: cross-mandate | `UNAUTHORIZED_AGENT` | sama (param `agentIndex` 1/2, mandate 1) | lib.rs:505 |

Urutan cek fasilitator yang dipakai (menentukan kode saat beberapa kondisi sekaligus salah): validate.mjs:95-134 (offline) ->
dedupe -> expiry (relay.mjs:201) -> keycheck (relay.mjs:213-219) -> nonce (relay.mjs:224).

## (B) Kategori 7: nama kode gas

Fasilitator menolak gas di `validate.mjs:105` (`GAS_TOO_LOW`) dan `:106` (`GAS_TOO_HIGH`), sebelum kontrak dipanggil. Expected
`INSUFFICIENT_GAS` / `EXCEEDS_MAX_GAS` diganti `GAS_TOO_LOW` / `GAS_TOO_HIGH` untuk seluruh KAT-E-07 (jalur relay). `INSUFFICIENT_GAS`
tetap benar sebagai kode KONTRAK (`lib.rs:497`, panggilan langsung) dan tidak diubah di `README`/`REPORT`/`IT_REPORT`
kontrak, `approval_lifecycle.mjs:326` maupun `comparison.mjs`. `grep -r INSUFFICIENT_GAS` pada `web/`, `client/`, `facilitator/`: tidak ada
pemakai nama lama untuk jalur relay.

## (C) Kategori 1: huruf besar dan karakter ilegal

`validate.mjs:50-51` (`ACCOUNT_RE` = huruf kecil/angka dengan `-_.`, panjang <= 64) menolak recipient dengan `BAD_CALL_ARGS` (HTTP 400)
sebelum allowlist mandat (yang hanya ada di kontrak, `lib.rs:514`). Expected diubah ke `BAD_CALL_ARGS` untuk KAT-E-01-06 (huruf besar),
-07 (campuran), -08/-09 (spasi), -10 (tab), -11 (homoglyph Cyrillic), -16 (string kosong). Recipient yang bentuknya sah (subakun, 64-hex,
akun tak ada, seeded) tetap `RECIPIENT_NOT_ALLOWED` karena lolos `ACCOUNT_RE` dan ditolak kontrak. KAT-E-01-14.. SKIPPED INFRA_ERROR 502:
hanya perlu rerun, tidak diubah.

## (D) Kategori 11: ft_on_transfer

Akar: `ft_on_transfer` TIDAK pernah panic dan tidak punya kode `INVALID_TOKEN`, `ZERO_AMOUNT`, `MANDATE_NOT_FOUND`, `NOT_ACTIVE`,
`INVALID_MSG`. Pesan parse gagal (`lib.rs:464-466`), mandat tak ada (`468-470`), `m.token != predecessor || m.owner != sender_id ||
status != Active` (`471-473`), overflow (`474-480`) semuanya mengembalikan jumlah penuh sebagai "unused" tanpa event (doc `455-456`).
Maka transaksi selalu "confirmed"; harness lama menyebutnya INERT padahal dana dikembalikan penuh.

Perbaikan:
- (i) Kasus dengan pemanggil palsu (`fake_usdc`, `malicious_token`, `counterfeit_token_*`): nama itu jatuh ke akun stranger yang nyata
  (`getCallerAccount`), sehingga stranger memanggil `ft_on_transfer` langsung, predecessor != token (`lib.rs:471`). `classifyFtOnTransfer`
  menyatakan BLOCKED/`FULL_REFUND` hanya bila nilai kembali == amount, tidak ada event `deposited`, dan state mandat tidak berubah;
  deposit atau state berubah menjadi INERT/BREACH. Expected semua baris BLOCKED di kategori 11 menjadi `FULL_REFUND`; cabang asli disimpan di
  `params.refundReason` (untuk tes Rust).
- (ii) Kasus pemanggil `usdc.testnet` (token sah: amount 0, mandat tak ada, revoked, msg rusak, dan KAT-E-11-01 funding sah) tidak bisa
  dijalankan langsung karena predecessor harus kontrak token. Di lapis E sekarang `SKIPPED` / `REQUIRES_TOKEN_CALLER`, tidak dihitung lulus.
  Catatan: KAT-E-11-01 sebelumnya "PASS" secara kebetulan (stranger menerima refund, bukan deposit).

## Dicakup di luar testnet

Cabang `ft_on_transfer` di (ii) dibuktikan oleh tes Rust: `contracts/amanat/src/tests.rs` bagian `// ---------- ft_on_transfer ----------`
(baris 331 dst., termasuk msg bukan JSON baris 371) dan `contracts/amanat/src/attack_tests4.rs` (KAT-A-11-01..66: token palsu 66, sender
bukan owner 106, mandat tak ada 146, msg rusak 182, amount nol 229, mandat revoked 272; evaluator `evaluate_ft_on_transfer_inert` di
`attack_tests.rs:280` menuntut refund penuh dan state tak berubah). Ini bukti tidak langsung; tidak ada klaim lulus lapis E.

## Tes

`test/relay-attack.test.mjs` (18 tes, positif dan negatif): tiap parameter serangan diterapkan lalu dijalankan melalui
`validateSignedDelegate`, `checkExpiry`, `createKeyVerifier` fasilitator asli; kontrol negatif (delegate sah lolos, parameter rusak throw,
refund parsial/state berubah tidak pernah BLOCKED); invariants katalog (setiap kasus kategori 6 punya parameter serangan dan kode yang bisa
dihasilkan fasilitator).
