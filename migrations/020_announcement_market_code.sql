ALTER TABLE announcement_items
  ADD COLUMN market_code VARCHAR(120) NULL AFTER market_id;

UPDATE announcement_items ai
JOIN markets m
  ON m.id = ai.market_id
 AND m.organization_id = ai.organization_id
SET ai.market_code = m.code
WHERE ai.market_id IS NOT NULL
  AND (ai.market_code IS NULL OR ai.market_code = '');

ALTER TABLE announcement_items
  ADD KEY idx_announcement_market_code (organization_id, market_code);
