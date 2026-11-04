// Public discovery compatibility endpoint. Payment writes require the mobile JWT API.
const express = require('express');
const { z } = require('zod');
const env = require('../../config/env');
const gateway = require('../../services/reservepay.service');
const { asyncHandler } = require('../../utils/async-handler');
const { validate } = require('../../middlewares/validate');
const { ok } = require('../../utils/api-response');
const router = express.Router();
router.post('/methods', validate(z.object({
  body: z.object({ platform: z.enum(['IOS', 'ANDROID']) }),
  query: z.object({}).passthrough(), params: z.object({}).passthrough(),
})), asyncHandler(async (req, res) => ok(res, {
  ...await gateway.getPlatformPaymentMethods(req.validated.body.platform),
  checkoutEnabled: env.RESERVEPAY_CHECKOUT_ENABLED,
})));
router.post(['/initiate', '/status'], (_req, res) => res.status(410).json({
  status: 'failed', message: 'Use the authenticated mobile payment API', code: 'PAYMENT_API_MOVED', data: null,
}));
module.exports = router;
