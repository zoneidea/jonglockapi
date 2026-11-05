// Public discovery compatibility endpoint. Payment writes require the mobile JWT API.
const express = require('express');
const { z } = require('zod');
const env = require('../../config/env');
const gateway = require('../../services/reservepay.service');
const { asyncHandler } = require('../../utils/async-handler');
const { validate } = require('../../middlewares/validate');
const { ok } = require('../../utils/api-response');
const router = express.Router();

router.get('/card-form', asyncHandler(async (req, res) => {
  const platform = req.query.platform;
  if (!['IOS', 'ANDROID'].includes(platform)) return res.sendStatus(400);
  const config = await gateway.getPlatformPaymentMethods(platform);
  if (!config.installationEnabled || !config.methods.some((method) => method.name === 'CARD')) return res.sendStatus(404);
  const { cardForm } = require('./reservepay-card-form');
  const page = cardForm(config);
  return res.set('Cache-Control', 'no-store').set('Content-Security-Policy', page.csp).type('html').send(page.html);
}));
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
