const express = require('express');
const { z } = require('zod');
const env = require('../../config/env');
const { authenticate } = require('../../middlewares/auth');
const { asyncHandler } = require('../../utils/async-handler');
const { AppError } = require('../../utils/errors');
const { ok } = require('../../utils/api-response');
const { publicAttempt } = require('../../utils/reservepay');
const checkout = require('../../services/reservepay-checkout.service');
const gateway = require('../../services/reservepay.service');
const store = require('../../services/reservepay-store.service');
const { reconcile } = require('../../services/reservepay-settlement.service');

const router = express.Router();
router.use(authenticate, asyncHandler(async (req, _res, next) => {
  await checkout.requireCustomer(req.auth);
  next();
}));

function body(schema) {
  return (req, _res, next) => {
    const result = schema.safeParse(req.body);
    if (!result.success) return next(new AppError(400, 'Invalid payment request', 'VALIDATION_ERROR'));
    req.paymentBody = result.data;
    return next();
  };
}

router.post('/methods', body(z.object({ platform: z.enum(['IOS', 'ANDROID']) }).strict()),
  asyncHandler(async (req, res) => ok(res, {
    ...await gateway.getPlatformPaymentMethods(req.paymentBody.platform), checkoutEnabled: env.RESERVEPAY_CHECKOUT_ENABLED,
  })));

const initiateSchema = z.object({
  bookingIds: z.array(z.number().int().positive().max(Number.MAX_SAFE_INTEGER)).min(1).max(50)
    .refine((ids) => new Set(ids).size === ids.length),
  paymentSessionId: z.string().min(1).max(128).regex(/^[\x21-\x7e]+$/),
  amount: z.string().regex(/^[1-9]\d{0,15}$/),
}).strict();

router.post('/initiate', body(initiateSchema), asyncHandler(async (req, res) => {
  const key = req.get('Idempotency-Key') || '';
  if (!/^[A-Za-z0-9._:-]{1,128}$/.test(key)) throw new AppError(400, 'Idempotency-Key is required', 'VALIDATION_ERROR');
  const result = await checkout.initiate(req.auth, req.paymentBody, key);
  res.status(['creating', 'unknown'].includes(result.status) ? 202 : 200);
  return ok(res, result);
}));

router.post('/status', body(z.object({ attemptId: z.string().min(1).max(40) }).strict()), asyncHandler(async (req, res) => {
  const attempt = await store.ownedAttempt(req.auth, req.paymentBody.attemptId);
  const updated = await reconcile(attempt);
  return ok(res, publicAttempt(updated, await store.bookingIds(attempt.organization_id, attempt.id)));
}));

module.exports = router;
