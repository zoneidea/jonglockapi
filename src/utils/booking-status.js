async function expireStaleBookings(executor, organizationId) {
  const queryResult = await executor.execute(
    `UPDATE bookings b
     JOIN booking_items bi ON bi.booking_id = b.id AND bi.organization_id = b.organization_id
     SET b.status = 'expired',
         bi.status = 'expired'
     WHERE b.organization_id = :organizationId
       AND b.status IN ('pending_payment', 'payment_processing')
       AND bi.status IN ('pending_payment', 'payment_processing')
       AND b.expires_at IS NOT NULL
       AND b.expires_at <= NOW()`,
    { organizationId },
  );
  const result = Array.isArray(queryResult) ? queryResult[0] : queryResult;
  return result.affectedRows || 0;
}

module.exports = { expireStaleBookings };
