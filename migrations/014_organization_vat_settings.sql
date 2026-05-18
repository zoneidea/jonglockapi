ALTER TABLE organizations
  ADD COLUMN vat_enabled TINYINT(1) NOT NULL DEFAULT 0 AFTER line_id,
  ADD COLUMN vat_rate DECIMAL(5,2) NOT NULL DEFAULT 7.00 AFTER vat_enabled,
  ADD COLUMN registered_name VARCHAR(255) NULL AFTER vat_rate,
  ADD COLUMN registered_tax_id VARCHAR(30) NULL AFTER registered_name,
  ADD COLUMN registered_address TEXT NULL AFTER registered_tax_id,
  ADD COLUMN registered_subdistrict VARCHAR(120) NULL AFTER registered_address,
  ADD COLUMN registered_district VARCHAR(120) NULL AFTER registered_subdistrict,
  ADD COLUMN registered_province VARCHAR(120) NULL AFTER registered_district,
  ADD COLUMN registered_postcode VARCHAR(20) NULL AFTER registered_province;
