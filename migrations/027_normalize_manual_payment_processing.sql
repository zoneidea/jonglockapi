UPDATE bookings b
JOIN payments p
  ON p.booking_id = b.id
 AND p.organization_id = b.organization_id
SET b.status = 'payment_processing',
    b.cart_visible = 0,
    b.expires_at = NULL
WHERE b.source = 'mobile'
  AND p.provider = 'manual'
  AND p.status = 'waiting'
  AND p.proof_image_url IS NOT NULL
  AND b.status IN ('pending_payment', 'payment_processing');

UPDATE booking_items bi
JOIN bookings b
  ON b.id = bi.booking_id
 AND b.organization_id = bi.organization_id
JOIN payments p
  ON p.booking_id = b.id
 AND p.organization_id = b.organization_id
SET bi.status = 'payment_processing'
WHERE b.source = 'mobile'
  AND p.provider = 'manual'
  AND p.status = 'waiting'
  AND p.proof_image_url IS NOT NULL
  AND bi.status = 'pending_payment';

UPDATE booth_date_locks bdl
JOIN payments p
  ON p.booking_id = bdl.booking_id
 AND p.organization_id = bdl.organization_id
SET bdl.status = 'processing',
    bdl.expires_at = NULL
WHERE p.provider = 'manual'
  AND p.status = 'waiting'
  AND p.proof_image_url IS NOT NULL
  AND bdl.status IN ('held', 'processing');
