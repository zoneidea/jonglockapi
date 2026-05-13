CREATE TABLE announcement_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NULL,
  type ENUM('news','banner') NOT NULL,
  title VARCHAR(255) NOT NULL,
  description TEXT NULL,
  image_url TEXT NULL,
  start_date DATE NULL,
  end_date DATE NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_announcement_scope (organization_id, market_id, type, status, start_date),
  CONSTRAINT fk_announcement_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_announcement_market FOREIGN KEY (market_id) REFERENCES markets(id),
  CONSTRAINT fk_announcement_admin FOREIGN KEY (created_by_admin_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE contact_us_settings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NULL,
  title VARCHAR(255) NOT NULL,
  phone VARCHAR(80) NULL,
  email VARCHAR(255) NULL,
  line_id VARCHAR(120) NULL,
  address TEXT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_contact_scope (organization_id, market_id, status),
  CONSTRAINT fk_contact_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_contact_market FOREIGN KEY (market_id) REFERENCES markets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE tenant_types (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_tenant_types_org (organization_id, status),
  CONSTRAINT fk_tenant_types_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE mobile_users
  ADD COLUMN tenant_type_id BIGINT UNSIGNED NULL AFTER organization_id,
  ADD KEY idx_mobile_users_tenant_type (organization_id, tenant_type_id),
  ADD CONSTRAINT fk_mobile_users_tenant_type FOREIGN KEY (tenant_type_id) REFERENCES tenant_types(id);

CREATE TABLE pdpa_policies (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL DEFAULT 'PDPA Consent',
  content MEDIUMTEXT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  updated_by_admin_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_pdpa_org (organization_id),
  CONSTRAINT fk_pdpa_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_pdpa_admin FOREIGN KEY (updated_by_admin_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
