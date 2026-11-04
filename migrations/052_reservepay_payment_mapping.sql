ALTER TABLE payments
  MODIFY provider ENUM('ksher','manual','mock','reservepay') NOT NULL DEFAULT 'ksher',
  ADD COLUMN payment_attempt_id BIGINT UNSIGNED NULL AFTER booking_id,
  ADD UNIQUE KEY uq_payment_attempt_booking (payment_attempt_id, booking_id),
  ADD KEY idx_payment_org_attempt (organization_id, payment_attempt_id),
  ADD CONSTRAINT fk_payment_attempt FOREIGN KEY (organization_id, payment_attempt_id)
    REFERENCES payment_attempts(organization_id, id);
