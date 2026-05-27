CREATE TABLE IF NOT EXISTS audit_check_accessories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  audit_check_id BIGINT UNSIGNED NOT NULL,
  accessory_id BIGINT UNSIGNED NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  line_total DECIMAL(12,2) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_check_accessories_check (audit_check_id),
  CONSTRAINT fk_audit_check_accessories_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_audit_check_accessories_check FOREIGN KEY (audit_check_id) REFERENCES audit_checks(id),
  CONSTRAINT fk_audit_check_accessories_accessory FOREIGN KEY (accessory_id) REFERENCES accessories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
