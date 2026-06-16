CREATE TABLE IF NOT EXISTS market_layouts (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  description VARCHAR(500) NULL,
  rows_count INT NOT NULL DEFAULT 20,
  columns_count INT NOT NULL DEFAULT 30,
  cell_size INT NOT NULL DEFAULT 48,
  layout_json JSON NOT NULL,
  status ENUM('draft', 'published', 'archived') NOT NULL DEFAULT 'draft',
  is_active TINYINT(1) NOT NULL DEFAULT 1,
  created_by BIGINT UNSIGNED NULL,
  updated_by BIGINT UNSIGNED NULL,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  INDEX idx_market_layouts_org_market (organization_id, market_id),
  INDEX idx_market_layouts_status (status),
  INDEX idx_market_layouts_active (is_active),
  CONSTRAINT fk_market_layouts_organization
    FOREIGN KEY (organization_id) REFERENCES organizations(id)
    ON DELETE CASCADE,
  CONSTRAINT fk_market_layouts_market
    FOREIGN KEY (market_id) REFERENCES markets(id)
    ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
