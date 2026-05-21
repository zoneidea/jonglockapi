ALTER TABLE bookings
  MODIFY status ENUM('pending_payment','payment_processing','paid','expired','cancelled') NOT NULL DEFAULT 'pending_payment';

ALTER TABLE booking_items
  MODIFY status ENUM('pending_payment','payment_processing','paid','expired','cancelled') NOT NULL DEFAULT 'pending_payment';
