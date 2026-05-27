ALTER TABLE bookings
  MODIFY status ENUM('draft','pending_payment','payment_processing','paid','expired','cancelled','refunded') NOT NULL DEFAULT 'draft';
