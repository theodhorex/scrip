# AUDIT_3: Amanat Contract + Facilitator + Client (Round 3, Post-v1.3 Changes)

**Tanggal:** 30 Oktober 2026  
**Cakupan Audit:**
1. Kontrak: `contracts/amanat/src/lib.rs` (921 baris), `tests.rs`, `property_tests.rs` (K-A, K-B, K-C, N-L5, reservasi, callback, resolve_stale, integer math, predecessor access).
2. Fasilitator: `facilitator/src/*.mjs` (`store.mjs`, `inner_status.mjs`, `validate.mjs`, `relay.mjs`, `server.mjs`, `keycheck.mjs`, `policy.mjs`).
3. Klien: `client/src/payment.mjs` (`parsePaymentResponse`, base64/base64url decoding).
4. Dokumentasi & Spesifikasi: `docs/PROPERTIES.md`, `contracts/amanat/README.md`.

**Verifikasi Eksekusi:**
- Kontrak: `cargo test --lib` -> 112 lulus, 0 gagal, 2 diabaikan (`#[ignore]` N-L5).
- Fasilitator & Klien: `node --test` -> 91 lulus, 0 gagal.

**Ringkasan Temuan:**  
Total: 0 Kritis, 0 Tinggi, 3 Sedang, 2 Rendah, 3 Info.  
Status audit: **AMAN UNTUK TESTNET & DEMO**, dengan catatan hardening operasional fasilitator dan perbaikan parser klien.

---

## 1. Verifikasi Perubahan v1.3 (Yang Sudah Benar)

- **K-A (`tighten` menjaga hierarki batas)**: **TERBUKTI BENAR**.
  - `tighten(Budget)` menolak nilai di bawah `spent + reserved` (`BUDGET_BELOW_COMMITTED`) dan di bawah `per_payment_cap` (`BUDGET_BELOW_CAP`, `lib.rs:643`).
  - `tighten(PerPaymentCap)` menolak nilai di bawah `approval_threshold` (`CAP_BELOW_THRESHOLD`, `lib.rs:648`).
  - `tighten(ApprovalThreshold)` hanya menurunkan nilai threshold.
  - Invarian `budget >= per_payment_cap >= approval_threshold` terbukti terjaga dalam segala kombinasi operasi acak (`property_tests.rs: p4_tighten_never_loosens`).
- **K-B (`OWNER_IS_AGENT` & `refund_excess`)**: **TERBUKTI BENAR & TIDAK BISA DIKURAS**.
  - `create_mandate` memverifikasi `owner != agent` (`lib.rs:389`), `guardian != agent`, dan `guardian != owner`.
  - `refund_excess(to, keep)` (`lib.rs:862-868`) menghitung `attached.saturating_sub(keep)`. Karena dana yang dikembalikan berasal langsung dari `env::attached_deposit()` transaksi saat itu dan ditransfer ke `predecessor_account_id()` (`owner` pada `create_mandate`, `guardian` pada `approve_intent`), kontrak tidak pernah mengembalikan lebih dari deposit yang baru masuk. Saldo NEAR kontrak tetap bertambah sebesar `keep`.
- **K-C (`TOO_MANY_APPROVALS`)**: **TERBUKTI BENAR**.
  - `approvals_count` dibatasi maksimal 512 entri per mandat (`lib.rs:612`). Panggilan ke-513 panik dengan `TOO_MANY_APPROVALS`. Pertumbuhan state kontrak terikat aman.
- **F-A (Persistent Dedupe Store SQLite)**: **TERBUKTI BENAR**.
  - Tabel `delegates` di `.facilitator.db` menggunakan `hash` sebagai PRIMARY KEY.
  - Pengecekan `store.get(dh)` dan `store.set(...)` di `relay.mjs:250-255` berlangsung sinkron tanpa jeda `await` di event loop Node.js, mencegah balapan antar-permintaan paralel.
  - Pruning otomatis membuang entri dengan `max_block_height < lastHeight` (kadaluwarsa on-chain) dan membatasi ukuran maksimal (`dedupeMax = 10_000`).
- **F-B & F-C (Inner Status & Nonce Check)**: **TERBUKTI BENAR**.
  - `extractInnerStatus` mengekstrak `Settled`, `Refunded`, `Rejected`, dan `Reserved` secara akurat dari `EVENT_JSON` dan `AMANAT_ERR:`.
  - Delegate nonce wajib berada di atas nonce on-chain (`k.nonce >= v.nonce` ditolak `NONCE_TOO_LOW`).
  - Fasilitator menolak siaran jika saldo relayer di bawah `minBalance` (`RELAYER_LOW_BALANCE`).
- **F-D & F-E (Operasional & Endpoint x402)**: **TERBUKTI BENAR**.
  - Logging terstruktur JSON tanpa membocorkan body transaksi, kunci privat, atau rahasia (`server.mjs:94, 159, 233`).
  - Endpoint `/verify`, `/settle`, `/supported`, `/status/:hash`, `/metrics`, dan `/health` berfungsi sesuai spesifikasi PRD v1.3.

---

## 2. Temuan Baru (New Findings)

### N3-M1 [SEDANG] Endpoint `/status/:hash` tanpa IP Rate Limiter dan memicu amplifikasi RPC NEAR untuk hash arbitrer.
- **Status:** TERBUKTI (analisis kode).
- **Jalur:** `facilitator/src/server.mjs:314-321`, `facilitator/src/relay.mjs:161-179`.
- **Skenario Serangan:**
  1. Penyerang membanjiri `GET /status/<random_tx_hash>` ribuan kali per detik dari satu atau banyak koneksi.
  2. Rute `/status/:hash` di `server.mjs` tidak memanggil `ipLimiter.tryTake(clientIp(req))` (berbeda dengan `/relay`, `/verify`, dan `/settle`).
  3. `relayer.getTxStatus(txHash)` memeriksa `store.getByTxHash(txHash)`. Jika `local == null` (hash tidak dikenal), fungsi tetap melanjutkan dengan memanggil `provider.viewTransactionStatusWithReceipts` ke node RPC upstream.
  4. Akibatnya, kuota RPC NEAR fasilitator terkuras cepat hingga terkena HTTP 429 dari provider RPC, menyebabkan kelumpuhan layanan (`UPSTREAM_ERROR`) bagi seluruh agen yang sah.
- **Saran Perbaikan:**
  1. Pasang `ipLimiter.tryTake(clientIp(req))` pada handler rute `/status/:hash` di `server.mjs`.
  2. Jika `local == null` (transaksi tidak pernah direlay oleh fasilitator ini), langsung kembalikan 404 `TX_NOT_FOUND` tanpa menyentuh RPC NEAR upstream.

### N3-M2 [SEDANG] Pemanggilan status RPC pada `getTxStatus` tidak dilindungi batas waktu (`withTimeout`), berisiko hanging koneksi.
- **Status:** TERBUKTI (analisis kode).
- **Jalur:** `facilitator/src/relay.mjs:163-179`.
- **Skenario Serangan:**
  1. Node RPC NEAR mengalami kemacetan jaringan atau socket hang saat menangani query `viewTransactionStatusWithReceipts` dengan parameter `waitUntil: 'FINAL'`.
  2. Berbeda dengan panggilan `viewBlock` (`relay.mjs:84`) dan `relayMetaTransaction` (`relay.mjs:258`) yang dibungkus `withTimeout(..., rpcTimeoutMs)`, panggilan di dalam `getTxStatus` dieksekusi tanpa pembungkus timeout.
  3. Permintaan HTTP klien ke fasilitator menggantung tanpa batas waktu, menahan slot in-flight dan file descriptor hingga server kehabisan sumber daya.
- **Saran Perbaikan:**
  Bungkus panggilan `provider.viewTransactionStatusWithReceipts` dan `provider.txStatus` dengan `withTimeout(..., rpcTimeoutMs)`.

### N3-M3 [SEDANG] `parsePaymentResponse` salah mengidentifikasi respon transaksi valid `status: "FINAL"` sebagai kegagalan pembayaran.
- **Status:** TERBUKTI (diverifikasi via Node.js REPL).
- **Jalur:** `client/src/payment.mjs:192-195`.
- **Skenario Serangan:**
  1. Klien atau merchant memanggil `getTxStatus(txHash)` dan memperoleh objek respon transaksi on-chain: `{ ok: true, tx_hash: '...', status: 'FINAL', inner_status: 'Settled' }`.
  2. Objek ini dimasukkan ke `parsePaymentResponse(resp)`.
  3. Baris 192 memeriksa: `const isOk = obj.ok !== false && (obj.status === undefined || obj.status === 200 || obj.status === 201);`.
  4. Karena `obj.status` adalah string `'FINAL'`, ekspresi `(obj.status === undefined || obj.status === 200 || obj.status === 201)` bernilai `false`.
  5. Akibatnya, `parsePaymentResponse` mengembalikan `{ ok: false, success: true, code: 'PAYMENT_FAILED' }`.
  6. Sistem klien menganggap pembayaran gagal dan membatalkan pesanan, meskipun di blockchain transaksi sudah final dan dana pedagang sudah diterima.
- **Saran Perbaikan:**
  Perbaiki evaluasi `isOk` agar status non-numerik (seperti `'FINAL'`) tidak dianggap sebagai HTTP error code:
  `const isOk = obj.ok !== false && (typeof obj.status !== 'number' || obj.status === 200 || obj.status === 201);`.

### N3-L1 [RENDAH] Logika dekoder Base64URL pada `validate.mjs` dan `payment.mjs` gagal mendecode string unpadded alfanumerik.
- **Status:** TERBUKTI (diverifikasi via Node.js REPL).
- **Jalur:** `facilitator/src/validate.mjs:251-255`, `client/src/payment.mjs:21-25`.
- **Skenario Serangan:**
  1. Klien x402 eksternal mengirim header `PAYMENT-SIGNATURE` atau membaca `PAYMENT-RESPONSE` yang di-encode menggunakan base64url tanpa padding (standar RFC 7515).
  2. Jika string base64url kebetulan hanya terdiri atas karakter alfanumerik (tidak memuat `-` atau `_`, contoh: `"eyJhIjoxfQ"` untuk `{"a":1}` dengan panjang 10), regex `B64` bernilai `true` (`/^[A-Za-z0-9+/]+={0,2}$/`).
  3. Kondisi `if (B64_URL.test(s) && !B64.test(s))` menghasilkan `false`.
  4. String tidak ditambahkan padding `=`, sehingga `b64.length % 4 !== 0` terpenuhi dan fungsi langsung mengembalikan `null`.
  5. Fasilitator menolak permintaan sah dengan kode `BAD_PAYMENT_SIGNATURE` atau klien melempar `RangeError`.
- **Saran Perbaikan:**
  Hapus syarat `!B64.test(s)` untuk normalisasi padding:
  ```javascript
  let b64 = s.replace(/-/g, '+').replace(/_/g, '/');
  while (b64.length % 4 !== 0) b64 += '=';
  ```

### N3-L2 [RENDAH] Bug N-L5: `promise_result_checked(0, 1024)` menyebabkan desinkronisasi akuntansi jika token FT mengembalikan data >1024 byte.
- **Status:** TERBUKTI (pada token non-standar; saat ini diabaikan pada `tests.rs:1814, 1828`).
- **Jalur:** `contracts/amanat/src/lib.rs:574, 765`.
- **Skenario Serangan:**
  1. Kontrak diintegrasikan dengan token NEP-141 kustom yang mengembalikan data receipt/metadata >1024 byte pada `ft_transfer`.
  2. `env::promise_result_checked(0, 1024).is_ok()` mengembalikan `false`.
  3. Pada `on_payment_done`, transfer yang sebenarnya sukses di token contract dianggap gagal; `reserved` dibebaskan kembali ke budget tanpa mencatat `spent`. Dana fisik kontrak berkurang, tetapi pembukuan kontrak menganggap dana masih utuh, memungkinkan pembelanjaan ganda atau penarikan berlebih.
  4. Pada `on_withdraw_done`, kegagalan callback mengembalikan nilai `withdrawn`, memungkinkan penarikan dana berulang.
  5. *Catatan:* Untuk token NEP-141 standar (USDC, USDT, wNEAR), `ft_transfer` mengembalikan `void` (0 byte), sehingga tidak terpicu di lingkungan testnet saat ini.
- **Saran Perbaikan:**
  Gunakan penanganan `PromiseResult` tanpa batas 1024 byte atau perbesar buffer menjadi 16 KiB jika didukung oleh near-sdk.

### N3-I1 [INFO] `matchPaymentRequirements` di fasilitator tidak memverifikasi kesesuaian token mandat on-chain (`asset`).
- **Status:** TERBUKTI.
- **Jalur:** `facilitator/src/validate.mjs:325-339`.
- **Konteks:** `matchPaymentRequirements` mencocokkan `payTo`, `amount`, `mandate_id`, dan `contractId`, namun tidak memvalidasi apakah mandat on-chain tersebut menggunakan `token` yang sesuai dengan `requirements.asset`. Diperlukan pemanggilan `get_mandate` untuk mengonfirmasi token.

### N3-I2 [INFO] `approvals_count` tidak disertakan dalam `MandateView` / `get_mandate`.
- **Status:** TERBUKTI.
- **Jalur:** `contracts/amanat/src/lib.rs:171-189, 803-824`.
- **Konteks:** Guardian dan klien tidak dapat mengetahui sisa kuota approval sebelum batas 512 tercapai (`TOO_MANY_APPROVALS`). Sebaiknya field ini diekspos di `MandateView`.

### N3-I3 [INFO] Inkonsistensi kode panic literal string di `create_mandate` dengan konstanta modul `err`.
- **Status:** TERBUKTI.
- **Jalur:** `contracts/amanat/src/lib.rs:387-398`, `contracts/amanat/README.md:48`.
- **Konteks:** README menyebut seluruh kode panik berada di `amanat::err`, namun `create_mandate` masih memakai string literal langsung seperti `"BUDGET_LESS_THAN_CAP"`, `"GUARDIAN_IS_AGENT"`, `"GUARDIAN_IS_OWNER"`, `"EMPTY_RECIPIENTS"`, `"INVALID_RECIPIENT"`.

---

## 3. Tiga Temuan Teratas (Top 3 Findings)

1. **N3-M1 [SEDANG]**: Endpoint `/status/:hash` tanpa IP rate limiter dan melakukan RPC forward langsung ke node NEAR untuk sembarang hash (Amplifikasi RPC DoS).
2. **N3-M2 [SEDANG]**: `getTxStatus` tidak memiliki batas waktu RPC (`withTimeout`), berpotensi menyebabkan hanging request tak terbatas.
3. **N3-M3 [SEDANG]**: `parsePaymentResponse` salah memetakan status `status: "FINAL"` menjadi `{ ok: false, code: 'PAYMENT_FAILED' }`, merusak alur verifikasi klien.

---

## 4. Skills Dipakai

- **code-review-and-quality**: Menerapkan tinjauan lima sumbu (correctness, readability, architecture, security, performance) pada seluruh kode baru v1.3; semua checklist terpenuhi.
- **security-and-hardening**: Menerapkan model ancaman STRIDE untuk mengevaluasi manipulasi saldo, replay delegate, DoS rate limiting, dan potensi kebocoran rahasia; tidak ada rahasia bocor di log.
- **doubt-driven-development**: Menantang asumsi aman pada parsing base64url, status respon `FINAL`, dan endpoint `/status`; cross-model review dilewati karena lingkungan non-interaktif sesuai panduan skill.
- **differential-review**: Menganalisis secara mendalam seluruh diff perubahan v1.3 (K-A..K-C, F-A..F-E, C-A) dan blast radius pemanggilnya.
