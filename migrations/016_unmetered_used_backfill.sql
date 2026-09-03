-- Count units used for UNMETERED (unlimited) tenants too, so the admin "Used"
-- column reflects real usage. Going forward, deductForUpload records a zero-charge
-- 'deduction' txn (amount 0, balance untouched) for unmetered uploads. This
-- backfills every already-uploaded recording of an unmetered tenant with the same
-- zero-charge deduction (units from the stored file size, 1 GB per unit, min 1),
-- skipping any recording that already has a deduction txn (idempotent).
INSERT INTO wallet_txns (tenant_id, type, amount_paise, balance_after_paise, units, recording_id, note)
SELECT p.tenant_id,
       'deduction',
       0,
       w.balance_paise,
       GREATEST(1, CEIL(COALESCE(p.file_size_bytes, 0)::numeric / 1073741824))::int,
       p.id,
       'unmetered backfill'
FROM processed_recordings p
JOIN wallets w ON w.tenant_id = p.tenant_id
WHERE w.unlimited = true
  AND p.youtube_video_id IS NOT NULL
  AND NOT EXISTS (
    SELECT 1 FROM wallet_txns wt
    WHERE wt.recording_id = p.id AND wt.type = 'deduction'
  );
