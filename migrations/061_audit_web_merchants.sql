CREATE TABLE IF NOT EXISTS audit_merchants (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  public_id VARCHAR(40) NOT NULL,
  name_enc TEXT NOT NULL,
  name_hash CHAR(64) NOT NULL,
  mobile_user_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_audit_merchant_public (public_id),
  UNIQUE KEY uq_audit_merchant_customer (organization_id, market_id, mobile_user_id),
  KEY idx_audit_merchant_market (organization_id, market_id, id),
  CONSTRAINT fk_audit_merchant_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_audit_merchant_market FOREIGN KEY (market_id) REFERENCES markets(id),
  CONSTRAINT fk_audit_merchant_customer FOREIGN KEY (mobile_user_id) REFERENCES mobile_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE audit_collections
  ADD COLUMN payment_method ENUM('cash','promptpay') NOT NULL DEFAULT 'promptpay',
  ADD COLUMN merchant_id BIGINT UNSIGNED NULL,
  ADD CONSTRAINT fk_audit_collection_merchant FOREIGN KEY (merchant_id) REFERENCES audit_merchants(id);
