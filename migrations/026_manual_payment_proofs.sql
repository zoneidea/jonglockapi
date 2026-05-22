ALTER TABLE organizations
  ADD COLUMN payment_promptpay_id VARCHAR(64) NULL AFTER registered_postcode,
  ADD COLUMN payment_bank_name VARCHAR(120) NULL AFTER payment_promptpay_id,
  ADD COLUMN payment_bank_account_name VARCHAR(255) NULL AFTER payment_bank_name,
  ADD COLUMN payment_bank_account_no VARCHAR(64) NULL AFTER payment_bank_account_name,
  ADD COLUMN payment_instructions TEXT NULL AFTER payment_bank_account_no;

ALTER TABLE payments
  ADD COLUMN proof_image_url VARCHAR(1024) NULL AFTER provider_reference,
  ADD COLUMN proof_uploaded_at DATETIME NULL AFTER paid_at,
  ADD COLUMN payer_note TEXT NULL AFTER proof_uploaded_at,
  ADD COLUMN verified_by_admin_id BIGINT UNSIGNED NULL AFTER payer_note,
  ADD COLUMN verified_at DATETIME NULL AFTER verified_by_admin_id,
  ADD KEY idx_payments_org_waiting (organization_id, status, proof_uploaded_at);
