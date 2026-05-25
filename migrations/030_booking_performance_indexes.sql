ALTER TABLE booths
  ADD KEY idx_booths_org_market_status_sort (organization_id, market_id, status, sort_order, id);

ALTER TABLE accessories
  ADD KEY idx_accessories_org_market_status_id (organization_id, market_id, status, id);

ALTER TABLE bookings
  ADD KEY idx_bookings_org_status_expires (organization_id, status, expires_at, id),
  ADD KEY idx_bookings_org_user_status_cart (organization_id, mobile_user_id, status, cart_visible, created_at);

ALTER TABLE booth_date_locks
  ADD KEY idx_booth_date_locks_market_date_status (organization_id, market_id, booking_date, status, booth_id),
  ADD KEY idx_booth_date_locks_status_expires (organization_id, status, expires_at);
