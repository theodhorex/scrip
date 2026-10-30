# Katalog Pengujian F9 Fasilitator Amanat

Dokumen ini merangkum seluruh katalog uji ketahanan F9 fasilitator: parsing format (Langkah 1), operasional relayer (Langkah 2), serta delegate & verifikasi access key (Langkah 3 / F9b).

---

## 1. Format & Parsing Robustness (`f9-format-parsing.test.mjs`)
- **Jumlah kasus**: 61 subkasus terotomasi
- **Harapan (desain/README)**:
  - Input non-JSON, whitespace, unclosed JSON, string/number/null/boolean literal, dan HTML ditolak dengan HTTP 400 (`BAD_JSON` atau `BAD_REQUEST`).
  - Payload deeply-nested melebihi 16 KB ditolak di boundary HTTP dengan HTTP 413 `BODY_TOO_LARGE`.
  - Base64 borsh rusak, spasi internal, karakter url-safe unpadded, borsh terpotong, string kosong ditolak HTTP 400 `BAD_ENCODING`.
  - Karakter khusus (null byte `\u0000`, RTL override `\u202E`, zero-width space `\u200B`, emoji) ditolak `BAD_ENCODING`.
  - Content-Type bukan JSON pada `/relay` ditolak HTTP 415 `UNSUPPORTED_MEDIA_TYPE`.
  - Header `PAYMENT-SIGNATURE` pada `/verify` dan `/settle` yang hilang, korup, atau raksasa ditolak HTTP 400.
  - HTTP method tidak diizinkan (GET/PUT/DELETE/PATCH pada `/relay`, POST pada `/health`) ditolak HTTP 405 `METHOD_NOT_ALLOWED`.
  - URL traversal, double slash, subpath liar, hash kosong ditolak HTTP 404 / 400.
- **Hasil Nyata**: 61/61 lulus, fail-closed, nol unhandled exception, nol kebocoran stack trace.
- **Temuan**: Batas ukuran body (16 KB) dieksekusi secara ketat sebelum parsing borsh, melindungi proses dari alokasi memori berlebih.

---

## 2. Operasional & Ketahanan Relayer (`f9-operational.test.mjs`)
- **Jumlah kelompok**: 6 kelompok (29 subkasus)
  1. Banjir per IP (limiter): 7 subkasus
  2. Hash tx acak ke `/status/:hash`: 7 subkasus
  3. Saldo relayer rendah: 4 subkasus
  4. RPC lambat, mati, sampah, terpotong: 8 subkasus
  5. Replay setelah restart (dedupe persisten SQLite): 3 subkasus
  6. Ketahanan antrean serial (failing jobs): 1 subkasus
- **Harapan (desain/README)**:
  - Flooding IP dihentikan oleh bucket limiter per-IP dengan HTTP 429 `IP_RATE_LIMITED` dan header `Retry-After`.
  - Hash tx acak/salah ditolak langsung dari local store (HTTP 404 `TX_NOT_FOUND`) tanpa menembak RPC upstream.
  - Saldo relayer <= `minBalance` ditolak `RELAYER_LOW_BALANCE` tanpa submit tx dan tanpa potong token limiter.
  - RPC timeout / connection abort saat broadcast memicu `RELAY_PENDING` (token & dedupe dijaga untuk mencegah double submission).
  - Error deterministik sebelum broadcast memicu `RELAY_FAILED` dan mengembalikan (refund) token limiter agen & global.
  - Replay dedupe persisten di SQLite bertahan melintasi restart relayer dan menolak replay offline.
  - Kegagalan satu job relay tidak memacetkan antrean serial relayer.
- **Hasil Nyata**: Seluruh skenario operasional lulus 100%.
- **Temuan**: Pembedaan error jaringan ambigu vs deterministik (`isAmbiguousFailure`) krusial untuk mencegah double-spend gas saat broadcast mengalami timeout.

---

## 3. Delegate & Verifikasi Access Key (`f9-delegate-keys.test.mjs`)
- **Jumlah kelompok**: 3 kelompok (29 subkasus terdaftar, mencakup 128 evaluasi bit-flip):
  1. Verifikasi Access Key: 8 subkasus
  2. Integritas Tanda Tangan: 4 subkasus (32 bit di signature + 32 bit di payload + 64 bit sweep buffer penuh + key mismatch)
  3. Validasi Delegate & Nonce: 14 subkasus
- **Harapan (desain/README)**:
  - Access key `FullAccess` wajib ditolak `KEY_NOT_ALLOWED`.
  - Access key `FunctionCall` dengan method bukan `request_payment`, method kosong, atau memiliki method asing wajib ditolak `KEY_NOT_ALLOWED`.
  - Access key dengan receiver salah atau allowance 0 wajib ditolak `KEY_NOT_ALLOWED`.
  - Kunci tidak terdaftar (`AccessKeyDoesNotExistError`) atau akun tidak ada (`AccountDoesNotExistError`) ditolak `KEY_NOT_ALLOWED`.
  - Kerusakan 1 bit pada posisi signature wajib 100% menghasilkan `BAD_SIGNATURE`.
  - Kerusakan 1 bit pada posisi payload DelegateAction wajib 100% ditolak fail-closed (0 diterima).
  - Sweep 64 posisi bit flip pada seluruh buffer SignedDelegate wajib 100% ditolak oleh relayer dengan nol submit.
  - Replay delegate persis ditolak `DUPLICATE_DELEGATE` (409) tanpa submit ulang.
  - Delegate nonce <= access key nonce on-chain ditolak `NONCE_TOO_LOW`.
  - Sender bukan testnet / di luar `allowedAgents` ditolak `AGENT_NOT_ALLOWED`.
  - Receiver contract salah ditolak `WRONG_RECEIVER`.
  - MaxBlockHeight kedaluwarsa / terlalu jauh ditolak `EXPIRES_TOO_SOON` / `EXPIRES_TOO_FAR`.
  - Nonce 0 ditolak `NONCE_INVALID`.
  - Nonce u64::MAX (`2^64 - 1`) diterima jika di atas keyNonce.
  - Nonce melebihi `2^64 - 1` pada request_payment args ditolak `BAD_CALL_ARGS`.
  - Nonce `2^64` pada delegateAction mengalami wrap-around modulo 2^64 menjadi 0 dan ditolak `NONCE_INVALID`.
- **Hasil Nyata**: 29/29 subkasus lulus (100% pass), 0 submit liar.
- **Temuan**:
  1. Serialisasi borsh u64 pada `near-api-js` memotong modulo 2^64; nilai `1n << 64n` menjadi `0n`, yang ditangkap fail-closed oleh guard `da.nonce === 0n` sebagai `NONCE_INVALID`.
  2. Kerusakan 1-bit pada signature selalu menghasilkan `BAD_SIGNATURE` via verifikasi ed25519. Kerusakan 1-bit pada payload ditolak bervariasi antara `BAD_ENCODING`, `BAD_SIGNATURE`, atau validasi field spesifik (`AGENT_NOT_ALLOWED`, `WRONG_RECEIVER`, `METHOD_NOT_ALLOWED`, `BAD_CALL_ARGS`, `DEPOSIT_NOT_ZERO`), tanpa satupun lolos.
  3. Modifikasi `facilitator/src/**`: Tidak ada modifikasi yang diperlukan karena implementasi yang ada sudah sepenuhnya aman dan fail-closed.
