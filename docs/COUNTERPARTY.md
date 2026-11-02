# Counterparty Risk Evaluation & Guarded Signing

Modul keamanan sisi klien untuk mengevaluasi akun penerima (`receiver`) sebelum agen menandatangani atau mengirim pembayaran.

## Sinyal & Sumber Data

1. **`account_age` (Umur Akun & Aktivitas)**
   - **Sumber**: Indexer HTTP (`providers.accountHistory(receiver)`)
   - **Data**: `firstSeenMs` (kapan akun pertama kali terlihat di rantai) dan `txCount` (jumlah transaksi).
   - **Ambang Batas**: Default `minAgeMs` = 7 hari (604.800.000 ms), `minTxCount` = 3 transaksi.
   - **Keputusan**: Akun baru/kurang umur atau transaksi < 3 menghasilkan `warn`.

2. **`contract_code` (Status & Integritas Kode Kontrak)**
   - **Sumber**: NEAR JSON-RPC `query/view_account` (`providers.accountState`) + local pin store (`providers.codePin`).
   - **Keputusan**:
     - Bukan kontrak (`codeHash` null): `info`.
     - Kontrak baru pertama kali: `warn` ringan; hash disimpan ke pin HANYA jika verdict akhir bukan `block`.
     - Kode berubah dibanding pin: `warn` ("kode berubah sejak terakhir dilihat").
     - Akun tidak ada di rantai: `warn`.

3. **`prior_interaction` (Riwayat Interaksi Agen)**
   - **Sumber**: Log JSON lokal riwayat agen (`providers.interactions(agentId, receiver)`).
   - **Keputusan**: `count == 0` -> `warn` ("penerima baru bagi agen ini"); `count >= 1` -> `info`.

4. **`blocklist` (Daftar Blokir Berbasis Bukti)**
   - **Sumber**: Berkas JSON lokal terkurasi (`providers.blocklist.lookup(receiver)`).
   - **Aturan Bukti**: Entri hanya dianggap berbukti jika memuat `txHash` (string base58, 32-44 karakter) ATAU `url` dengan skema `http`/`https` (maksimal 300 karakter); `note` hanya pelengkap dan tidak pernah cukup sendirian, sehingga klaim teks tanpa rujukan yang bisa diverifikasi tidak dapat memblokir penerima sah.
   - **Perlindungan Anti-Griefing**: Laporan tanpa bukti yang dapat diverifikasi (termasuk `note` saja, `txHash` cacat/terlalu pendek, atau `url` dengan skema seperti `javascript:`/`ftp:`) diabaikan dari status block dan dicatat sebagai `warn` ("laporan tanpa bukti").

## Agregasi & Penandatanganan (`guardedSign`)

- **Agregasi**: Ada alasan `block` -> verdict `block` (skor 100); ada alasan `warn` -> verdict `warn` (skor +20 per warn, maks 100); selain itu `allow` (skor 0).
- **Fail-Closed**: Kegagalan penyedia (timeout default 4000ms / throw) menghasilkan `warn` dengan `source: 'unavailable'`, BUKAN `allow` diam-diam.
- **Validasi Input**: Penerima tidak valid menurut aturan NEAR/intent hash langsung menghasilkan `block` (`signal: 'input'`).
- **Alur `guardedSign`**:
  - `block`: Menolak transaksi, tidak memanggil `sign`, melempar `GuardBlockedError`.
  - `warn`: Bertanya ke manusia (`askHuman`). Hanya menandatangani jika jawaban persis `true`; jika `false`/error/timeout/tanpa `askHuman` -> melempar `GuardDeniedError`.
  - `allow`: Memanggil `sign` tepat satu kali.
  - Audit log opsional dicatat via `policy.audit` tanpa membocorkan kunci rahasia.

## Batas Jujur (Honest Limitations)

1. **Indexer Dependency**: Tanpa indexer eksternal terpercaya, umur akun dan volume riwayat tidak dapat diverifikasi secara mandiri oleh full node RPC standar.
2. **Keterbatasan Local Pin**: `codePin` berbasis penyimpanan lokal per mesin/agen; agen baru tidak memiliki snapshot pin sebelumnya kecuali dibagikan secara aman.
3. **Bukan Audit Logika**: Status `allow` atau hash cocok hanya membuktikan kode tidak berubah sejak pin pertama, bukan bahwa kontrak tersebut aman atau bebas celah.
