CREATE TABLE IF NOT EXISTS landing_page_views (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  view_date DATE NOT NULL,
  visitor_key VARCHAR(120) NOT NULL,
  path VARCHAR(255) NULL,
  referrer VARCHAR(500) NULL,
  user_agent_hash CHAR(64) NULL,
  ip_hash CHAR(64) NULL,
  view_count INT UNSIGNED NOT NULL DEFAULT 1,
  first_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  last_seen_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_landing_page_views_date_visitor (view_date, visitor_key),
  KEY idx_landing_page_views_date (view_date),
  KEY idx_landing_page_views_last_seen (last_seen_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
