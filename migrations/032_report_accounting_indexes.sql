ALTER TABLE payments
  ADD KEY idx_payments_org_paid_created_booking (organization_id, status, paid_at, created_at, booking_id),
  ADD KEY idx_payments_org_booking_created (organization_id, booking_id, created_at, id);

ALTER TABLE booking_items
  ADD KEY idx_booking_items_org_booking_date_status (organization_id, booking_id, booking_date, status),
  ADD KEY idx_booking_items_org_date_status_booking (organization_id, booking_date, status, booking_id);

ALTER TABLE accounting_documents
  ADD KEY idx_accounting_documents_payment_status (organization_id, payment_id, document_status, id);

ALTER TABLE announcement_items
  ADD KEY idx_announcement_items_public_feed (status, type, start_date, end_date, organization_id, market_id);

ALTER TABLE markets
  ADD KEY idx_markets_public_status_name (status, name, organization_id);
