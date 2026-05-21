ALTER TABLE booking_items
  ADD KEY idx_booking_items_org_date_booth_status (organization_id, booking_date, booth_id, status);

