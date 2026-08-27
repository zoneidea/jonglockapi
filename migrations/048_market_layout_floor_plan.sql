ALTER TABLE market_layouts
  ADD COLUMN IF NOT EXISTS floor_plan_id BIGINT UNSIGNED NULL AFTER market_id;

ALTER TABLE market_layouts
  ADD INDEX IF NOT EXISTS idx_market_layouts_floor_plan (floor_plan_id);

SET @market_layouts_floor_plan_fk_exists = (
  SELECT COUNT(*)
  FROM information_schema.referential_constraints
  WHERE constraint_schema = DATABASE()
    AND table_name = 'market_layouts'
    AND constraint_name = 'fk_market_layouts_floor_plan'
);

SET @market_layouts_floor_plan_fk_sql = IF(
  @market_layouts_floor_plan_fk_exists = 0,
  'ALTER TABLE market_layouts ADD CONSTRAINT fk_market_layouts_floor_plan FOREIGN KEY (floor_plan_id) REFERENCES floor_plans(id) ON DELETE SET NULL',
  'SELECT 1'
);

PREPARE market_layouts_floor_plan_fk_statement FROM @market_layouts_floor_plan_fk_sql;
EXECUTE market_layouts_floor_plan_fk_statement;
DEALLOCATE PREPARE market_layouts_floor_plan_fk_statement;
