ALTER TABLE organizations
  ADD COLUMN payment_qrcode_image_url VARCHAR(1024) NULL AFTER payment_bank_account_no;
