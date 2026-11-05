CREATE TABLE IF NOT EXISTS market_payment_settings (
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  mode ENUM('legacy','manual','gateway') NOT NULL DEFAULT 'legacy',
  sync_state ENUM('inactive','syncing','ready','error') NOT NULL DEFAULT 'inactive',
  details_enc MEDIUMTEXT NULL,
  recipient_details_enc MEDIUMTEXT NULL,
  contact_id VARCHAR(255) NULL,
  bank_account_id VARCHAR(255) NULL,
  generation INT UNSIGNED NOT NULL DEFAULT 1,
  lease_token VARCHAR(64) NULL,
  lease_until DATETIME NULL,
  last_error_code VARCHAR(80) NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, market_id),
  CONSTRAINT fk_market_payment_settings_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_market_payment_settings_market FOREIGN KEY (market_id) REFERENCES markets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS payment_status_notifications (
  organization_id BIGINT UNSIGNED NOT NULL,
  payment_attempt_id BIGINT UNSIGNED NOT NULL,
  notification_id BIGINT UNSIGNED NOT NULL,
  delivered_at DATETIME NULL,
  lease_until DATETIME NULL,
  PRIMARY KEY (organization_id, payment_attempt_id),
  CONSTRAINT fk_payment_status_notification FOREIGN KEY (notification_id) REFERENCES mobile_notifications(id),
  CONSTRAINT fk_payment_status_attempt FOREIGN KEY (payment_attempt_id) REFERENCES payment_attempts(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
