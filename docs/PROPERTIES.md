# PROPERTIES: Invarian Kontrak dan Temuan Audit Scrip

Dokumen ini memetakan seluruh invarian formal (P1..P10 per PRD v1.3 s4 / T-A) serta temuan audit (`AUDIT_1.md` dan `AUDIT_2.md` per T-E) ke nama fungsi tes NYATA di `contracts/scrip/src/tests.rs` dan `contracts/scrip/src/property_tests.rs`.

---

## 1. Invarian Kontrak (P1..P10)

| ID | Definisi Invarian | Uji Properti (`property_tests.rs`) | Uji Unit Regresi (`tests.rs`) | Status |
|---|---|---|---|---|
| **P1** | `spent + reserved <= budget` | `p1_spent_plus_reserved_never_exceeds_budget` | `reject_over_budget_boundaries`, `reject_over_budget_counts_reserved_and_one_over`, `reject_over_budget_when_deposit_does_not_cover` | Teruji |
| **P2** | Plafon efektif `min(budget, deposited - withdrawn)` tidak pernah dilampaui | `p2_ceiling_never_exceeds_deposited_minus_withdrawn` | `budget_ceiling_never_counts_tokens_already_withdrawn`, `loosen_budget_cannot_exceed_deposited_minus_withdrawn` | Teruji |
| **P3** | Kekekalan token: saldo fisik token kontrak = `deposited - spent - withdrawn` | `p3_token_conservation_holds_against_independent_ledger` | `fund_conservation_holds_over_a_scripted_sequence`, `invariants_hold_over_a_mixed_run` | Teruji |
| **P4** | `tighten` hanya memperketat (parameter hanya bergerak ke dalam, mempertahankan `budget >= cap >= threshold`) | `p4_tighten_never_loosens` | `tighten_budget_boundaries`, `tighten_cap_threshold_boundaries`, `tighten_recipients_only_removes_and_only_existing`, `tighten_expiry_must_move_earlier_but_stay_in_the_future` | Teruji |
| **P5** | `loosen` tidak pernah melewati batas `deposited - withdrawn`, mematuhi hierarki batas, dan hanya guardian | `p5_loosen_stays_inside_deposit_and_ladder` | `loosen_budget_boundaries`, `loosen_cap_and_threshold_boundaries`, `loosen_recipients_only_adds_valid_new_ones_up_to_16`, `loosen_expiry_must_move_later` | Teruji |
| **P6** | `withdraw` hanya untuk owner pada mandat `Revoked`, hanya sisa bebas (`deposited - spent - reserved - withdrawn`), dan menulis state sebelum promise | `p6_withdraw_only_owner_after_revoke_within_free` | `withdraw_needs_an_explicit_revoke_even_after_expiry`, `withdraw_only_the_free_remainder_and_increments_before_the_promise`, `withdraw_creates_ft_transfer_to_owner_and_callback`, `withdraw_callback_success_keeps_withdrawn_and_emits_event`, `withdraw_callback_failure_restores_withdrawn_and_emits_nothing` | Teruji |
| **P7** | Persetujuan niat (`approve_intent`) dikonsumsi paling banyak satu kali untuk tuple eksak yang cocok | `p7_approval_is_consumed_at_most_once` | `approval_is_consumed_once_then_reports_used`, `approve_then_request_round_trip_over_threshold`, `approve_intent_rejects_duplicates_even_after_the_approval_was_used` | Teruji |
| **P8** | Hash niat (`intent_hash`) deterministik, peka terhadap perubahan tiap field, dan mengikat expiry mandat | `p8_intent_hash_is_deterministic_and_field_sensitive` | `intent_hash_matches_every_positive_vector`, `intent_hash_view_returns_hex_of_pure_function`, `approval_binds_current_mandate_expiry_so_tightening_expiry_invalidates_it` | Teruji |
| **P9** | Permintaan berstatus `Pending` diselesaikan (settle atau refund) tepat satu kali, baik melalui callback maupun `resolve_stale` | `p9_pending_never_resolves_twice` | `callback_settles_on_success`, `callback_refunds_on_failure`, `callback_is_idempotent_when_pending_missing`, `resolve_stale_second_call_and_unknown_request_panic`, `resolve_stale_works_on_revoked_mandates_and_late_callback_is_a_no_op` | Teruji |
| **P10** | Urutan acak operasi arbitrer mempertahankan seluruh invarian P1..P3 serta K-A | `p10_random_orders_preserve_money_invariants` | `fund_conservation_holds_over_a_scripted_sequence`, `invariants_hold_over_a_mixed_run` | Teruji |

---

## 2. Pemetaan Temuan Audit AUDIT_1 ke Nama Tes Nyata

| ID Temuan | Kategori / Masalah | Nama Tes Nyata / Lokasi Pengujian | Status |
|---|---|---|---|
| **F1** | Mandat ditarik (`withdrawn`) dapat dihidupkan kembali & menguras saldo mandat lain | `budget_ceiling_never_counts_tokens_already_withdrawn`, `loosen_budget_cannot_exceed_deposited_minus_withdrawn`, `withdraw_needs_an_explicit_revoke_even_after_expiry`, `revoke_after_inconsistent_accounting_does_not_underflow` | Teruji (Fix F1) |
| **F2** | Fasilitator tidak memeriksa public key access key dari `senderId` | Fasilitator: `keycheck.test.mjs`, `relay.test.mjs` | Teruji (Fasilitator) |
| **F3** | Penyimpanan `approvals` tidak berbayar dan tanpa batas mengunci NEAR kontrak | `approve_intent_needs_the_storage_deposit`, `approve_intent_refunds_excess_near_to_guardian`, `approve_intent_caps_entries_per_mandate` | Teruji (Fix F3 / K-C) |
| **F4** | `resolve_stale(transferred=false)` membebaskan reservasi tanpa verifikasi | `resolve_stale_transferred_false_rejected_unprovable`, `test_f4_attack_cannot_reopen_budget_via_false_guardian_claim`, `create_rejects_guardian_equal_owner` | Ditutup (F45, 3 Nov 2026): `false` ditolak `STALE_REFUND_UNPROVABLE`; `true` tetap |
| **F5** | Kegagalan callback withdraw menahan dana tanpa jalur pemulihan | `withdraw_callback_failure_restores_withdrawn_and_emits_nothing`, `withdraw_needs_enough_prepaid_gas_for_the_callback`, `p11_f5_callbacks_never_panic_and_invariants_hold`, `f45_callback_gas_margin_settle_refund_and_withdraw` (integrasi) | Dimitigasi (F45): callback tidak panik pada jalur yang dapat dicapai (tes properti) dan margin gas terukur >= 7x; residual diakui: callback yang hilang menahan dana milik owner itu sendiri |
| **F6** | Approval tetap terkonsumsi meskipun transfer gagal | `audit_f6_refunded_request_leaves_approval_consumed` | Teruji |
| **F7** | Penyimpanan per mandat dapat melebihi deposit 0.05 NEAR saat Pending penuh | `create_mandate_deposit_boundary_is_exactly_0_05_near` | Teruji (Batas desain) |
| **F8** | Status sukses luar fasilitator vs kegagalan transaksi dalam | Fasilitator: pelabelan `outer_tx_succeeded` dan batas min gas | Teruji (Fasilitator) |
| **F9** | Pemeriksaan hostname `rpcUrl` pada kebijakan fasilitator lemah | Fasilitator: allowlist host https ketat | Teruji (Fasilitator) |

---

## 3. Pemetaan Temuan Audit AUDIT_2 ke Nama Tes Nyata

| ID Temuan | Kategori / Masalah | Nama Tes Nyata / Lokasi Pengujian | Status |
|---|---|---|---|
| **N-M1** | Pre-auth RPC amplification pada fasilitator | Fasilitator: rate limiter IP & decode offline | Teruji (Fasilitator) |
| **N-M2** | Konkurensi relay berbagi satu nonce access key | Fasilitator: penanganan antrean relay / pengujian konkurensi | Teruji (Fasilitator) |
| **N-L1** | Interaksi withdraw/guardian: `resolve_stale(false)` + `owner == guardian` | `create_rejects_guardian_equal_owner`, `resolve_stale_transferred_false_rejected_unprovable` | Teruji (F4 ditutup di F45) |
| **N-L2** | Ketiadaan deduplikasi signed delegate identik di fasilitator | Fasilitator: dedupe delegate berbasis basis data sqlite | Teruji (Fasilitator) |
| **N-L3** | Approvals tidak pernah dihapus dan tanpa batas per mandat | `approve_intent_caps_entries_per_mandate` (K-C: batas 512, panic `TOO_MANY_APPROVALS`) | Teruji |
| **N-L4** | Cache key-check dan amplifikasi RPC dari kunci palsu | Fasilitator: validasi cache TTL dan eviksi kunci | Teruji (Fasilitator) |
| **N-L5** | `promise_result_checked(0, 1024)` menganggap kembalian >1024 byte sebagai kegagalan | `audit_nl5_exact_1024_bytes_result_settles_successfully` (sukses pada 1024 byte); `audit_nl5_oversized_transfer_result_should_settle` (`#[ignore]`, bug asli di lib.rs); `audit_nl5_oversized_withdraw_result_should_succeed` (`#[ignore]`, bug asli di lib.rs) | Teruji & ditandai `#[ignore]` |
| **N-I1** | Model token bersama memercayai akuntansi token (fee-on-transfer / rebasing) | Threat Model README K-3 / K-F (mitigasi 1 kontrak/owner) | belum (usulan allowlist token) |
| **N-I2** | `approval_threshold` dihitung per-pembayaran, bukan kumulatif | `audit_ni2_approval_threshold_is_per_payment_not_cumulative` | Teruji |
| **N-I3** | Margin storage mandat dengan 16 penerima dan 32 pending | `create_mandate_deposit_boundary_is_exactly_0_05_near` | Teruji |
| **N-I4** | Ketergantungan keaktifan owner terhadap guardian untuk pending kedaluwarsa | Batasan desain; tidak ada metode bypass tanpa guardian | belum |
| **N-I5** | Perubahan expiry via `tighten` membatalkan approval guardian yang belum terpakai | `approval_binds_current_mandate_expiry_so_tightening_expiry_invalidates_it` | Teruji |
