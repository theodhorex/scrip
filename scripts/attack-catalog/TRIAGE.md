# Triase Kasus FAIL Katalog Serangan (Lapis B dan Lapis C)

Dokumen ini menyajikan analisis triase objektif dan menyeluruh terhadap seluruh **68 kasus FAIL** (64 kasus di Lapis B dan 4 kasus di Lapis C) yang teridentifikasi dalam kerangka katalog serangan protokol Scrip, sesuai spesifikasi `.agy/BRIEF_BACKEND.md` dan `scripts/attack-catalog/README.md`.

Setiap kasus dinilai tanpa mengubah file pengujian maupun kode produksi, dan diklasifikasikan ke dalam 3 kelas standar:
- **A. SAFE_MISMATCH**: Sistem tetap aman dan menolak serangan (fail-closed), namun kode galat atau format status yang dikembalikan berbeda dari ekspektasi pengujian.
- **B. HARNESS_ARTIFACT**: Kasus pengujian tidak mengevaluasi target yang dimaksudkan karena batasan harness/runner (misal: state rate-limit terisolasi, normalisasi otomatis client HTTP, atau header wajib tidak disertakan).
- **C. REAL_DEFECT**: Perilaku nyata tidak sesuai spesifikasi desain/kontrak yang memerlukan perbaikan kode sumber.

---

## 1. Tabel Ringkasan Klasifikasi

### Matriks Distribusi per Kategori dan Kelas

| Kategori Serangan | Jumlah Kasus FAIL | Kelas A (SAFE_MISMATCH) | Kelas B (HARNESS_ARTIFACT) | Kelas C (REAL_DEFECT) |
| :--- | :---: | :---: | :---: | :---: |
| **05. Agent Identity & Header Security** | 17 | 14 | 3 | 0 |
| **07. Burst & Concurrency Limits** | 4 | 4 | 0 | 0 |
| **08. Encoding & Malformed Payloads** | 10 | 10 | 0 | 0 |
| **09. Operational HTTP & RPC Handling** | 21 | 12 | 7 | 2 |
| **12. Boundary Fuzzing & Absurd Inputs** | 16 | 15 | 1 | 0 |
| **TOTAL** | **68** | **55** | **11** | **2** |

---

## 2. Temuan Kelas C (REAL_DEFECT): Verifikasi Jalur dan Baris Kode

Dua kasus dalam Kategori 9 diidentifikasi sebagai **REAL_DEFECT**:

### `KAT-B-09-123` & `KAT-B-09-124`: Malformed RPC Block Height Dianggap Valid
- **Jalur Berkas & Baris**: [`facilitator/src/relay.mjs:169-170`](<repo>/facilitator/src/relay.mjs#L169-L170)
- **Kode Bermasalah**:
  ```javascript
  const block = await withTimeout(provider.viewBlock({ finality: 'final' }), rpcTimeoutMs);
  const h = Number(block.header.height);
  if (!Number.isSafeInteger(h)) throw new Error('bad height');
  lastHeight = Math.max(lastHeight, h);
  return h;
  ```
- **Skenario Konkret & Bukti Kode**:
  1. Pada `KAT-B-09-123`, mock RPC mengembalikan `{ header: { height: null } }`. Dalam JavaScript, `Number(null)` menghasilkan angka `0`.
  2. Pada `KAT-B-09-124`, mock RPC mengembalikan `{ header: { height: -10 } }`. `Number(-10)` menghasilkan angka `-10`.
  3. Evaluasi `Number.isSafeInteger(0)` dan `Number.isSafeInteger(-10)` keduanya bernilai `true`.
  4. Akibatnya, `getHeight()` menganggap `0` dan `-10` sebagai tinggi blok final yang sah dan tidak melempar galat `bad height`. Nilai ini kemudian diteruskan ke fungsi `checkExpiry(v.maxBlockHeight, policy, currentBlockHeight)`.
  5. Karena tinggi blok delegate (~1100) jauh lebih besar daripada `0 + maxBlockHeightWindow`, delegasi ditolak dengan kode `EXPIRES_TOO_FAR` bukan `UPSTREAM_ERROR`.
- **Dampak Keamanan**:
  Tidak terjadi kebocoran saldo maupun eksekusi relay liar (sistem tetap menolak transaksi / fail-closed melalui jalur kadaluarsa). Namun, pemrosesan respon RPC yang rusak melanggar prinsip "only a final height is honest" (`relay.mjs:168`).
- **Usulan Perbaikan**:
  Ubah validasi pada `facilitator/src/relay.mjs:170` menjadi:
  ```javascript
  if (typeof block?.header?.height !== 'number' || !Number.isSafeInteger(h) || h <= 0) {
    throw new Error('bad height');
  }
  ```

---

## 3. Analisis Kelompok Kasus Serupa

### Keluarga 1: Isolasi Jam Runner Mengosongkan Bucket Rate Limiting (Kelas B)
- **Kasus Terkait**: `KAT-B-09-02`, `KAT-B-09-03`, `KAT-B-09-04`, `KAT-B-09-05` (4 kasus)
- **Akar Masalah**: Runner Lapis B (`scripts/attack-catalog/layers/facilitator.mjs:240`) memajukan jam tiruan sebesar 5000 ms (`state.now += 5000`) sebelum mengeksekusi setiap kasus demi menjaga isolasi cache tinggi blok. Namun, token bucket IP rate limiter (`capacity: 20, refillPerSecond: 1`) ikut terisi kembali sebesar 5 token. Kasus-kasus ini tidak menyertakan parameter `floodCount: 25` mandiri dan keliru mengasumsikan status rate limit dari kasus `KAT-B-09-01` sebelumnya masih tertahan.
- **Usulan Tindakan**: Tambahkan parameter `floodCount: 25` secara eksplisit pada setiap kasus di `scripts/attack-catalog/cases/category_9.mjs` agar tidak bergantung pada status kasus lain.

### Keluarga 2: Normalisasi Huruf Besar/Kecil HTTP Method oleh Klien HTTP (Kelas B)
- **Kasus Terkait**: `KAT-B-05-109`, `KAT-B-05-110`, `KAT-B-05-111` (3 kasus)
- **Akar Masalah**: Pengujian mengirimkan variasi metode HTTP `post`, `Post`, dan `pOsT`. Namun modul `node:http.request` di sisi klien secara otomatis menormalisasi string metode standar menjadi huruf kapital `"POST"` sebelum paket dikirim ke socket TCP. Server menerima `"POST"` biasa dan memproses body dummy `{"signed_delegate":"dummy"}` yang berujung pada penolakan `BAD_ENCODING` (HTTP 400).
- **Usulan Tindakan**: Perbarui eksekutor pengujian lapis B untuk menggunakan socket mentah (`net.connect`) jika ingin menguji transmisi kata kerja HTTP dengan casing tidak baku tanpa terintersepsi normalisasi klien.

### Keluarga 3: Resolusi Path Traversal URL oleh Klien Runner (Kelas B)
- **Kasus Terkait**: `KAT-B-12-102` (1 kasus)
- **Akar Masalah**: Kasus menguji path traversal `/relay/../relay` dengan harapan `NOT_FOUND`. Di dalam `scripts/attack-catalog/layers/facilitator.mjs:186`, fungsi `sendHttpRequest` membuat objek `new URL(urlStr)`. Standar WHATWG URL secara otomatis menyederhanakan segmen `/relay/../relay` menjadi `/relay`. Permintaan yang tiba di fasilitator adalah `/relay`, yang kemudian menolak body dummy dengan `BAD_ENCODING`.
- **Usulan Tindakan**: Gunakan transmisi path HTTP mentah pada socket atau jangan lakukan normalisasi via `new URL()`.

### Keluarga 4: Pengujian Mandate Lookup Tanpa Header Wajib Signature (Kelas B)
- **Kasus Terkait**: `KAT-B-09-130`, `KAT-B-09-131`, `KAT-B-09-132` (3 kasus)
- **Akar Masalah**: Pengujian bermaksud memverifikasi penanganan galat saat fungsi RPC `get_mandate` gagal pada endpoint `/verify`. Namun, generator pengujian (`scripts/attack-catalog/cases/b2_extra.mjs:768`) mengirimkan request tanpa menyertakan header `payment-signature`. Handler `/verify` di `facilitator/src/server.mjs:143` langsung menolak request dengan `MISSING_PAYMENT_SIGNATURE` sebelum RPC lookup `get_mandate` sempat dipanggil.
- **Usulan Tindakan**: Sertakan header `payment-signature` valid dummy yang lolos validasi offline awal agar alur eksekusi mencapai tahap pengecekan mandat `relayer.checkMandateAsset()`.

### Keluarga 5: Header dan Parameter Ekstra dengan Payload Body Kosong/Dummy (Kelas A)
- **Kasus Terkait**:
  - `KAT-B-05-125` .. `KAT-B-05-138` (14 kasus)
  - `KAT-B-07-140` .. `KAT-B-07-143` (4 kasus)
  - `KAT-B-08-110`, `KAT-B-08-111`, `KAT-B-08-112` (3 kasus)
  - `KAT-B-09-106`, `KAT-B-09-109`, `KAT-B-09-110` (3 kasus)
  - `KAT-B-12-112`, `KAT-B-12-113`, `KAT-B-12-114`, `KAT-B-12-116` (4 kasus)
  - `KAT-B-12-129`, `KAT-B-12-130`, `KAT-B-12-131`, `KAT-B-12-132`, `KAT-B-12-133`, `KAT-B-12-134` (6 kasus)
  *(Total 34 kasus)*
- **Akar Masalah**: Kasus-kasus ini memvariasikan header (spoofed IP, auth, query injections, custom headers) atau mengirimkan konkurensi di bawah ambang batas rate limit. Karena body yang dikirim adalah payload dummy `{"signed_delegate":""}`, server lolos dari lapisan HTTP transport lalu memeriksa delegasi di `facilitator/src/validate.mjs:91` dan menolak dengan kode spesifik `BAD_ENCODING` (HTTP 400).
- **Status Keamanan**: Seluruh kasus aman (fail-closed). Kode `BAD_ENCODING` lebih akurat daripada ekspektasi umum `BAD_REQUEST` karena struktur JSON valid tetapi string borsh delegasi kosong.
- **Usulan Tindakan**: Sesuaikan ekspektasi pengujian menjadi `BAD_ENCODING`.

### Keluarga 6: Validasi Header Protokol x402 pada Route /verify dan /settle (Kelas A)
- **Kasus Terkait**:
  - `KAT-B-08-113` (1 kasus)
  - `KAT-B-09-107`, `KAT-B-09-108` (2 kasus)
  - `KAT-B-09-140`, `KAT-B-09-141`, `KAT-B-09-142`, `KAT-B-09-144`, `KAT-B-09-145`, `KAT-B-09-146`, `KAT-B-09-147` (7 kasus)
  *(Total 10 kasus)*
- **Akar Masalah**: Fasilitator mengimplementasikan parser header pembayaran x402 (`facilitator/src/validate.mjs:268`). Permintaan tanpa header atau header kosong ditolak dengan `MISSING_PAYMENT_SIGNATURE`, sedangkan base64 rusak ditolak dengan `BAD_PAYMENT_SIGNATURE`. Pengujian mengharapkan galat generik `BAD_REQUEST`.
- **Status Keamanan**: Respons berstatus HTTP 400 fail-closed. Kode galat aktual memberikan kejelasan kontrak yang jauh lebih baik bagi integrasi klien.
- **Usulan Tindakan**: Perbarui ekspektasi pengujian ke kode spesifik `MISSING_PAYMENT_SIGNATURE` atau `BAD_PAYMENT_SIGNATURE`.

### Keluarga 7: Parsing Body Kosong dan Karakter Null Byte (Kelas A)
- **Kasus Terkait**: `KAT-B-08-114`, `KAT-B-08-115`, `KAT-B-08-147` (3 kasus)
- **Akar Masalah**:
  1. Pada body kosong atau whitespace (`114`, `115`), `JSON.parse` melemparkan `SyntaxError`. Fasilitator menangkapnya di `facilitator/src/server.mjs:80` dan mengembalikan `{ ok: false, code: 'BAD_JSON' }`.
  2. Pada buffer berisi null byte unescaped (`147`: `{"signed_delegate":"\0"}`), parser JSON internal V8 menolak karakter kontrol tak ter-escape sesuai RFC 8259, menghasilkan `BAD_JSON` sebelum delegasi diperiksa.
- **Status Keamanan**: Fail-closed HTTP 400. `BAD_JSON` adalah kode yang paling presisi.
- **Usulan Tindakan**: Perbarui ekspektasi dari `BAD_REQUEST`/`BAD_ENCODING` menjadi `BAD_JSON`.

### Keluarga 8: Penolakan Kata Kerja & Header Konflik di Parser HTTP Node.js (Kelas A)
- **Kasus Terkait**: `KAT-B-12-119`, `KAT-B-12-120`, `KAT-B-12-121`, `KAT-B-12-135` (4 kasus)
- **Akar Masalah**:
  1. Kata kerja absurd (`BREACH`, `ATTACK`, `HACK`) ditolak langsung oleh pustaka C `llhttp` Node.js sebelum mencapai handler aplikasi, memicu event `clientError` dengan respons mentah `400 Bad Request` (`HTTP_400`). Pengujian mengharapkan `METHOD_NOT_ALLOWED` (405).
  2. Header `Content-Length` dan `Transfer-Encoding` yang konflik melanggar RFC HTTP/1.1 dan ditolak langsung oleh parser Node dengan status 400 (`HTTP_400`).
- **Status Keamanan**: Penolakan di tingkat transport socket jauh lebih aman dan efisien dalam mencegah request smuggling.
- **Usulan Tindakan**: Perbarui ekspektasi pengujian menjadi `HTTP_400`.

### Keluarga 9: Parser Klien Lapis C (Kelas A)
- **Kasus Terkait**: `KAT-C-08-11`, `KAT-C-08-25`, `KAT-C2-08-12`, `KAT-C2-12-11` (4 kasus)
- **Akar Masalah**:
  1. `KAT-C-08-11`: JSON bersarang 1500 level berhasil di-parse oleh parser V8 tanpa crash, menghasilkan objek dengan `ok: false, success: false`. Parser klien mengembalikan objek `INERT` aman dan tidak melempar `RangeError`.
  2. `KAT-C-08-25`: Respons dengan header base64 rusak gagal didekode dan fallback ke payload respons yang aman (`ok: false, success: false`), tidak melempar `RangeError`.
  3. `KAT-C2-08-12`: Null byte dalam string JSON ditolak oleh `JSON.parse` sesuai RFC 8259, memicu `RangeError` aman. Pengujian keliru mengharapkan `INERT`.
  4. `KAT-C2-12-11`: Array kosong `[]` diberikan ke `intentHash`. Pembacaan properti `input.mandateId` menghasilkan `undefined`, yang memicu `TypeError` di `toU64`. Pengujian mengharapkan `RangeError`.
- **Status Keamanan**: Seluruhnya aman dan menolak state transaksi palsu.
- **Usulan Tindakan**: Perbarui ekspektasi pengujian agar selaras dengan semantik ECMAScript dan RFC 8259.

---

## 4. Daftar Rinci 68 Kasus FAIL

| ID Kasus | Expected | Actual | Kelas | Alasan Ringkas | Usulan Tindakan |
| :--- | :--- | :--- | :---: | :--- | :--- |
| **KAT-B-05-109** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (BAD_ENCODING) | **B** | `node:http.request` mengkapitalkan verb `post` ke `POST`, body dummy memicu BAD_ENCODING. | Gunakan raw socket untuk transmisi case method non-standar. |
| **KAT-B-05-110** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (BAD_ENCODING) | **B** | `node:http.request` mengkapitalkan verb `Post` ke `POST`. | Gunakan raw socket untuk transmisi case method non-standar. |
| **KAT-B-05-111** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (BAD_ENCODING) | **B** | `node:http.request` mengkapitalkan verb `pOsT` ke `POST`. | Gunakan raw socket untuk transmisi case method non-standar. |
| **KAT-B-05-125** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header XFF diizinkan; payload body string kosong ditolak fail-closed dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-126** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Whitespace XFF diparsing; body string kosong ditolak fail-closed dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-127** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header Authorization diabaikan relayer; body ditolak fail-closed dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-128** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header Basic Auth diabaikan; body ditolak fail-closed dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-129** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header AWS4 signature diabaikan; body ditolak fail-closed dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-130** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header Host eksternal diterima transport; body ditolak fail-closed dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-131** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header X-Forwarded-Host diabaikan; body ditolak fail-closed dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-132** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header X-Forwarded-Proto diabaikan; body ditolak fail-closed dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-133** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header X-Real-IP diabaikan (menggunakan XFF); body ditolak dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-134** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header x-request-id valid dicatat di log; body ditolak dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-135** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Tanda baca pada x-request-id diterima; body ditolak dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-136** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Karakter URL-encoded x-request-id diterima; body ditolak dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-137** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header versi ganda diabaikan; body ditolak dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-05-138** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header bypass rate-limit palsu diabaikan; body ditolak dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-07-140** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Burst 10 request berada dalam batas kapasitas 20; body ditolak dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-07-141** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Burst 15 request berada dalam batas kapasitas 20; body ditolak dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-07-142** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Konkurensi 5 request berada dalam batas kapasitas 20; body ditolak dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-07-143** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Konkurensi 12 request berada dalam batas kapasitas 20; body ditolak dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-08-110** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Content-type charset utf-8 valid diterima; body string kosong ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-08-111** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Content-type APPLICATION/JSON case-insensitive valid; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-08-112** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Parameter boundary pada application/json diabaikan; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-08-113** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | Route /verify menolak header payment-signature yang hilang lebih dulu daripada CT. | Perbarui ekspektasi menjadi MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-08-114** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_JSON) | **A** | Body string kosong gagal di-parse oleh JSON.parse dan mengembalikan kode BAD_JSON. | Perbarui ekspektasi menjadi BAD_JSON. |
| **KAT-B-08-115** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_JSON) | **A** | Body spasi/whitespace gagal di-parse oleh JSON.parse dan mengembalikan kode BAD_JSON. | Perbarui ekspektasi menjadi BAD_JSON. |
| **KAT-B-08-147** | BLOCKED (BAD_ENCODING) | BLOCKED (BAD_JSON) | **A** | Null byte unescaped dalam string JSON adalah galat sintaks RFC 8259 (BAD_JSON). | Perbarui ekspektasi menjadi BAD_JSON. |
| **KAT-B-09-02** | BLOCKED (IP_RATE_LIMITED) | BLOCKED (BAD_ENCODING) | **B** | Clock jump runner (+5s) merefill token; request tidak rate-limited dan ditolak via body. | Tambahkan parameter floodCount: 25 pada kasus. |
| **KAT-B-09-03** | BLOCKED (IP_RATE_LIMITED) | BLOCKED (TX_NOT_FOUND) | **B** | Token IP limiter telah terisi kembali; endpoint /status mengembalikan TX_NOT_FOUND. | Tambahkan parameter floodCount: 25 pada kasus. |
| **KAT-B-09-04** | BLOCKED (IP_RATE_LIMITED) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **B** | Token IP limiter telah terisi kembali; /verify menolak ketiadaan header signature. | Tambahkan parameter floodCount: 25 pada kasus. |
| **KAT-B-09-05** | BLOCKED (IP_RATE_LIMITED) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **B** | Token IP limiter telah terisi kembali; /settle menolak ketiadaan header signature. | Tambahkan parameter floodCount: 25 pada kasus. |
| **KAT-B-09-106** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Konkurensi 20 request pada /relay gagal validasi delegasi (BAD_ENCODING). | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-09-107** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | Konkurensi pada /verify ditolak fail-closed karena header payment-signature tidak ada. | Perbarui ekspektasi menjadi MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-108** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | Konkurensi pada /settle ditolak fail-closed karena header payment-signature tidak ada. | Perbarui ekspektasi menjadi MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-109** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Request beruntun 18x (kapasitas 20) ditolak fail-closed oleh validator delegasi. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-09-110** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Konkurensi 10 request ditolak fail-closed oleh validator delegasi dengan BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-09-123** | BLOCKED (UPSTREAM_ERROR) | BLOCKED (EXPIRES_TOO_FAR) | **C** | `relay.mjs:170` mengonversi `height: null` menjadi 0, sehingga lolos ke cek kadaluarsa. | Perbaiki validasi `typeof height === 'number' && h > 0`. |
| **KAT-B-09-124** | BLOCKED (UPSTREAM_ERROR) | BLOCKED (EXPIRES_TOO_FAR) | **C** | `relay.mjs:170` menganggap height negatif (-10) aman, sehingga lolos ke cek kadaluarsa. | Perbaiki validasi tinggi blok agar mewajibkan `h > 0`. |
| **KAT-B-09-130** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **B** | Pengujian get_mandate pada /verify tidak menyertakan header payment-signature. | Tambahkan header payment-signature pada definisi kasus. |
| **KAT-B-09-131** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **B** | Pengujian get_mandate null pada /verify tidak menyertakan header payment-signature. | Tambahkan header payment-signature pada definisi kasus. |
| **KAT-B-09-132** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **B** | Pengujian token mismatch pada /verify tidak menyertakan header payment-signature. | Tambahkan header payment-signature pada definisi kasus. |
| **KAT-B-09-140** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | /verify menolak ketiadaan payment-signature dengan kode terstruktur dan presisi. | Perbarui ekspektasi menjadi MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-141** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | /verify menolak header payment-signature kosong dengan kode presisi. | Perbarui ekspektasi menjadi MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-142** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_PAYMENT_SIGNATURE) | **A** | /verify menolak base64 payment-signature rusak dengan BAD_PAYMENT_SIGNATURE. | Perbarui ekspektasi menjadi BAD_PAYMENT_SIGNATURE. |
| **KAT-B-09-144** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | /settle menolak ketiadaan payment-signature dengan kode terstruktur dan presisi. | Perbarui ekspektasi menjadi MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-145** | BLOCKED (BAD_REQUEST) | BLOCKED (MISSING_PAYMENT_SIGNATURE) | **A** | /settle menolak header payment-signature kosong dengan kode presisi. | Perbarui ekspektasi menjadi MISSING_PAYMENT_SIGNATURE. |
| **KAT-B-09-146** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_PAYMENT_SIGNATURE) | **A** | /settle menolak base64 payment-signature rusak dengan BAD_PAYMENT_SIGNATURE. | Perbarui ekspektasi menjadi BAD_PAYMENT_SIGNATURE. |
| **KAT-B-09-147** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_PAYMENT_SIGNATURE) | **A** | /settle dengan body {} dan signature 'abc' (bukan JSON) ditolak BAD_PAYMENT_SIGNATURE. | Perbarui ekspektasi menjadi BAD_PAYMENT_SIGNATURE. |
| **KAT-B-12-102** | BLOCKED (NOT_FOUND) | BLOCKED (BAD_ENCODING) | **B** | `new URL()` di runner menormalisasi `/relay/../relay` ke `/relay`, lalu ditolak via body. | Gunakan raw path HTTP tanpa resolusi client. |
| **KAT-B-12-112** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Query string pada POST /relay diabaikan routing; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-12-113** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Query SQL injection diabaikan routing; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-12-114** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Query Log4j JNDI diabaikan routing; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-12-116** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Query string panjang (2KB) diabaikan routing; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-12-119** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (HTTP_400) | **A** | HTTP parser Node.js (llhttp) menolak kata kerja 'BREACH' dengan 400 Bad Request. | Perbarui ekspektasi menjadi HTTP_400. |
| **KAT-B-12-120** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (HTTP_400) | **A** | HTTP parser Node.js (llhttp) menolak kata kerja 'ATTACK' dengan 400 Bad Request. | Perbarui ekspektasi menjadi HTTP_400. |
| **KAT-B-12-121** | BLOCKED (METHOD_NOT_ALLOWED) | BLOCKED (HTTP_400) | **A** | HTTP parser Node.js (llhttp) menolak kata kerja 'HACK' dengan 400 Bad Request. | Perbarui ekspektasi menjadi HTTP_400. |
| **KAT-B-12-129** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header custom 4KB berada dalam batas 16KB Node; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-12-130** | BLOCKED (REQUEST_HEADER_FIELDS_TOO_LARGE) | BLOCKED (BAD_ENCODING) | **A** | Header 10KB tidak melampaui batas default 16KB Node; body ditolak BAD_ENCODING. | Naikkan ukuran header tes >16KB atau ubah ekspektasi. |
| **KAT-B-12-131** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | 50 custom header diterima oleh HTTP parser; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-12-132** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header spasi diterima oleh HTTP parser; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-12-133** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header dengan trailing colon diterima; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-12-134** | BLOCKED (BAD_REQUEST) | BLOCKED (BAD_ENCODING) | **A** | Header dengan URL-encoded carriage return diterima; body ditolak BAD_ENCODING. | Perbarui ekspektasi menjadi BAD_ENCODING. |
| **KAT-B-12-135** | BLOCKED (BAD_REQUEST) | BLOCKED (HTTP_400) | **A** | Header Content-Length dan Transfer-Encoding konflik ditolak langsung oleh llhttp (400). | Perbarui ekspektasi menjadi HTTP_400. |
| **KAT-C-08-11** | BLOCKED (RangeError) | INERT | **A** | JSON bersarang 1500 level diparsing aman oleh V8 dan menghasilkan ok=false tanpa crash. | Perbarui ekspektasi menjadi INERT. |
| **KAT-C-08-25** | BLOCKED (RangeError) | INERT | **A** | Header base64 rusak diabaikan dan fallback ke objek respons aman (ok=false). | Perbarui ekspektasi menjadi INERT. |
| **KAT-C2-08-12** | INERT | BLOCKED (RangeError) | **A** | Karakter null byte unescaped dalam string dilarang oleh RFC 8259, memicu RangeError. | Perbarui ekspektasi menjadi BLOCKED (RangeError). |
| **KAT-C2-12-11** | BLOCKED (RangeError) | BLOCKED (TypeError) | **A** | Input array `[]` memicu TypeError pada toU64 (tipe salah), bukan RangeError. | Perbarui ekspektasi menjadi BLOCKED (TypeError). |
