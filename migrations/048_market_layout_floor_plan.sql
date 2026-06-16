ALTER TABLE market_layouts
  ADD COLUMN floor_plan_id BIGINT UNSIGNED NULL AFTER market_id,
  ADD INDEX idx_market_layouts_floor_plan (floor_plan_id),
  ADD CONSTRAINT fk_market_layouts_floor_plan
    FOREIGN KEY (floor_plan_id) REFERENCES floor_plans(id)
    ON DELETE SET NULL;
