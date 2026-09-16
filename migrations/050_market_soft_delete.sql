ALTER TABLE markets
  ADD COLUMN deleted_at DATETIME NULL,
  ADD KEY idx_markets_org_deleted (organization_id, deleted_at);
