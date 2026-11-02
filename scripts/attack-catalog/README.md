# Scrip Attack Catalog

Kerangka katalog serangan terstruktur untuk membuktikan ketahanan protokol Scrip di berbagai skenario eksekusi (lapis A-E) sesuai `web/docs/RENCANA_ATTACK_2500.md` dan `.agy/BRIEF_BACKEND.md`.

## Definisi Label Hasil

Hasil eksekusi serangan diklasifikasikan ke dalam 4 label objektif:
- `BLOCKED`: Serangan ditolak dengan kode galat/pengecualian yang diharapkan, tanpa perubahan saldo maupun mutasi state yang tidak sah.
- `INERT`: Input absurd atau tidak valid yang tidak berpengaruh apa pun pada sistem dan tidak menyebabkan crash atau kegagalan tak terduga.
- `OUT_OF_SCOPE`: Skenario di luar model ancaman (misal: kunci full-access bocor, kontrak token berbahaya, RPC berbohong); tidak diklaim dicegah oleh protokol, dicatat secara jujur sebagai batasan yang diakui.
- `BREACH`: Serangan yang berhasil menembus batasan keamanan sistem. Setiap temuan BREACH wajib dilaporkan apa adanya dan tidak boleh disembunyikan.

## Definisi Verdict

- `PASS`: Hasil eksekusi `actual` sama dengan `expected` (label dan code cocok).
- `FAIL`: Hasil eksekusi `actual` berbeda dari `expected` desain.
- `BREACH`: Serangan berhasil menembus proteksi (`actual.label === 'BREACH'`).
- `SKIPPED`: Eksekutor untuk lapis yang bersangkutan belum tersedia (dihitung terpisah, tidak pernah dianggap PASS).

## Cara Menjalankan

Jalankan seluruh kasus contoh untuk lapis C (klien dan parser offline):
```bash
node scripts/attack-catalog/run.mjs --layers C
```

Opsi CLI yang tersedia:
```bash
# Menentukan lapisan yang dijalankan
node scripts/attack-catalog/run.mjs --layers C

# Menentukan jalur berkas keluaran
node scripts/attack-catalog/run.mjs --layers C --out results/attack-catalog.json

# Menentukan batas waktu per kasus (milidetik)
node scripts/attack-catalog/run.mjs --layers C --timeout 3000
```

Secara default, hasil eksekusi disimpan ke `scripts/attack-catalog/.out/attack-catalog.json` (diabaikan oleh git).

Menjalankan seluruh pengujian unit katalog:
```bash
node --test scripts/attack-catalog
```

## Cara Menambah Kasus Baru

1. Buat atau perbarui generator kasus di `scripts/attack-catalog/cases/`:
   - Gunakan pendekatan parametrik (vektor variasi parameter) alih-alih mengetik objek berulang.
   - Tetapkan `id` unik (format rekomendasi: `KAT-<LAPIS>-<KATEGORI>-<NOMOR>`).
   - Tentukan `category` (1..12), `layer` ('A'|'B'|'C'|'D'|'E'), `title`, dan `params`.
   - Tentukan `expected` berdasarkan **DESAIN/SPESIFIKASI**, bukan dari hasil eksekusi kode saat ini.
2. Daftarkan kasus baru pada `getSampleCases()` di `scripts/attack-catalog/cases/index.mjs`.
3. Sediakan fungsi eksekutor lapis di `defaultExecutors` jika menguji lapis baru.

## Aturan Kejujuran (Strict Honesty)

Jika terdapat kasus di mana hasil nyata (`actual`) berbeda dari ekspektasi desain (`expected`), **LAPORKAN sebagai FAIL**. Dilarang mengubah nilai `expected` secara diam-diam hanya untuk membuat hasil laporan menjadi hijau.

### Catatan Koreksi Desain Lapis C
- `KAT-C-02-01` (jumlah "0"): harapan awal salah tempat: lapis C hanya memeriksa format; penolakan nol diuji di lapis A -> expected diubah menjadi INERT.

## Lapis E (Harness Testnet)

Harness eksekusi end-to-end pada NEAR Testnet melalui fasilitator riil / RPC (`scripts/attack-catalog/layers/testnet.mjs`).

### Aturan Keamanan & Operasional
- **Rate Limiting**: Dibatasi ketat `<= 8 rps` menggunakan Token-Bucket limiter.
- **Fail-Closed & State Audit**: Membandingkan status mandat (`get_mandate`) dan saldo sebelum vs sesudah; kasus `BLOCKED` yang mengubah state diklasifikasikan sebagai `BREACH`.
- **Eksekusi Per Gelombang**: Kasus diproses dalam gelombang `<= 60 kasus` dengan penyimpanan hasil parsial untuk mencegah kehilangan progres akibat timeout.
- **Siklus Hidup & Pemulihan**: Berkas `.recovery-catalog-<ts>.json` (mode `0600`) wajib dibuat SEBELUM akun on-chain dibuat. Di blok `finally`, seluruh mandat di-revoke & withdraw, saldo NEAR/USDC disapu ke funder, dan akun dihapus. Berkas pemulih hanya dihapus bila akun sisa bernilai `[]`.

### Perkiraan Biaya
Berdasarkan `web/docs/RENCANA_ATTACK_2500.md`:
- **Deploy Kontrak**: ~1.4 NEAR (biaya storage sekali deploy; di-refund ke funder saat deleteAccount).
- **Mandat**: ~2–3 NEAR untuk 40–60 mandat (0.05 NEAR per mandat deposit awal; ditarik kembali via withdraw).
- **Relayer Gas**: ~0.15 NEAR untuk ~600 transaksi relay (~0.00025 NEAR per tx, ditanggung relayer).
- **USDC**: Sejumlah kecil unit token USDC testnet untuk pengujian pembayaran sah (disapu kembali ke funder).
- **Kebutuhan Saldo Funder**: Minimal 5 NEAR di akun funder dan 3 NEAR di akun relayer.

### Cara Menjalankan
1. **Mode Uji Unit & Dry Run (Offline / Tanpa Jaringan)**:
   ```bash
   node --test scripts/attack-catalog/test/testnet.test.mjs
   node --test scripts/attack-catalog
   ```
   *Catatan: Mode dry menggunakan simulasi status dinamis di memori dan dilarang menulis ke direktori `results/`.*

2. **Mode Eksekusi Testnet Nyata (Hanya dijalankan oleh Project Manager)**:
   ```javascript
   import { createTestnetSession, runLayerEInWaves } from './layers/testnet.mjs';

   const session = await createTestnetSession({ dry: false, mandatesCount: 40 });
   try {
     const results = await runLayerEInWaves(cases, session, {
       waveSize: 50,
       partialOutPath: '.out/attack-catalog-layer-e.json',
     });
   } finally {
     await session.closeSession();
   }
   ```

## Menjalankan lapis E dan menggabungkan

### 1. Runner Lapis E (`run-testnet.mjs`)

Runner CLI khusus untuk menjalankan kasus serangan Lapis E dalam gelombang terkontrol (maksimum 60 kasus per gelombang, limiter `<= 8 rps`):

```bash
# Menjalankan gelombang ke-1 dalam mode dry (offline / tanpa jaringan)
node scripts/attack-catalog/run-testnet.mjs --wave 1 --dry

# Menjalankan rentang indeks tertentu
node scripts/attack-catalog/run-testnet.mjs --from 0 --to 60 --dry

# Menjalankan kasus pembanding naif (baseline)
node scripts/attack-catalog/run-testnet.mjs --comparison --dry

# Menentukan jalur berkas keluaran khusus
node scripts/attack-catalog/run-testnet.mjs --wave 1 --dry --out scripts/attack-catalog/.out/testnet-wave-1.json
```

**Karakteristik & Penjagaan:**
- Sesi testnet diinisialisasi sekali per perintah eksekusi.
- Hasil sebagian (partial results) ditulis bertahap ke berkas keluaran setelah setiap kasus diproses, mencegah hilangnya progres jika terjadi abort.
- `closeSession()` dipanggil secara ketat di blok `finally`, serta pada sinyal interupsi `SIGINT` dan `SIGTERM`.
- Mencetak ringkasan hasil (PASS, FAIL, BREACH), jumlah total txHash yang terkumpul (tanpa mencetak daftar hash penuh ke log), dan memastikan sisa akun adalah `[]`.
- Pada mode `--dry`, dilarang keras menulis langsung ke direktori `results/`. Setiap kasus ditandai dengan `source: "dry"` (atau `source: "real"` pada eksekusi nyata).

### 2. Penggabung Hasil Katalog (`merge.mjs`)

Membaca seluruh berkas hasil per lapis (seperti `.out/attack-catalog.json` untuk A/B/C, `.out/testnet-wave-*.json` untuk E, `.out/layer-a.json`, `.out/layer-d.json`) dan menggabungkannya menjadi satu katalog utuh:

```bash
# Menggabungkan seluruh hasil yang ada di .out/ ke .out/attack-catalog.merged.json
node scripts/attack-catalog/merge.mjs

# Menentukan berkas input dan output tertentu
node scripts/attack-catalog/merge.mjs --inputs .out/attack-catalog.json,.out/testnet-wave-1.json --out .out/merged.json

# Mempublikasikan hasil ke results/attack-catalog.json (Hanya untuk hasil eksekusi nyata!)
node scripts/attack-catalog/merge.mjs --publish
```

**Karakteristik & Penjagaan Keamanan:**
- Menghasilkan ringkasan matriks dimensi 3: `kategori x lapis x label`.
- Mengumpulkan daftar terpisah untuk seluruh kasus `BREACH`, kasus `FAIL`, jumlah `SKIPPED`, kasus `OUT_OF_SCOPE`, serta kasus pembanding naif (`comparisonCases`).
- **Penjagaan Publikasi Ketat**: Menulis ke direktori `results/` hanya diperbolehkan dengan flag eksplisit `--publish`. Perintah akan **menolak keras dan gagal** jika ada satu pun kasus yang memiliki label `source: "dry"`.
