CREATE TABLE IF NOT EXISTS master_banks (
  country_code CHAR(2) CHARACTER SET ascii COLLATE ascii_bin NOT NULL DEFAULT 'TH',
  code CHAR(3) CHARACTER SET ascii COLLATE ascii_bin NOT NULL,
  name_th VARCHAR(160) NOT NULL,
  name_en VARCHAR(180) NOT NULL,
  short_name VARCHAR(20) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  sort_order INT NOT NULL DEFAULT 100,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (country_code, code),
  KEY idx_master_banks_active (country_code, status, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
