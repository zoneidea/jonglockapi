ALTER TABLE bookings
  ADD COLUMN vat_amount DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER discount_amount;

ALTER TABLE audit_checks
  ADD COLUMN vat_amount DECIMAL(12,2) NOT NULL DEFAULT 0 AFTER damage_fine_amount;
