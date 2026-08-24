-- Dedupe recordings per tenant instead of globally, now that tenant_id exists.
ALTER TABLE processed_recordings DROP CONSTRAINT IF EXISTS processed_recordings_source_source_id_key;
ALTER TABLE processed_recordings
  ADD CONSTRAINT processed_recordings_tenant_source_uniq UNIQUE (tenant_id, source, source_id);
