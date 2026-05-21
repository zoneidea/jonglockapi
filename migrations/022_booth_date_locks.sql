CREATE TABLE IF NOT EXISTS booth_date_locks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  floor_plan_id BIGINT UNSIGNED NOT NULL,
  booth_id BIGINT UNSIGNED NOT NULL,
  booking_id BIGINT UNSIGNED NOT NULL,
  booking_item_id BIGINT UNSIGNED NULL,
  booking_date DATE NOT NULL,
  status ENUM('held','processing','paid') NOT NULL DEFAULT 'held',
  expires_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_booth_date_locks_booth_date (organization_id, booth_id, booking_date),
  KEY idx_booth_date_locks_booking (organization_id, booking_id),
  KEY idx_booth_date_locks_floor_plan_date (organization_id, market_id, floor_plan_id, booking_date, status),
  CONSTRAINT fk_booth_date_locks_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_booth_date_locks_market FOREIGN KEY (market_id) REFERENCES markets(id),
  CONSTRAINT fk_booth_date_locks_floor_plan FOREIGN KEY (floor_plan_id) REFERENCES floor_plans(id),
  CONSTRAINT fk_booth_date_locks_booth FOREIGN KEY (booth_id) REFERENCES booths(id),
  CONSTRAINT fk_booth_date_locks_booking FOREIGN KEY (booking_id) REFERENCES bookings(id),
  CONSTRAINT fk_booth_date_locks_booking_item FOREIGN KEY (booking_item_id) REFERENCES booking_items(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT IGNORE INTO booth_date_locks (
  organization_id, market_id, floor_plan_id, booth_id, booking_id, booking_item_id, booking_date, status, expires_at
)
SELECT
  bi.organization_id,
  b.market_id,
  bo.floor_plan_id,
  bi.booth_id,
  bi.booking_id,
  bi.id,
  bi.booking_date,
  CASE
    WHEN b.status = 'paid' OR bi.status = 'paid' THEN 'paid'
    WHEN b.status = 'payment_processing' OR bi.status = 'payment_processing' THEN 'processing'
    ELSE 'held'
  END AS status,
  b.expires_at
FROM booking_items bi
JOIN bookings b ON b.id = bi.booking_id AND b.organization_id = bi.organization_id
JOIN booths bo ON bo.id = bi.booth_id AND bo.organization_id = bi.organization_id
WHERE b.status IN ('pending_payment', 'payment_processing', 'paid')
  AND bi.status IN ('pending_payment', 'payment_processing', 'paid');

