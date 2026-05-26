ALTER TABLE booking_items
  ADD COLUMN checked_in_at DATETIME NULL AFTER audit_status,
  ADD COLUMN checked_in_by_mobile_user_id BIGINT UNSIGNED NULL AFTER checked_in_at,
  ADD KEY idx_booking_items_checkin (organization_id, status, booking_date, checked_in_at),
  ADD CONSTRAINT fk_booking_items_checkin_mobile_user FOREIGN KEY (checked_in_by_mobile_user_id) REFERENCES mobile_users(id);
