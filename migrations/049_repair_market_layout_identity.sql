SET @next_market_layout_id = (
  SELECT COALESCE(MAX(id), 0)
  FROM market_layouts
);

UPDATE market_layouts
SET id = (@next_market_layout_id := @next_market_layout_id + 1)
WHERE id IS NULL OR id = 0;

SET @market_layouts_primary_key_exists = (
  SELECT COUNT(*)
  FROM information_schema.table_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'market_layouts'
    AND constraint_type = 'PRIMARY KEY'
);

SET @market_layouts_primary_key_sql = IF(
  @market_layouts_primary_key_exists = 0,
  'ALTER TABLE market_layouts ADD PRIMARY KEY (id)',
  'SELECT 1'
);

PREPARE market_layouts_primary_key_statement FROM @market_layouts_primary_key_sql;
EXECUTE market_layouts_primary_key_statement;
DEALLOCATE PREPARE market_layouts_primary_key_statement;

SET @market_layouts_id_is_auto_increment = (
  SELECT COUNT(*)
  FROM information_schema.columns
  WHERE table_schema = DATABASE()
    AND table_name = 'market_layouts'
    AND column_name = 'id'
    AND extra LIKE '%auto_increment%'
);

SET @market_layouts_auto_increment_sql = IF(
  @market_layouts_id_is_auto_increment = 0,
  'ALTER TABLE market_layouts MODIFY COLUMN id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT',
  'SELECT 1'
);

PREPARE market_layouts_auto_increment_statement FROM @market_layouts_auto_increment_sql;
EXECUTE market_layouts_auto_increment_statement;
DEALLOCATE PREPARE market_layouts_auto_increment_statement;

ALTER TABLE market_layouts
  ADD INDEX IF NOT EXISTS idx_market_layouts_org_market (organization_id, market_id),
  ADD INDEX IF NOT EXISTS idx_market_layouts_status (status),
  ADD INDEX IF NOT EXISTS idx_market_layouts_active (is_active);
