UPDATE bookings
SET status = 'expired'
WHERE status IN ('draft', 'cancelled', 'refunded');

UPDATE booking_items
SET status = 'expired'
WHERE status = 'cancelled';

ALTER TABLE bookings
  MODIFY status ENUM('pending_payment','payment_processing','paid','expired') NOT NULL DEFAULT 'pending_payment';

ALTER TABLE booking_items
  MODIFY status ENUM('pending_payment','payment_processing','paid','expired') NOT NULL DEFAULT 'pending_payment';
