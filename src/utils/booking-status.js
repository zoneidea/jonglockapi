async function expireStaleBookings(executor, organizationId) {
  const expiredBookingsResult = await executor.execute(
    `SELECT id
     FROM bookings
     WHERE organization_id = :organizationId
       AND status IN ('pending_payment', 'payment_processing')
       AND expires_at IS NOT NULL
       AND expires_at <= NOW()`,
    { organizationId },
  );
  const expiredBookingRows = Array.isArray(expiredBookingsResult) && Array.isArray(expiredBookingsResult[0])
    ? expiredBookingsResult[0]
    : expiredBookingsResult;
  const expiredBookingIds = expiredBookingRows.map((row) => row.id);

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
  const result = Array.isArray(queryResult) && queryResult[0]?.affectedRows !== undefined
    ? queryResult[0]
    : queryResult;

  if (expiredBookingIds.length) {
    const placeholders = expiredBookingIds.map((_, index) => `:bookingId${index}`).join(', ');
    const params = expiredBookingIds.reduce((values, id, index) => {
      values[`bookingId${index}`] = id;
      return values;
    }, { organizationId });

    await executor.execute(
      `DELETE FROM booth_date_locks
       WHERE organization_id = :organizationId
         AND booking_id IN (${placeholders})
         AND status IN ('held', 'processing')`,
      params,
    );
  }

  return {
    expiredBookings: expiredBookingIds.length,
    affectedRows: result.affectedRows || 0,
    releasedLocks: expiredBookingIds.length,
  };
}

module.exports = { expireStaleBookings };
