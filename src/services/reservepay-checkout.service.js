const { randomUUID } = require('node:crypto');
const env = require('../config/env');
const { query, transaction } = require('../config/db');
const gateway = require('./reservepay.service');
const store = require('./reservepay-store.service');
const { activity } = require('./payment-activity.service');
const { AppError } = require('../utils/errors');
const { publicId } = require('../utils/id');
const { decryptField } = require('../utils/crypto');
const { minorUnits, requestHash, publicAttempt } = require('../utils/reservepay');
const { failInitialization } = require('./reservepay-settlement.service');

async function requireCustomer(auth) {
  if (!auth || auth.userType !== 'customer') throw new AppError(403, 'Customer account required', 'FORBIDDEN');
  const users = await query(`SELECT id FROM mobile_users
    WHERE organization_id = :organizationId AND id = :userId AND status = 'active'`,
  { organizationId: auth.organizationId, userId: auth.sub });
  if (!users.length) throw new AppError(403, 'Customer account is inactive', 'FORBIDDEN');
}

function assertEnabled() {
  if (!env.RESERVEPAY_CHECKOUT_ENABLED) throw new AppError(403, 'Online payment is not enabled', 'PAYMENT_CHECKOUT_DISABLED');
  if (!gateway.isConfigured() || !env.RESERVEPAY_WEBHOOK_KEY || !env.CRON_SECRET) {
    throw new AppError(503, 'Online payment is not configured', 'PAYMENT_NOT_CONFIGURED');
  }
}

function sameRequest(attempt, hash) {
  if (attempt.request_hash !== hash) throw new AppError(409, 'Idempotency key was used for another request', 'IDEMPOTENCY_CONFLICT');
  return attempt;
}

async function existing(auth, key) {
  const found = await query(`SELECT * FROM payment_attempts
    WHERE organization_id = :organizationId AND mobile_user_id = :userId AND idempotency_key = :key`,
  { organizationId: auth.organizationId, userId: auth.sub, key });
  return found[0];
}

async function prepare(auth, body, key) {
  const hash = requestHash(body);
  const previous = await existing(auth, key);
  if (previous) return { attempt: sameRequest(previous, hash), created: false };
  try {
    return await transaction(async (conn) => {
      const organizationId = auth.organizationId;
      const bookings = [];
      for (const bookingId of [...body.bookingIds].sort((a, b) => a - b)) {
        const found = await store.rows(conn, `SELECT * FROM bookings
          WHERE organization_id = :organizationId AND mobile_user_id = :userId AND id = :bookingId FOR UPDATE`,
        { organizationId, userId: auth.sub, bookingId });
        if (!found[0]) throw new AppError(404, 'Booking not found', 'BOOKING_NOT_FOUND');
        bookings.push(found[0]);
      }
      const duplicates = await store.rows(conn, `SELECT * FROM payment_attempts
        WHERE organization_id = :organizationId AND mobile_user_id = :userId AND idempotency_key = :key FOR UPDATE`,
      { organizationId, userId: auth.sub, key });
      if (duplicates[0]) return { attempt: sameRequest(duplicates[0], hash), created: false };
      await require('./organization-payment-settings.service').assertGatewayAllowed(conn, organizationId);
      let total = 0n;
      for (const booking of bookings) {
        if (booking.status !== 'pending_payment' || !booking.expires_at || new Date(booking.expires_at) <= new Date()) {
          throw new AppError(400, 'Booking is not payable', 'BOOKING_NOT_PAYABLE');
        }
        const conflicts = await store.rows(conn, `SELECT id FROM payments
          WHERE organization_id = :organizationId AND booking_id = :bookingId
            AND status IN ('created','waiting','paid') LIMIT 1 FOR UPDATE`, { organizationId, bookingId: booking.id });
        if (conflicts.length) throw new AppError(409, 'Payment already in progress', 'PAYMENT_IN_PROGRESS');
        await store.assertNoGatewayPayment(conn, organizationId, booking.id);
        total += minorUnits(booking.total_amount);
      }
      if (String(total) !== body.amount || total <= 0n) throw new AppError(400, 'Payment amount does not match bookings', 'PAYMENT_AMOUNT_MISMATCH');
      const leaseToken = randomUUID();
      const attemptPublicId = publicId('RPA');
      const externalId = `JL-${randomUUID()}`;
      const result = await store.rows(conn, `INSERT INTO payment_attempts
        (public_id, organization_id, mobile_user_id, merchant_id, external_id, payment_session_id,
         idempotency_key, request_hash, amount_minor, currency, lease_token, lease_until, next_check_at)
        VALUES (:publicId, :organizationId, :userId, :merchantId, :externalId, :sessionId,
          :key, :hash, :amount, 'THB', :leaseToken, DATE_ADD(NOW(), INTERVAL 60 SECOND), DATE_ADD(NOW(), INTERVAL 60 SECOND))`,
      { publicId: attemptPublicId, organizationId, userId: auth.sub, merchantId: env.RESERVEPAY_MERCHANT_ID,
        externalId, sessionId: body.paymentSessionId, key, hash, amount: String(total), leaseToken });
      for (const booking of bookings) {
        await conn.execute(`INSERT INTO payments
          (organization_id, public_id, booking_id, payment_attempt_id, provider, status, amount)
          VALUES (:organizationId, :publicId, :bookingId, :attemptId, 'reservepay', 'created', :amount)`,
        { organizationId, publicId: publicId('PAY'), bookingId: booking.id, attemptId: result.insertId, amount: booking.total_amount });
        const items = await store.rows(conn, `SELECT id, booth_id, booking_date, status FROM booking_items
          WHERE organization_id = :organizationId AND booking_id = :bookingId ORDER BY id FOR UPDATE`,
        { organizationId, bookingId: booking.id });
        const locks = await store.rows(conn, `SELECT id, booking_item_id, booth_id, booking_date, expires_at, status FROM booth_date_locks
          WHERE organization_id = :organizationId AND booking_id = :bookingId ORDER BY id FOR UPDATE`,
        { organizationId, bookingId: booking.id });
        if (!items.length || items.some((i) => i.status !== 'pending_payment') || locks.length !== items.length
          || items.some((i) => !locks.some((l) => String(l.booking_item_id) === String(i.id) && l.status === 'held'
            && String(l.booth_id) === String(i.booth_id) && String(l.booking_date) === String(i.booking_date)
            && (!l.expires_at || new Date(l.expires_at) > new Date())))) {
          throw new AppError(400, 'Booking locks are not available', 'BOOKING_NOT_PAYABLE');
        }
        const params = { organizationId, bookingId: booking.id };
        await conn.execute(`UPDATE bookings SET status = 'payment_processing', expires_at = NULL, cart_visible = 0
          WHERE organization_id = :organizationId AND id = :bookingId`, params);
        await conn.execute(`UPDATE booking_items SET status = 'payment_processing'
          WHERE organization_id = :organizationId AND booking_id = :bookingId`, params);
        await conn.execute(`UPDATE booth_date_locks SET status = 'processing', expires_at = NULL
          WHERE organization_id = :organizationId AND booking_id = :bookingId`, params);
      }
      await activity('reservepay_attempt_created', { organizationId, attemptId: attemptPublicId }, conn);
      const attempts = await store.rows(conn, `SELECT * FROM payment_attempts WHERE organization_id = :organizationId AND id = :id`,
        { organizationId, id: result.insertId });
      return { attempt: attempts[0], created: true };
    });
  } catch (error) {
    if (error.code !== 'ER_DUP_ENTRY') throw error;
    const winner = await existing(auth, key);
    if (winner) return { attempt: sameRequest(winner, hash), created: false };
    throw new AppError(409, 'Payment session already used', 'PAYMENT_IN_PROGRESS');
  }
}

async function initiate(auth, body, key) {
  assertEnabled();
  const { attempt, created } = await prepare(auth, body, key);
  if (!created) return publicAttempt(attempt);
  let paymentId;
  try {
    const users = await query(`SELECT email_enc, first_name_enc, last_name_enc FROM mobile_users
      WHERE organization_id = :organizationId AND id = :userId AND status = 'active'`,
    { organizationId: auth.organizationId, userId: auth.sub });
    if (!users[0]) throw new Error('CUSTOMER_INACTIVE');
    const email = decryptField(users[0].email_enc);
    const name = [decryptField(users[0].first_name_enc), decryptField(users[0].last_name_enc)].filter(Boolean).join(' ');
    paymentId = await gateway.initiatePaymentFlow({
      amount: String(attempt.amount_minor), currency: 'THB', payment_session_id: body.paymentSessionId,
      capture: true, return_url: 'jonglock://payment-return', external_id: attempt.external_id,
      ...(email ? { customer_email: email } : {}), ...(name ? { customer_name: name } : {}),
    });
    if (typeof paymentId !== 'string' || !paymentId.length || paymentId.length > 255) throw new Error('INVALID_PROVIDER_RESPONSE');
  } catch (error) {
    if (['INVALID_ARGUMENTS', 'NOT_SUPPORTED', 'CUSTOMER_REQUIRED', 'CUSTOMER_MISMATCH'].includes(error.providerCode)) {
      await failInitialization(attempt, error.amountConstraintCode || error.providerCode);
      return publicAttempt(await store.getAttempt(attempt.organization_id, attempt.id));
    }
    // A rejection or lost response is never proof that the merchant has not charged.
    // Recovery only looks up the saved external_id; it never initiates again.
    await query(`UPDATE payment_attempts SET state = 'unknown', lease_token = NULL, lease_until = NULL,
      last_error_code = :code, next_check_at = DATE_ADD(NOW(), INTERVAL 30 SECOND)
      WHERE organization_id = :organizationId AND id = :id AND state = 'creating' AND lease_token = :leaseToken`,
    { organizationId: attempt.organization_id, id: attempt.id, leaseToken: attempt.lease_token,
      code: 'INITIATE_UNCERTAIN' });
    await activity('reservepay_initiate_uncertain', { organizationId: attempt.organization_id, attemptId: attempt.public_id, code: 'INITIATE_UNCERTAIN', status: 202 });
    return publicAttempt(await store.getAttempt(attempt.organization_id, attempt.id));
  }
  await transaction(async (conn) => {
    const group = await store.lockGroup(conn, attempt);
    const current = group.attempt;
    if (current.provider_reference && current.provider_reference !== paymentId) {
      throw new AppError(409, 'Provider payment reference mismatch', 'PAYMENT_REFERENCE_MISMATCH');
    }
    // A webhook may already have settled while the initiate call was in flight.
    if (current.state !== 'creating' || current.lease_token !== attempt.lease_token) return;
    const params = { organizationId: attempt.organization_id, id: attempt.id, paymentId };
    await conn.execute(`UPDATE payment_attempts SET provider_reference = :paymentId, state = 'pending',
      lease_token = NULL, lease_until = NULL, next_check_at = NOW() WHERE organization_id = :organizationId AND id = :id`, params);
    await conn.execute(`UPDATE payments SET provider_reference = :paymentId, status = 'waiting'
      WHERE organization_id = :organizationId AND payment_attempt_id = :id`, params);
    await activity('reservepay_initiated', { organizationId: attempt.organization_id, attemptId: attempt.public_id }, conn);
  });
  return publicAttempt(await store.getAttempt(attempt.organization_id, attempt.id));
}

module.exports = { initiate, prepare, requireCustomer };
