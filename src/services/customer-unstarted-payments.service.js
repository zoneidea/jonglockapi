// Run inside account deletion's transaction; keep the normal booking -> payment lock order.
async function clearUnstartedPayments(conn, scope) {
  const [bookings] = await conn.execute(`SELECT id FROM bookings
    WHERE organization_id = :organizationId AND mobile_user_id = :userId
      AND paid_at IS NULL AND status IN ('draft','pending_payment','payment_processing','expired','cancelled')
    ORDER BY id FOR UPDATE`, scope);
  for (const booking of bookings) {
    const params = { ...scope, bookingId: booking.id };
    const [payments] = await conn.execute(`SELECT status, paid_at, provider, provider_reference,
      payment_attempt_id, proof_uploaded_at, proof_image_url, audit_check_id FROM payments
      WHERE organization_id = :organizationId AND booking_id = :bookingId ORDER BY id FOR UPDATE`, params);
    // A bank transfer awaiting verification may already have moved money as well.
    if (payments.some(payment => payment.provider === 'reservepay' || payment.payment_attempt_id
      || payment.provider_reference || payment.paid_at || payment.proof_uploaded_at || payment.proof_image_url
      || payment.audit_check_id || !['created','waiting','failed','cancelled'].includes(payment.status))) continue;
    const [paidItems] = await conn.execute(`SELECT id FROM booking_items
      WHERE organization_id = :organizationId AND booking_id = :bookingId AND status = 'paid' LIMIT 1 FOR UPDATE`, params);
    if (paidItems.length) continue;
    const [documents] = await conn.execute(`SELECT id FROM accounting_documents
      WHERE organization_id = :organizationId AND (booking_id = :bookingId OR payment_id IN
        (SELECT id FROM payments WHERE organization_id = :organizationId AND booking_id = :bookingId)) LIMIT 1`, params);
    if (documents.length) continue;
    await conn.execute(`DELETE FROM payments WHERE organization_id = :organizationId AND booking_id = :bookingId
      AND payment_attempt_id IS NULL AND provider <> 'reservepay' AND paid_at IS NULL
      AND status IN ('created','waiting','failed','cancelled')`, params);
    await conn.execute(`UPDATE bookings SET status = 'cancelled', cart_visible = 0, expires_at = NULL
      WHERE organization_id = :organizationId AND id = :bookingId AND mobile_user_id = :userId`, params);
    await conn.execute(`UPDATE booking_items SET status = 'cancelled'
      WHERE organization_id = :organizationId AND booking_id = :bookingId AND status IN ('pending_payment','payment_processing')`, params);
    await conn.execute(`DELETE FROM booth_date_locks
      WHERE organization_id = :organizationId AND booking_id = :bookingId AND status IN ('held','processing')`, params);
  }
}

module.exports = { clearUnstartedPayments };
