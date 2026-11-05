CREATE TABLE IF NOT EXISTS organization_payment_settings (
  organization_id BIGINT UNSIGNED NOT NULL,
  mode ENUM('legacy','manual','gateway') NOT NULL DEFAULT 'manual',
  sync_state ENUM('inactive','syncing','ready','error') NOT NULL DEFAULT 'inactive',
  details_enc MEDIUMTEXT NULL,
  recipient_details_enc MEDIUMTEXT NULL,
  contact_id VARCHAR(255) NULL,
  bank_account_id VARCHAR(255) NULL,
  generation INT UNSIGNED NOT NULL DEFAULT 1,
  source_market_id BIGINT UNSIGNED NULL,
  migration_conflict TINYINT(1) NOT NULL DEFAULT 0,
  lease_token VARCHAR(64) NULL,
  lease_until DATETIME NULL,
  last_error_code VARCHAR(80) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id),
  CONSTRAINT fk_organization_payment_settings_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO organization_payment_settings
  (organization_id, mode, sync_state, details_enc, recipient_details_enc, contact_id, bank_account_id,
   generation, source_market_id, last_error_code)
SELECT s.organization_id, s.mode,
  CASE WHEN s.sync_state = 'syncing' THEN 'error' ELSE s.sync_state END,
  s.details_enc, s.recipient_details_enc, s.contact_id, s.bank_account_id, s.generation, s.market_id,
  CASE WHEN s.sync_state = 'syncing' THEN 'REGISTRATION_RETRY_REQUIRED' ELSE s.last_error_code END
FROM market_payment_settings s
JOIN (
  SELECT organization_id, MIN(market_id) AS selected_market_id
  FROM market_payment_settings
  WHERE mode <> 'legacy' OR contact_id IS NOT NULL OR details_enc IS NOT NULL OR recipient_details_enc IS NOT NULL
  GROUP BY organization_id HAVING COUNT(*) = 1
) candidate ON candidate.organization_id = s.organization_id AND candidate.selected_market_id = s.market_id;

INSERT IGNORE INTO organization_payment_settings
  (organization_id, mode, sync_state, migration_conflict, last_error_code)
SELECT organization_id, 'manual', 'error', 1, 'MULTIPLE_MARKET_SETTINGS'
FROM market_payment_settings
WHERE mode <> 'legacy' OR contact_id IS NOT NULL OR details_enc IS NOT NULL OR recipient_details_enc IS NOT NULL
GROUP BY organization_id HAVING COUNT(*) > 1;
