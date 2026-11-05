const express = require('express');
const { z } = require('zod');
const env = require('../../config/env');
const { query } = require('../../config/db');
const { verifySignature } = require('../../utils/reservepay');
const { activity } = require('../../services/payment-activity.service');

const eventSchema = z.object({
  event_id: z.string().startsWith('evt_').max(128).regex(/^[\x21-\x7e]+$/),
  event: z.string().min(1).max(80),
  payment_id: z.string().min(1).max(255).regex(/^[\x21-\x7e]+$/),
  external_id: z.string().min(1).max(128).nullable().optional(),
  status: z.string().min(1).max(40),
  delivered_at: z.number().int().positive(),
});
const eventStates = { payment_completed: ['SUCCESSFUL', 'FAILED'], payment_expired: ['EXPIRED'] };
const router = express.Router();

router.post('/', express.raw({ type: 'application/json', limit: '64kb' }), async (req, res) => {
  const reject = async (status, code) => {
    try { await activity('reservepay_webhook_rejected', { status, code }); } catch (_error) { /* no untrusted payload logging */ }
    return res.status(status).json({ status: 'failed', code, data: null });
  };
  if (!env.RESERVEPAY_WEBHOOK_KEY || !env.RESERVEPAY_MERCHANT_ID) return reject(503, 'PAYMENT_NOT_CONFIGURED');
  if (!verifySignature(req.body, req.get('Reservepay-Signature'), env.RESERVEPAY_WEBHOOK_KEY)) return reject(401, 'INVALID_WEBHOOK_SIGNATURE');
  let event;
  try {
    const result = eventSchema.safeParse(JSON.parse(req.body.toString('utf8')));
    if (!result.success) return reject(400, 'INVALID_WEBHOOK_EVENT');
    event = result.data;
    if (Object.hasOwn(eventStates, event.event) && !eventStates[event.event].includes(event.status)) return reject(400, 'INVALID_WEBHOOK_EVENT');
  } catch (_error) { return reject(400, 'INVALID_WEBHOOK_EVENT'); }
  try {
    const ignored = !Object.hasOwn(eventStates, event.event);
    // Only verified, allowlisted fields reach the durable inbox. Retry bodies can differ.
    await query(`INSERT INTO payment_callbacks
      (provider, merchant_id, event_id, event_type, provider_reference, payload_json, processing_status, next_retry_at)
      VALUES ('reservepay', :merchantId, :eventId, :eventType, :paymentId, :payload, :processingStatus, NOW())
      ON DUPLICATE KEY UPDATE event_id = event_id`,
    { merchantId: env.RESERVEPAY_MERCHANT_ID, eventId: event.event_id, eventType: event.event,
      paymentId: event.payment_id, payload: JSON.stringify(event), processingStatus: ignored ? 'ignored' : 'pending' });
    await activity('reservepay_webhook_received', { eventId: event.event_id });
    if (!ignored) {
      // Respond after durable storage; process immediately without waiting for the cron tick.
      res.once('finish', () => setImmediate(async () => {
        try {
          const callbacks = await query(`SELECT * FROM payment_callbacks WHERE provider = 'reservepay'
            AND merchant_id = :merchantId AND event_id = :eventId AND processing_status = 'pending' LIMIT 1`,
          { merchantId: env.RESERVEPAY_MERCHANT_ID, eventId: event.event_id });
          if (callbacks[0]) await require('../../services/reservepay-recovery.service').processCallback(callbacks[0]);
        } catch (_error) {
          await activity('reservepay_callback_retry', { eventId: event.event_id, code: 'IMMEDIATE_PROCESSING_RETRY', status: 202 }).catch(() => {});
        }
      }));
    }
    return res.status(200).json({ accepted: true });
  } catch (_error) { return reject(503, 'WEBHOOK_STORAGE_UNAVAILABLE'); }
});

// Body parser failures must not fall through to a logger which captures the raw body.
router.use((error, _req, res, _next) => {
  const status = error.type === 'entity.too.large' ? 413 : 400;
  return res.status(status).json({ status: 'failed', code: 'INVALID_WEBHOOK_BODY', data: null });
});

module.exports = router;
