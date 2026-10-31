# Catatan Koreksi Harapan Katalog - Bagian A2B (11 Kelas B + 12 Kelas A)

Dokumen ini mencatat (1) perbaikan harness/definisi kasus Kelas B tanpa mengubah `expected`, dan (2) koreksi `expected` 12 kasus Kelas A sisa. Setiap perubahan dirujuk ke kode yang menanganinya.

## 1. Kelas B - perbaikan harness (expected TIDAK diubah)

| ID | Masalah | Perubahan | Bukti (berkas:baris) |
|---|---|---|---|
| `KAT-B-05-109/110/111` | `node:http.request` mengapitalkan `post`/`Post`/`pOsT` menjadi `POST`, sehingga body dummy yang ditolak (`BAD_ENCODING`), bukan verb-nya. | Kasus memakai `rawRequest: true`; harness mengirim request line mentah via `net.Socket`. | `cases/b2_extra.mjs:49-51`, `layers/facilitator.mjs:235,308-311` |
| `KAT-B-12-102` | `new URL()` menormalkan `/relay/../relay` menjadi `/relay`. | Kasus memakai `rawRequest: true`; request-target ditulis apa adanya. | `cases/b2_extra.mjs:837`, `layers/facilitator.mjs:235` |
| `KAT-B-09-02..05` | Runner memajukan jam +5 s per kasus, mengisi ulang token bucket; kasus bergantung pada flood kasus sebelumnya. | Tiap kasus menambahkan `floodCount: 25` sendiri. | `cases/category_9.mjs:35,47,58,69`, `layers/facilitator.mjs:379-383` |
| `KAT-B-09-130/131/132` | `/verify` menolak lebih dulu karena `payment-signature` tidak ada, sehingga `get_mandate` tak pernah dipanggil. | Harness membangun header x402 valid (delegate ed25519 asli + requirements cocok) saat `paymentSignature: true`; body dummy dihilangkan. | `cases/b2_extra.mjs:731,738,745`, `layers/facilitator.mjs:359-379`, `facilitator/src/server.mjs:142-170` |

## 2. Kelas A - koreksi `expected` (12 kasus)

| ID | Masalah | Perubahan | Bukti (berkas:baris) |
|---|---|---|---|
| `KAT-B-12-119/120/121` | llhttp menolak verb `BREACH`/`ATTACK`/`HACK` sebelum handler (400 mentah). | `METHOD_NOT_ALLOWED` -> `HTTP_400`. | `facilitator/src/server.mjs:310,365`, `layers/facilitator.mjs:427` |
| `KAT-B-08-114/115` | Body kosong/whitespace gagal `JSON.parse` dan mengembalikan `BAD_JSON`. | `BAD_REQUEST` -> `BAD_JSON`. | `facilitator/src/server.mjs:78-82` |
| `KAT-B-08-147` | Null byte mentah di dalam string JSON adalah galat sintaks RFC 8259 -> `BAD_JSON`. | `BAD_ENCODING` -> `BAD_JSON`. | `facilitator/src/server.mjs:79-81` |
| `KAT-B-12-135` | `Content-Length` + `Transfer-Encoding` konflik ditolak llhttp dengan 400 mentah. | `BAD_REQUEST` -> `HTTP_400`. | `facilitator/src/server.mjs:310`, `layers/facilitator.mjs:427` |
| `KAT-B-12-130` | Header 10 KB masih di bawah batas 16 KB Node, jadi body divalidasi dan ditolak `BAD_ENCODING`. | `REQUEST_HEADER_FIELDS_TOO_LARGE` -> `BAD_ENCODING`. | `facilitator/src/server.mjs:67-90`, `facilitator/src/validate.mjs:89-91` |
| `KAT-C-08-11` | JSON bersarang 1500 level di-parse V8 tanpa crash; parser mengembalikan objek aman `ok=false`. | `BLOCKED (RangeError)` -> `INERT`. | `client/src/payment.mjs:147-181`, `client/src/payment.mjs:9-29` |
| `KAT-C-08-25` | Base64 rusak di header `payment-response` diabaikan; fallback ke objek respons aman. | `BLOCKED (RangeError)` -> `INERT`. | `client/src/payment.mjs:159-181` |
| `KAT-C2-08-12` | Null byte mentah dalam string JSON ditolak `JSON.parse`; parser membungkusnya sebagai `RangeError`. | `INERT` -> `BLOCKED (RangeError)`. | `client/src/payment.mjs:154-157`, RFC 8259 |
| `KAT-C2-12-11` | Root array `[]` membuat `input.mandateId` `undefined`; `toU64` melempar `TypeError` (tipe salah). | `BLOCKED (RangeError)` -> `BLOCKED (TypeError)`. | `client/src/intent.mjs:21-31,72-74` |

### Fail-closed untuk perubahan label RangeError <-> INERT

- `KAT-C-08-11` dan `KAT-C-08-25`: hasilnya `INERT` karena input tidak mengubah state dan tidak memicu eksekusi; parser tetap mengembalikan `ok=false`/`success=false`. Tidak ada jalur sukses palsu.
- `KAT-C2-08-12`: `RangeError` dilempar sebelum objek hasil dipakai, jadi penolakan tetap fail-closed.
- `KAT-C2-12-11`: `TypeError` dilempar `toU64` sebelum hash dibuat; tidak ada intent/hash yang dihasilkan, tetap fail-closed.

## 3. Ditunda

Tidak ada kasus yang ditunda. Seluruh 12 kasus Kelas A dalam lingkup telah diverifikasi terhadap kode nyata.

## 4. Hasil eksekusi (nyata)

- Layer B (`--layers B`): 369 kasus, **PASS 363 / FAIL 6 / BREACH 0 / SKIPPED 0**.
  - PASS setelah perbaikan: `KAT-B-12-102`, `KAT-B-09-02..05`, dan seluruh 8 kasus Kelas A sisi-B (`08-114/115/147`, `12-119/120/121`, `12-130`, `12-135`).
  - FAIL yang tersisa: `KAT-B-05-109..111` (actual `HTTP_400`, expected `METHOD_NOT_ALLOWED`) dan `KAT-B-09-130..132` (actual `UPSTREAM_ERROR`/`MANDATE_NOT_FOUND`/`ASSET_MISMATCH`, expected `BAD_REQUEST`).
- Layer C (`--layers C`): 317 kasus, **PASS 317 / FAIL 0 / BREACH 0 / SKIPPED 0**.
- Enam FAIL Layer B di atas bukan artefak harness lagi: harness sudah mengirim verb mentah / header x402 valid. Kode aktual lebih spesifik daripada `expected` desain. Sesuai instruksi "tanpa mengubah expected" untuk Kelas B, nilai itu tidak diubah dan dilaporkan apa adanya; koreksi `expected`-nya perlu keputusan PM (bukan bagian 12 kasus Kelas A task ini).
