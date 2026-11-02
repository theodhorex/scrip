# Scrip: PRD backend dan kontrak v1.3 (30 Okt 2026)

Melanjutkan PRD v1.2 (Obsidian: `Hackathon/NEAR/PRD Scrip v1.1 - spesifikasi, rencana, task.md`). Dokumen ini hanya memuat apa yang BERUBAH atau MASIH TERBUKA di kontrak, fasilitator, klien, pengujian, operasi, dan kesiapan audit, berdasarkan kondisi nyata repo dan riset (`reports/Riset backend dan kontrak Scrip.md`). Label: **[terbukti]** diuji/diamati langsung; **[riset]** dari sumber di laporan riset; **[keputusan]** keputusan PM.

## 1. Kondisi nyata (30 Okt)
- [terbukti] Kontrak final ter-deploy dan dipakai di testnet: `results/gate.json` (2 pembayaran sah, 5 serangan ditolak, `OVER_BUDGET`, revoke, withdraw, 0 akun tersisa), `attack.json` (30 permintaan paralel: naif bocor 0.4, Scrip tepat 1.0), `demo.json` (injeksi prompt). Gerbang 2 Nov **sudah terlewati**.
- [terbukti] `make contract-test` 101 lulus; sandbox 18 tes; fasilitator 59 tes (cakupan baris 97,2%); klien 75; demo 24.
- [terbukti] Plafon `request_payment` sudah `min(budget, deposited - withdrawn)` (`lib.rs` ~490).
- [riset] Skema `exact` x402 NEAR menolak function-call key (wajib satu `ft_transfer` dengan deposit 1 yocto). Scrip TIDAK kompatibel dengan klien x402 standar. [keputusan] Disebut "x402-style" (HTTP 402 + fasilitator + endpoint `/verify` `/settle` `/supported`, aturan verifikasi kustom), jujur di README; juri tidak diwajibkan memakai klien x402 standar.
- Belum ada: `git init`, LICENSE, CI, analisis statis, cakupan kontrak terukur, skor mutasi tersimpan, `docs/PROPERTIES.md`, skrip pemulih di repo ini.

## 2. Tujuan v1.3
1. Menutup temuan kontrak yang tersisa tanpa mengubah perilaku yang sudah terbukti.
2. Membuat fasilitator tahan restart dan jujur soal hasil akhir pembayaran (bukan sekadar "tx luar sukses").
3. Menambah antarmuka x402-style agar demo dan juri bisa memverifikasi satu pembayaran dengan satu alur HTTP 402.
4. Membuktikan invarian dengan uji properti sungguhan dan uji mutasi yang skripnya tersimpan.
5. Menyiapkan repo untuk klon bersih, audit, dan submisi (1-14 Nov).

## 3. Kontrak (`contracts/scrip`)
| ID | Perubahan | Terima |
|---|---|---|
| K-A | `tighten` menjaga invarian `budget >= cap >= threshold` (menolak, atau mengecilkan cap/threshold otomatis; PILIH menolak dengan kode eksplisit) pada `Budget` dan `PerPaymentCap` | tes unit + properti: invarian tidak pernah rusak setelah urutan acak operasi |
| K-B | `create_mandate` menolak `owner == agent` (kode baru) dan mengembalikan kelebihan deposit NEAR; sama di `approve_intent` | tes unit tiap cabang; saldo NEAR kontrak tidak naik karena kelebihan |
| K-C | Batasi pertumbuhan `approvals` (batas per mandat, kode `TOO_MANY_APPROVALS`) atau kadaluwarsakan | tes batas |
| K-D | Rapikan dokumentasi/komentar basi (plafon `withdrawn`, README bagian Design notes, REPORT.md) | grep tidak lagi menemukan klaim lama |
| K-E | Keputusan K-11: kontrak **immutable** untuk hackathon (tanpa `migrate`); dinyatakan di README (kunci kontrak dihapus setelah init pada deploy demo) | README + `gate.mjs` tidak menyisakan full-access key bila dipakai |
| K-F | K-3 (saldo token dipakai bersama): TIDAK diubah desainnya; ditulis sebagai batas yang diakui + mitigasi "satu kontrak per owner" + usulan allowlist token sebagai pekerjaan lanjutan | README threat model memuat K-3 |
Larangan: tidak mengubah semantik reservasi/callback/`resolve_stale`; angka gas tetap.

## 4. Pengujian kontrak
| ID | Isi | Terima |
|---|---|---|
| T-A | Ganti PRNG buatan di `property_tests.rs` dengan `proptest` + model referensi (state machine) untuk 10 properti: P1 `spent+reserved<=budget`; P2 `budget<=deposited-withdrawn`; P3 kekekalan token (kontrak = sisa mandat + terkunci); P4 `tighten` tidak melonggarkan; P5 `loosen` tidak melewati deposit; P6 `withdraw` hanya Revoked dan hanya sisa; P7 persetujuan hanya sekali; P8 hash niat deterministik; P9 pending tidak pernah settle dua kali; P10 urutan acak mempertahankan P1-P3. Pakai shrinking dan banyak kasus | `cargo test --lib` hijau; setiap properti punya satu mutan yang membuatnya gagal |
| T-B | Sandbox: helper `assert_err_code` membaca `SCRIP_ERR:<kode>` dari log; ganti tiap `is_failure()` generik; perbaiki generator dangkal (resolve_stale dan revoke benar-benar tercapai); balapan campuran (request vs revoke/tighten/withdraw), 40 permintaan paralel | `make contract-it` hijau, kode error terverifikasi |
| T-C | Mutasi: pasang `cargo-mutants`; `scripts/mutants.sh` (`--file src/lib.rs --jobs 3 --timeout 120 -- --lib`); simpan ringkasan di `contracts/scrip/MUTATION.md` (angka nyata: terbunuh/selamat, daftar selamat + alasan) | skor tercatat; mutan selamat yang relevan ditutup tes |
| T-D | Statis: `cargo clippy -- -D warnings`, `cargo audit`, `cargo deny` (bila terpasang), cakupan `cargo llvm-cov` bila terpasang; hasil di `contracts/scrip/STATIC.md` | nol peringatan clippy; hasil tercatat jujur |
| T-E | Regresi untuk tiap temuan `AUDIT_1`/`AUDIT_2` yang belum punya tes (terutama N-L5 hasil >1024 byte) | tabel temuan -> nama tes di `docs/PROPERTIES.md` |

## 5. Fasilitator (`facilitator/`)
| ID | Perubahan | Terima |
|---|---|---|
| F-A | Dedupe delegate persisten (`node:sqlite`, berkas `.facilitator.db`, di `.gitignore`) tahan restart; rekonsiliasi `RELAY_PENDING`: simpan hash tx sebelum siar, `GET /status/:hash` memeriksa rantai | tes: restart tidak mengizinkan relay ulang; pending bisa dipulihkan |
| F-B | Hasil akhir jujur: tunggu `FINAL` (bukan optimistic) dan baca hasil inner (`Reserved` -> callback `Settled`/`Rejected`/`Refunded` lewat log `EVENT_JSON`/`SCRIP_ERR`); respons memuat `inner_status` | tes dengan RPC tiruan untuk tiap status |
| F-C | Verifikasi lebih ketat: parse args `request_payment`; bandingkan nonce delegate dengan nonce kunci on-chain (tolak `<=`); tinggi blok dari finality `final`; cek saldo relayer minimum (`RELAYER_MIN_BALANCE`, tolak `RELAYER_LOW_BALANCE`) | tes tiap penolakan |
| F-D | Operasional: timeout eksplisit RPC, SIGTERM graceful, `request_id`, log JSON terstruktur (tanpa rahasia), `/metrics` (hitungan per kode), header keamanan, panggil `keyVerifier.evict` pada kunci yang dicabut | tes unit; tidak ada kunci/rahasia di log |
| F-E | Endpoint x402-style: `GET /supported`, `POST /verify`, `POST /settle` (payload: header `PAYMENT-SIGNATURE` base64 berisi delegate + `paymentRequirements` {payTo, amount, asset, mandate}); `/verify` = validasi tanpa siar + cocokkan recipient/amount dengan requirements; `/settle` = relay + tunggu inner status; header `PAYMENT-REQUIRED`/`PAYMENT-RESPONSE` di merchant demo (menggantikan `POST /paid {invoiceId,txHash}` sebagai jalur utama, jalur lama dipertahankan) | demo HTTP 402 lengkap: 402 -> klien tanda tangan -> settle -> 200 |
Catatan: `/relay` tetap ada. Multi-instance/Redis hanya ditulis sebagai batas yang diakui.

## 6. Klien dan demo (`client/`, `demo/`)
| ID | Perubahan | Terima |
|---|---|---|
| C-A | `client`: fungsi `buildPaymentSignature(requirements)` dan `parsePaymentResponse`; tes dengan vektor tetap | tes hijau |
| C-B | `demo/merchant.mjs`: alur 402 x402-style; `demo/agent.mjs`: klien yang membaca 402 lalu membayar; pedagang jahat tetap | `node --test demo/test` hijau |

## 7. Operasi dan repo
| ID | Isi | Terima |
|---|---|---|
| O-A | `scripts/recover.mjs` (pemulih akun yatim dari `.recovery-*.json`, aman, tanpa mencetak kunci); `chmod 600` berkas kunci di `NEAR/` (dilaporkan, bukan diubah tanpa izin) | skrip + tes kering |
| O-B | `.gitignore`: tambah `.throwaway-keys*`, `*.pem`, `.near-credentials/`, `*.db`; LICENSE: **MIT** [keputusan sementara; Theo dapat mengganti] | pindai rahasia bersih |
| O-C | `Makefile`: target `static`, `mutants`, `verify-links` (cek tautan `results/` ke explorer via RPC `tx`), `ci`; `.github/workflows/ci.yml` (test offline + clippy) | `make ci` hijau lokal |
| O-D | Dokumen audit-ready: `docs/PROPERTIES.md` (tabel invarian -> tes), `docs/ARCHITECTURE.md` (diagram urutan, glosarium, batas kepercayaan), README: blok "verify in 60 seconds" + tabel klaim -> bukti -> cara ulang + penyesuaian angka tes aktual | tiap klaim README cocok dengan kode/`results/` |
| O-E | Setelah semua perubahan: jalankan ulang `scripts/gate.mjs` di testnet (kunci dari berkas, tidak dicetak), simpan hasil baru, pastikan 0 akun tersisa | `results/gate.json` baru, tx di explorer |

## 8. Urutan dan gerbang
Gelombang 1 (paralel, kepemilikan berkas terpisah): **Kontrak** (K-A..K-F, T-A..T-E) | **Fasilitator + klien + demo** (F-A..F-E, C-A, C-B) | **Operasi + dokumen** (O-A..O-D). Gelombang 2: audit diferensial (`differential-review`, `solidity-auditor` tidak berlaku) atas perubahan, jalankan ulang `make test`, `make contract-it`, mutasi, lalu O-E di testnet. Gelombang 3: sinkron README, hub, dan Obsidian. Beku kode 12 Nov; commit pertama repo pada/setelah 1 Nov (aturan hackathon).

## 9. Risiko
- Ubah kontrak setelah terbukti di testnet: setiap perubahan wajib lulus `make contract-it` dan gate ulang; jangan menyentuh alur reservasi.
- Waktu mutasi (1,5-4 jam): jalankan di latar belakang; sampel bila terlalu lama.
- `proptest-state-machine` mungkin tak cocok dengan near-sdk 5.30: fallback `proptest` biasa dengan model manual.
- Dana uji terbatas: batasi putaran testnet; kunci hanya dari berkas.
