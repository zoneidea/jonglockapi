ALTER TABLE markets
  ADD COLUMN address TEXT NULL AFTER description,
  ADD COLUMN opening_hours VARCHAR(120) NULL AFTER close_date,
  ADD COLUMN phone VARCHAR(80) NULL AFTER opening_hours,
  ADD COLUMN line_id VARCHAR(120) NULL AFTER phone,
  ADD COLUMN email VARCHAR(255) NULL AFTER line_id,
  ADD COLUMN terms TEXT NULL AFTER email;

CREATE TABLE market_holidays (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_market_holidays_market (organization_id, market_id, start_date, end_date, status),
  CONSTRAINT fk_market_holidays_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_market_holidays_market FOREIGN KEY (market_id) REFERENCES markets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE market_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NULL,
  image_url TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_market_images_market (organization_id, market_id, status, sort_order),
  CONSTRAINT fk_market_images_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_market_images_market FOREIGN KEY (market_id) REFERENCES markets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
