ALTER TABLE payment_attempts
  ADD COLUMN payment_method VARCHAR(80) NULL AFTER provider_status,
  ADD COLUMN payment_method_display_name VARCHAR(160) NULL AFTER payment_method;
