const { query } = require('../config/db');
const { AppError } = require('../utils/errors');

async function rows(conn, sql, params) {
  const [result] = await conn.execute(sql, params);
  return result;
}

async function getAttempt(organizationId, id) {
  const results = await query(`SELECT * FROM payment_attempts
    WHERE organization_id = :organizationId AND id = :id`, { organizationId, id });
  return results[0];
}

async function ownedAttempt(auth, publicId) {
  const found = await query(`SELECT * FROM payment_attempts
    WHERE organization_id = :organizationId AND mobile_user_id = :userId AND public_id = :publicId`,
  { organizationId: auth.organizationId, userId: auth.sub, publicId });
  if (!found[0]) throw new AppError(404, 'Payment not found', 'PAYMENT_NOT_FOUND');
  return found[0];
}

async function bookingIds(organizationId, attemptId) {
  const found = await query(`SELECT booking_id FROM payments
    WHERE organization_id = :organizationId AND payment_attempt_id = :attemptId ORDER BY booking_id`,
  { organizationId, attemptId });
  return found.map((p) => p.booking_id);
}

// Immutable payment mapping resolves the lock order: bookings -> attempt -> payments -> items -> booth locks.
async function lockGroup(conn, attempt) {
  const params = { organizationId: attempt.organization_id, attemptId: attempt.id };
  const mappings = await rows(conn, `SELECT booking_id FROM payments
    WHERE organization_id = :organizationId AND payment_attempt_id = :attemptId ORDER BY booking_id`, params);
  const bookings = [];
  for (const mapping of mappings) {
    const found = await rows(conn, `SELECT * FROM bookings
      WHERE organization_id = :organizationId AND id = :bookingId FOR UPDATE`,
    { organizationId: attempt.organization_id, bookingId: mapping.booking_id });
    if (found[0]) bookings.push(found[0]);
  }
  const locked = await rows(conn, `SELECT * FROM payment_attempts
    WHERE organization_id = :organizationId AND id = :attemptId FOR UPDATE`, params);
  const payments = await rows(conn, `SELECT * FROM payments
    WHERE organization_id = :organizationId AND payment_attempt_id = :attemptId ORDER BY id FOR UPDATE`, params);
  return { attempt: locked[0], payments, bookings };
}

// Call after locking the booking. Keep gateway ledger rows even after failure.
async function assertNoGatewayPayment(conn, organizationId, bookingId, { preserveHistory = false } = {}) {
  // Use existing columns so manual flows remain compatible before expansion migrations.
  // Unknown/review attempts retain created/waiting allocations and therefore stay protected.
  const found = await rows(conn, `SELECT id FROM payments
    WHERE organization_id = :organizationId AND booking_id = :bookingId AND provider = 'reservepay'
      AND (:preserveHistory = 1 OR status IN ('created','waiting','paid'))
    LIMIT 1 FOR UPDATE`, { organizationId, bookingId, preserveHistory: preserveHistory ? 1 : 0 });
  if (found.length) throw new AppError(409, 'Booking has a gateway payment', 'PAYMENT_IN_PROGRESS');
}

module.exports = { rows, getAttempt, ownedAttempt, bookingIds, lockGroup, assertNoGatewayPayment };
