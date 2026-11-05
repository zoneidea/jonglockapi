const { randomUUID } = require('node:crypto');
const env = require('../config/env');
const { query, transaction } = require('../config/db');
const gateway = require('./reservepay.service');
const store = require('./reservepay-store.service');
const { activity } = require('./payment-activity.service');
const { minorUnits, unixDate } = require('../utils/reservepay');
const { PAYMENT_EXPIRES_MINUTES } = require('../constants/booking');

async function review(conn, attempt, code) {
  await conn.execute(`UPDATE payment_attempts SET state = 'review', last_error_code = :code,
    lease_token = NULL, lease_until = NULL, last_checked_at = NOW(), next_check_at = NULL
    WHERE organization_id = :organizationId AND id = :id`,
  { organizationId: attempt.organization_id, id: attempt.id, code });
  await activity('reservepay_review_required', { organizationId: attempt.organization_id, attemptId: attempt.public_id, code, status: 409 }, conn);
}

function providerMatches(attempt, payment) {
  if (!payment || typeof payment.payment_id !== 'string' || !payment.payment_id.length || payment.payment_id.length > 255) return false;
  if (payment.external_id !== attempt.external_id || payment.currency !== attempt.currency) return false;
  if (attempt.provider_reference && payment.payment_id !== attempt.provider_reference) return false;
  if (typeof payment.amount === 'number' && !Number.isSafeInteger(payment.amount)) return false;
  return /^\d+$/.test(String(payment.amount)) && BigInt(payment.amount) === BigInt(attempt.amount_minor);
}

async function applyPayment(attempt, payment, leaseToken) {
  const notificationId = await transaction(async (conn) => {
    const group = await store.lockGroup(conn, attempt);
    const current = group.attempt;
    if (!current || current.lease_token !== leaseToken) return;
    if (!providerMatches(current, payment)) return review(conn, current, 'PROVIDER_MISMATCH');
    if (current.state === 'paid') return;
    const statusMap = { PENDING: 'pending', AUTHORIZED: 'pending', SUCCESSFUL: 'paid', FAILED: 'failed', EXPIRED: 'expired', CANCELLED: 'cancelled' };
    const nextState = statusMap[payment.status];
    if (!nextState) return review(conn, current, 'UNSUPPORTED_PROVIDER_STATE');
    if (!['creating', 'pending', 'unknown'].includes(current.state)) return review(conn, current, 'TERMINAL_STATE_CONFLICT');
    if (!group.payments.length || group.payments.length !== group.bookings.length
      || group.payments.reduce((sum, p) => sum + minorUnits(p.amount), 0n) !== BigInt(current.amount_minor)
      || group.payments.some((p) => p.provider !== 'reservepay' || !['created', 'waiting'].includes(p.status))
      || group.bookings.some((b) => {
        const allocation = group.payments.find((p) => String(p.booking_id) === String(b.id));
        return !allocation || b.status !== 'payment_processing' || String(b.mobile_user_id) !== String(current.mobile_user_id)
          || minorUnits(b.total_amount) !== minorUnits(allocation.amount);
      })) {
      return review(conn, current, 'BOOKING_STATE_CONFLICT');
    }
    const lockedItems = [];
    const lockedBooths = [];
    for (const booking of group.bookings) {
      const params = { organizationId: current.organization_id, bookingId: booking.id };
      lockedItems.push(...await store.rows(conn, `SELECT id, booking_id, booth_id, booking_date, status FROM booking_items
        WHERE organization_id = :organizationId AND booking_id = :bookingId ORDER BY id FOR UPDATE`, params));
    }
    for (const booking of group.bookings) {
      lockedBooths.push(...await store.rows(conn, `SELECT id, booking_id, booking_item_id, booth_id, booking_date, status FROM booth_date_locks
        WHERE organization_id = :organizationId AND booking_id = :bookingId ORDER BY id FOR UPDATE`,
      { organizationId: current.organization_id, bookingId: booking.id }));
    }
    if (!lockedItems.length || lockedItems.length !== lockedBooths.length
      || group.bookings.some((b) => !lockedItems.some((i) => String(i.booking_id) === String(b.id)))
      || lockedItems.some((i) => i.status !== 'payment_processing' || !lockedBooths.some((l) =>
        String(l.booking_item_id) === String(i.id) && String(l.booking_id) === String(i.booking_id)
        && String(l.booth_id) === String(i.booth_id) && String(l.booking_date) === String(i.booking_date) && l.status === 'processing'))) {
      return review(conn, current, 'BOOKING_LOCK_CONFLICT');
    }
    const paidAt = nextState === 'paid' ? (unixDate(payment.captured_at) || new Date()) : null;
    const params = { organizationId: current.organization_id, id: current.id, state: nextState,
      providerStatus: payment.status, paymentId: payment.payment_id, paidAt,
      paymentMethod: typeof payment.payment_method === 'string' && /^[A-Z0-9_]{1,80}$/.test(payment.payment_method) ? payment.payment_method : null,
      paymentMethodName: typeof payment.payment_method_display_name === 'string' ? payment.payment_method_display_name.slice(0, 160) : null,
      expiresAt: unixDate(payment.expires_at) };
    await conn.execute(`UPDATE payment_attempts SET provider_reference = :paymentId, state = :state,
      provider_status = :providerStatus, provider_expires_at = :expiresAt, paid_at = :paidAt,
      payment_method = COALESCE(:paymentMethod, payment_method),
      payment_method_display_name = COALESCE(:paymentMethodName, payment_method_display_name),
      last_checked_at = NOW(), last_error_code = NULL, lease_token = NULL, lease_until = NULL,
      next_check_at = CASE WHEN :state = 'pending' THEN DATE_ADD(NOW(), INTERVAL 30 SECOND) ELSE NULL END
      WHERE organization_id = :organizationId AND id = :id`, params);
    const paymentState = { pending: 'waiting', paid: 'paid', failed: 'failed', expired: 'failed', cancelled: 'cancelled' }[nextState];
    await conn.execute(`UPDATE payments SET provider_reference = :paymentId, status = :paymentState, paid_at = :paidAt
      WHERE organization_id = :organizationId AND payment_attempt_id = :id`, { ...params, paymentState });
    if (nextState !== 'pending') {
      for (const booking of group.bookings) {
        const bookingStatus = nextState === 'paid' ? 'paid' : nextState === 'failed' ? 'pending_payment' : 'expired';
        const bookingParams = { organizationId: current.organization_id, bookingId: booking.id,
          bookingStatus, paidAt, visible: nextState === 'failed' ? 1 : 0, isRetry: nextState === 'failed' ? 1 : 0 };
        await conn.execute(`UPDATE bookings SET status = :bookingStatus, paid_at = :paidAt, cart_visible = :visible,
          expires_at = CASE WHEN :isRetry = 1 THEN DATE_ADD(NOW(), INTERVAL ${PAYMENT_EXPIRES_MINUTES} MINUTE) ELSE NULL END
          WHERE organization_id = :organizationId AND id = :bookingId`, bookingParams);
        await conn.execute(`UPDATE booking_items SET status = :bookingStatus
          WHERE organization_id = :organizationId AND booking_id = :bookingId`, bookingParams);
        if (['expired', 'cancelled'].includes(nextState)) {
          await conn.execute(`DELETE FROM booth_date_locks WHERE organization_id = :organizationId AND booking_id = :bookingId`, bookingParams);
        } else {
          await conn.execute(`UPDATE booth_date_locks SET status = :lockStatus,
            expires_at = CASE WHEN :isRetry = 1 THEN DATE_ADD(NOW(), INTERVAL ${PAYMENT_EXPIRES_MINUTES} MINUTE) ELSE NULL END
            WHERE organization_id = :organizationId AND booking_id = :bookingId`,
          { ...bookingParams, lockStatus: nextState === 'paid' ? 'paid' : 'held' });
        }
      }
    }
    await activity('reservepay_settled', { organizationId: current.organization_id, attemptId: current.public_id, code: payment.status }, conn);
    return require('./payment-status-notification.service').enqueue(conn, current, nextState);
  });
  if (notificationId) await require('./payment-status-notification.service').deliver(attempt.organization_id, attempt.id).catch(() => {});
}

async function reconcile(attempt, { force = false } = {}) {
  if (!['creating', 'pending', 'unknown'].includes(attempt.state)) return attempt;
  if (attempt.merchant_id !== env.RESERVEPAY_MERCHANT_ID || !gateway.isConfigured()) return attempt;
  const token = randomUUID();
  const claim = await query(`UPDATE payment_attempts SET lease_token = :token,
    lease_until = DATE_ADD(NOW(), INTERVAL 60 SECOND), retry_count = retry_count + 1
    WHERE organization_id = :organizationId AND id = :id AND state IN ('creating','pending','unknown')
      AND (lease_until IS NULL OR lease_until < NOW())
      AND (:force = 1 OR next_check_at IS NULL OR next_check_at <= NOW())`,
  { organizationId: attempt.organization_id, id: attempt.id, token, force: force ? 1 : 0 });
  if (!claim.affectedRows) return store.getAttempt(attempt.organization_id, attempt.id);
  // Read state again after the lease, since initiation may have bound its ID.
  const current = await store.getAttempt(attempt.organization_id, attempt.id);
  let payment;
  try {
    payment = await gateway.findPayment(current.provider_reference || current.external_id);
  } catch (error) {
    const needsReview = current.retry_count >= 10;
    await query(`UPDATE payment_attempts SET state = :state, lease_token = NULL, lease_until = NULL,
      last_checked_at = NOW(), last_error_code = 'LOOKUP_UNCERTAIN', next_check_at = DATE_ADD(NOW(), INTERVAL 60 SECOND)
      WHERE organization_id = :organizationId AND id = :id AND lease_token = :token`,
    { organizationId: current.organization_id, id: current.id, token, state: needsReview ? 'review' : current.provider_reference ? 'pending' : 'unknown' });
    await activity(needsReview ? 'reservepay_review_required' : 'reservepay_lookup_retry',
      { organizationId: current.organization_id, attemptId: current.public_id, code: 'LOOKUP_UNCERTAIN', status: 202 });
    return store.getAttempt(current.organization_id, current.id);
  }
  await applyPayment(current, payment, token);
  return store.getAttempt(current.organization_id, current.id);
}

async function failInitialization(attempt, code) {
  return transaction(async (conn) => {
    const group = await store.lockGroup(conn, attempt);
    const current = group.attempt;
    if (!current || current.state !== 'creating' || current.provider_reference || current.lease_token !== attempt.lease_token) return;
    if (group.bookings.some((b) => b.status !== 'payment_processing')) return review(conn, current, 'BOOKING_STATE_CONFLICT');
    const params = { organizationId: current.organization_id, id: current.id, code };
    await conn.execute(`UPDATE payment_attempts SET state = 'failed', last_error_code = :code,
      lease_token = NULL, lease_until = NULL, next_check_at = NULL WHERE organization_id = :organizationId AND id = :id`, params);
    await conn.execute(`UPDATE payments SET status = 'failed'
      WHERE organization_id = :organizationId AND payment_attempt_id = :id`, params);
    for (const booking of group.bookings) {
      const p = { organizationId: current.organization_id, bookingId: booking.id };
      await conn.execute(`UPDATE bookings SET status = 'pending_payment', cart_visible = 1,
        expires_at = DATE_ADD(NOW(), INTERVAL ${PAYMENT_EXPIRES_MINUTES} MINUTE)
        WHERE organization_id = :organizationId AND id = :bookingId`, p);
      await conn.execute(`UPDATE booking_items SET status = 'pending_payment'
        WHERE organization_id = :organizationId AND booking_id = :bookingId`, p);
      await conn.execute(`UPDATE booth_date_locks SET status = 'held',
        expires_at = DATE_ADD(NOW(), INTERVAL ${PAYMENT_EXPIRES_MINUTES} MINUTE)
        WHERE organization_id = :organizationId AND booking_id = :bookingId`, p);
    }
    await activity('reservepay_initiate_rejected', { organizationId: current.organization_id, attemptId: current.public_id, code }, conn);
  });
}

module.exports = { reconcile, applyPayment, providerMatches, failInitialization };
