# CORRECTIONS_D2 — D1b-re_staging 6 kasus lapis B + desain kasus header-spoof

## Bagian 1 — Triage 6 kasus FAIL tersisa (semua Kelas A: SAFE_MISMATCH; tidak ada perubahan `facilitator/src/**`)

| id | masalah (akar) | perubahan | bukti |
| --- | --- | --- | --- |
| KAT-B-05-109 | Harness sudah meninggikan verb `post` verbatim via raw socket, tetapi parser HTTP server Node (llhttp) menolak token metode non-kanonik dengan `HPE_INVALID_METHOD` → 400 Bad Request di level transport; handler 405 (`server.mjs:366`) tidak pernah tercapai. Rejeksi ini lebih kuat daripada 405 aplikasi (fail-closed sama). Ini kelas masalah sama dengan 12-119..121 yang sudah dikoreksi ke `HTTP_400` di A2B. | `expected.code`: `METHOD_NOT_ALLOWED` → `HTTP_400` | Repro `/tmp/opencode/repro-verb.mjs`: `clientError: HPE_INVALID_METHOD Parse Error: Invalid method encountered` untuk `post`, `Post`, `pOsT`; `facilitator/src/server.mjs:365-367` (405 hanya setelah penguraian berhasil) |
| KAT-B-05-110 | Sama dengan 05-109 (verb `Post`). | `expected.code`: `METHOD_NOT_ALLOWED` → `HTTP_400` | sama dengan di atas |
| KAT-B-05-111 | Sama dengan 05-109 (verb `pOsT`). | `expected.code`: `METHOD_NOT_ALLOWED` → `HTTP_400` | sama dengan di atas |
| KAT-B-09-130 | Request memakai header x402 SAH (payment-signature dibuat dengan delegate ed25519 asli) sehingga mencapai lookup `get_mandate`; mock `onCallFunction` melempar galat upstream. Server menolak fail-closed dengan 502 `UPSTREAM_ERROR` (dipetakan di `server.mjs:28`), bukan `BAD_REQUEST` generik. | `expected.code`: `BAD_REQUEST` → `UPSTREAM_ERROR` | `facilitator/src/server.mjs:142-171` (header valid diperlukan dan lolos sebelum lookup); `server.mjs:28` (STATUS.UPSTREAM_ERROR=502); run baseline menunjukkan actual 502 UPSTREAM_ERROR |
| KAT-B-09-131 | Sama, namun `get_mandate` mengembalikan `null` → ditolak `MANDATE_NOT_FOUND` (400), kode tepat runtuh per kontrak `STATUS` map. | `expected.code`: `BAD_REQUEST` → `MANDATE_NOT_FOUND` | `facilitator/src/relay.mjs` getMandate; `server.mjs:28` (MANDATE_NOT_FOUND=400); run baseline actual MANDATE_NOT_FOUND |
| KAT-B-09-132 | Sama, mandat ditemukan tetapi `token: 'evil.token'` ≠ `requirements.asset usdc.testnet` → `ASSET_MISMATCH` (400). | `expected.code`: `BAD_REQUEST` → `ASSET_MISMATCH` | `facilitator/src/server.mjs:157-171` (fail-closed cek aset); run baseline actual ASSET_MISMATCH |

Hasil: run lapis B setelah koreksi → **369 kasus: PASS 369, FAIL 0, BREACH 0**.

## Bagian 2 — Desain kasus spoof header (`cases/d2_spoof.mjs`, harapan ditulis SEBELUM eksekusi)

Premis: semua kasus memakai delegate/payload **SAH** (pola kasus lapis B yang sudah lolos sebagai dasar — delegate ed25519 asli via `facilitator/test/helpers.mjs makeSigned`, konfigurasi sama dengan kasus INERT yang sudah pass). Tidak ada body/forged payload palsu. Duplikasi pola kasus pass: `c2_extra` (delegate default INERT) dan `b2_extra: paymentSignature`.

Header yang dispoof: `x-forwarded-for`, `x-real-ip`, `forwarded`, `host`, `origin`.
Basis fakta kode (`facilitator/src/server.mjs:34-41`, `trustProxy: true` di harness): hanya LAST-HOP `x-forwarded-for` yang dipercaya; `x-real-ip`, `forwarded`, `host`, `origin` tidak dibaca sama sekali untuk keputusan IP/rute.

### Harapan (ditulis sebelum dijalankan)

| id | header dispoof | skenario | harapan (alasan) |
| --- | --- | --- | --- |
| KAT-B-05-210 | — (kontrol) | delegate sah, tanpa header palsu | INERT — tx direlakan; dasar pembanding "tanpa header palsu" |
| KAT-B-05-211 | — (kontrol) | delegate sah tapi `maxBlockHeight` kedaluwarsa (2400 vs tinggi ~1000) | BLOCKED `EXPIRES_TOO_FAR` — dasar pembanding keputusan BLOCKED |
| KAT-B-05-212 | `x-forwarded-for` (IP palsu segar) | delegate sah | INERT — sama dengan kontrol 210; XFF hanya mengunci bucket yang segar |
| KAT-B-05-213 | `x-real-ip` | delegate sah | INERT — header tidak dibaca (server.mjs:35-41)
| KAT-B-05-214 | `forwarded` | delegate sah | INERT — header tidak dibaca |
| KAT-B-05-215 | `host` | delegate sah | INERT — routing tidak bergantung Host |
| KAT-B-05-216 | `origin` | delegate sah | INERT — tidak ada cek Origin pada /relay |
| KAT-B-05-217 | `x-forwarded-for` (IP palsu segar) | delegate sah + kedaluwarsa | BLOCKED `EXPIRES_TOO_FAR` — keputusan BLOCKED tidak berubah oleh IP yang diklaim |
| KAT-B-05-218 | `x-real-ip` | delegate sah + kedaluwarsa | BLOCKED `EXPIRES_TOO_FAR` |
| KAT-B-05-219 | `forwarded` | delegate sah + kedaluwarsa | BLOCKED `EXPIRES_TOO_FAR` |
| KAT-B-05-220 | `host` | delegate sah + kedaluwarsa | BLOCKED `EXPIRES_TOO_FAR` |
| KAT-B-05-221 | `origin` | delegate sah + kedaluwarsa | BLOCKED `EXPIRES_TOO_FAR` |
| KAT-B-05-222 | `x-forwarded-for` konstan `10.20.30.42` | flood 25 request delegate sah (identik) → request ke-25 | BLOCKED `IP_RATE_LIMITED` — klaim IP sama tidak bisa memuat kembali bucket (kapasitas 20, refill 1/s) |
| KAT-B-05-223 | `x-real-ip`+`forwarded`+`origin` (IP segar) di flood + final | flood 25 dengan XFF konstan + header palsu "IP segar" | BLOCKED `IP_RATE_LIMITED` — header yang tidak dibaca tidak bisa memutar bucket (bucket berkunci XFF last-hop konstan) |
| KAT-B-05-224 | `host`+`origin` palsu di flood + final | flood 25 XFF konstan | BLOCKED `IP_RATE_LIMITED` — spoof Host/Origin tidak membuka bucket |
| KAT-B-05-225 | `/verify`, `x-forwarded-for` konstan | flood 25 valid x402 → ke-25 | BLOCKED `IP_RATE_LIMITED` — batas per-IP berlaku juga di rute /verify (server.mjs:120) |

Jika actual berbeda dari harapan, hasil DAPAT DILAPORKAN apa adanya (BREACH/FAIL tidak ditambal); klasifikasi BLOCKED/INERT/BREACH mengikuti `runner.mjs:83-93`.

### Hasil aktual (dieksekusi SETELAH tabel harapan di atas ditulis; tanpa penyesuaian harapan)

| id | actual | hasil |
| --- | --- | --- |
| 210..216 | INERT (`tx relayed`) untuk kontrol 210 AND 212..216; 211 BLOCKED EXPIRES_TOO_FAR | sesuai harapan |
| 212 | INERT — sama dengan kontrol 210 (tx relayed) | sesuai |
| 213..216 | INERT — x-real-ip / forwarded / host / origin ignored, sesuai `server.mjs:35-41` | sesuai |
| 217..221 | BLOCKED `EXPIRES_TOO_FAR` — keputusan identik dengan kontrol 211 walau IP/Host/Origin palsu diklaim | sesuai |
| 222..224 | BLOCKED `IP_RATE_LIMITED` (HTTP 429) pada request ke-25 | sesuai |
| 225 | BLOCKED `IP_RATE_LIMITED` (HTTP 429) pada /verify | sesuai |

Ringkasan: semua 16 kasus spoof lolos dengan harapan yang ditulis sebelum eksekusi; 0 BREACH; tidak ada header palsu yang mengubah keputusan maupun membuka bucket per-IP. Catatan batasan: klaim XFF last-hop yang BERNOBAT membuat bucket segar karena `trustProxy: true` di harness mengasumsikan reverse-proxy tepercaya yang menambah last-hop sendiri (keputusan konfigurasi operator, bukan cacat kode; dipindah ke triase, bukan ditambal).
