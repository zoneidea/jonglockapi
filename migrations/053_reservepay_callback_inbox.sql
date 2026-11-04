ALTER TABLE payment_callbacks
  ADD COLUMN merchant_id VARCHAR(80) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN event_id VARCHAR(128) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN payment_attempt_id BIGINT UNSIGNED NULL,
  ADD COLUMN event_type VARCHAR(80) NULL,
  ADD COLUMN provider_reference VARCHAR(255) CHARACTER SET ascii COLLATE ascii_bin NULL,
  ADD COLUMN processing_status ENUM('pending','processed','ignored','review') NULL,
  ADD COLUMN processed_at DATETIME NULL,
  ADD COLUMN retry_count INT UNSIGNED NOT NULL DEFAULT 0,
  ADD COLUMN next_retry_at DATETIME NULL,
  ADD COLUMN lease_until DATETIME NULL,
  ADD COLUMN lease_token CHAR(36) NULL,
  ADD COLUMN last_error_code VARCHAR(80) NULL,
  ADD UNIQUE KEY uq_callback_event (provider, merchant_id, event_id),
  ADD KEY idx_callback_recovery (provider, processing_status, next_retry_at),
  ADD KEY idx_callback_attempt (organization_id, payment_attempt_id),
  ADD CONSTRAINT fk_callback_attempt FOREIGN KEY (organization_id, payment_attempt_id)
    REFERENCES payment_attempts(organization_id, id);
