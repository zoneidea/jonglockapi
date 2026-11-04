const { randomUUID } = require('node:crypto');
const env = require('../config/env');
const { query } = require('../config/db');
const { reconcile } = require('./reservepay-settlement.service');
const { activity } = require('./payment-activity.service');

async function processCallback(callback) {
  const token = randomUUID();
  const claimed = await query(`UPDATE payment_callbacks SET lease_token = :token,
    lease_until = DATE_ADD(NOW(), INTERVAL 60 SECOND), retry_count = retry_count + 1
    WHERE id = :id AND provider = 'reservepay' AND merchant_id = :merchantId AND processing_status = 'pending'
      AND (lease_until IS NULL OR lease_until < NOW())`, { id: callback.id, merchantId: env.RESERVEPAY_MERCHANT_ID, token });
  if (!claimed.affectedRows) return;
  try {
    const event = typeof callback.payload_json === 'string' ? JSON.parse(callback.payload_json) : callback.payload_json;
    // This merchant-scoped lookup bootstraps tenant identity for authenticated provider events.
    const attempts = await query(`SELECT * FROM payment_attempts WHERE provider = 'reservepay' AND merchant_id = :merchantId
      AND (provider_reference = :paymentId OR external_id = :externalId) LIMIT 2`,
    { merchantId: env.RESERVEPAY_MERCHANT_ID, paymentId: event.payment_id, externalId: event.external_id || '' });
    if (attempts.length !== 1) throw new Error('UNRESOLVED_CALLBACK');
    const attempt = attempts[0];
    // Event claims must agree with the mapping even though the status is obtained via find-payment.
    if ((event.external_id && event.external_id !== attempt.external_id)
      || (attempt.provider_reference && attempt.provider_reference !== event.payment_id)) throw new Error('CALLBACK_REFERENCE_MISMATCH');
    const updated = await reconcile(attempt, { force: true });
    // A live initiate/reconciliation lease or a lookup failure must leave the inbox retryable.
    if (updated.lease_until || ['creating', 'unknown'].includes(updated.state)
      || updated.last_error_code === 'LOOKUP_UNCERTAIN'
      || (updated.state === 'pending' && ['SUCCESSFUL', 'FAILED', 'EXPIRED'].includes(event.status))) {
      throw new Error('CALLBACK_NOT_SETTLED');
    }
    await query(`UPDATE payment_callbacks SET organization_id = :organizationId, payment_attempt_id = :attemptId,
      processing_status = :status, processed_at = NOW(), lease_token = NULL, lease_until = NULL, last_error_code = NULL
      WHERE id = :id AND lease_token = :token`,
    { id: callback.id, token, organizationId: attempt.organization_id, attemptId: attempt.id,
      status: updated.state === 'review' ? 'review' : 'processed' });
    await activity('reservepay_callback_processed', { organizationId: attempt.organization_id, attemptId: attempt.public_id, eventId: event.event_id });
  } catch (error) {
    const needsReview = callback.retry_count >= 9;
    await query(`UPDATE payment_callbacks SET lease_token = NULL, lease_until = NULL,
      processing_status = :status, next_retry_at = DATE_ADD(NOW(), INTERVAL 60 SECOND), last_error_code = 'CALLBACK_RETRY'
      WHERE id = :id AND lease_token = :token`, { id: callback.id, token, status: needsReview ? 'review' : 'pending' });
    await activity(needsReview ? 'reservepay_callback_review' : 'reservepay_callback_retry', { eventId: callback.event_id, code: 'CALLBACK_RETRY', status: 202 });
  }
}

async function recover({ limit = 20 } = {}) {
  // No frontend-supplied organization: this is a trusted, secret-authenticated system job.
  // Merchant lookup returns tenant IDs first; all settlement operations are then tenant scoped.
  const organizations = await query(`SELECT DISTINCT organization_id FROM payment_attempts
    WHERE provider = 'reservepay' AND merchant_id = :merchantId AND state IN ('creating','pending','unknown')
    AND (next_check_at IS NULL OR next_check_at <= NOW()) LIMIT :limit`,
  { merchantId: env.RESERVEPAY_MERCHANT_ID, limit });
  let checked = 0;
  for (const org of organizations) {
    const attempts = await query(`SELECT * FROM payment_attempts
      WHERE organization_id = :organizationId AND merchant_id = :merchantId AND state IN ('creating','pending','unknown')
        AND (lease_until IS NULL OR lease_until < NOW()) AND (next_check_at IS NULL OR next_check_at <= NOW())
      ORDER BY id LIMIT :limit`, { organizationId: org.organization_id, merchantId: env.RESERVEPAY_MERCHANT_ID, limit: limit - checked });
    for (const attempt of attempts) { await reconcile(attempt); checked += 1; }
    if (checked >= limit) break;
  }
  const callbacks = await query(`SELECT * FROM payment_callbacks WHERE provider = 'reservepay'
    AND merchant_id = :merchantId AND processing_status = 'pending'
    AND (lease_until IS NULL OR lease_until < NOW()) AND (next_retry_at IS NULL OR next_retry_at <= NOW())
    ORDER BY id LIMIT :limit`, { merchantId: env.RESERVEPAY_MERCHANT_ID, limit });
  for (const callback of callbacks) await processCallback(callback);
  return { attemptsChecked: checked, callbacksChecked: callbacks.length };
}

module.exports = { recover, processCallback };
