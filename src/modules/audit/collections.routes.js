const express = require('express');
const multer = require('multer');
const { z } = require('zod');
const { authenticate } = require('../../middlewares/auth');
const { requireRoles, requireManagement, requireMarketAccess } = require('../../middlewares/rbac');
const { asyncHandler } = require('../../utils/async-handler');
const { badRequest } = require('../../utils/errors');
const { ok, created } = require('../../utils/api-response');
const service = require('../../services/audit-collection.service');
const { collectionLog } = require('../../services/audit-collection-log.service');

const mobile = express.Router();
const management = express.Router();
const upload = multer({ storage: multer.memoryStorage(), limits: { fileSize: 5 * 1024 * 1024, files: 1 } }).single('proofImage');
function parse(schema, value) {
  const result = schema.safeParse(value);
  if (!result.success) throw badRequest('ข้อมูลคำขอไม่ถูกต้อง');
  return result.data;
}
const id = value => parse(z.coerce.number().int().positive(), value);
const key = req => parse(z.string().min(16).max(160).regex(/^[A-Za-z0-9_-]+$/), req.get('Idempotency-Key'));
const pos = z.object({ marketId: z.number().int().positive(), customerReference: z.string().trim().min(1).max(200), note: z.string().max(2000).default(''),
  merchantId: z.number().int().positive().optional(), customerId: z.number().int().positive().optional(), persistMerchant: z.boolean().optional(),
  paymentMethod: z.enum(['cash', 'promptpay']).default('promptpay'), expectedAmount: z.number().positive().max(99999999.99).optional(),
  lines: z.array(z.object({ itemId: z.number().int().positive(), quantity: z.number().int().min(1).max(999) }).strict()).min(1).max(100) }).strict()
  .refine(body => !(body.merchantId && body.customerId), 'Choose one merchant identity');

mobile.use(authenticate, requireRoles('audit'), collectionLog);
mobile.get('/markets', asyncHandler(async (req, res) => ok(res, await service.markets(req.auth))));
mobile.get('/collections', asyncHandler(async (req, res) => ok(res, await service.history(req.auth))));
mobile.get('/markets/:marketId/collection-catalog', requireMarketAccess(), asyncHandler(async (req, res) => ok(res, await service.catalog(req.auth, id(req.params.marketId)))));
mobile.post('/markets/:marketId/merchants/search', requireMarketAccess(), asyncHandler(async (req, res) => {
  const body = parse(z.object({search: z.string().trim().min(1).max(200)}).strict(), req.body);
  return ok(res, await require('../../services/audit-merchant.service').suggestions(req.auth, id(req.params.marketId), body.search));
}));
mobile.get('/collection-requests/:requestKey', asyncHandler(async (req, res) => {
  const requestKey = parse(z.string().min(16).max(160).regex(/^[A-Za-z0-9_-]+$/), req.params.requestKey);
  return ok(res, await require('../../services/audit-collection-request.service').recover(req.auth, requestKey));
}));
mobile.post('/collection-requests/:requestKey/cancel', asyncHandler(async (req, res) => {
  const requestKey = parse(z.string().min(16).max(160).regex(/^[A-Za-z0-9_-]+$/), req.params.requestKey);
  return ok(res, await require('../../services/audit-collection-request.service').cancel(req.auth, requestKey));
}));
mobile.post('/collections', asyncHandler(async (req, res) => {
  const {paymentMethod, expectedAmount, ...draft} = parse(pos, req.body);
  return created(res, await service.create(req.auth, {kind: 'pos', draft, paymentMethod, ...(expectedAmount !== undefined ? {expectedAmount} : {})}, key(req)));
}));
mobile.post('/checks/:auditCheckId/collection', asyncHandler(async (req, res) => {
  const body = parse(z.object({paymentMethod: z.enum(['cash', 'promptpay']).default('promptpay'), expectedAmount: z.number().positive().max(99999999.99).optional()}).strict(), req.body || {});
  return created(res, await service.create(req.auth, { kind: 'audit', auditCheckId: id(req.params.auditCheckId), paymentMethod: body.paymentMethod, ...(body.expectedAmount !== undefined ? {expectedAmount: body.expectedAmount} : {}) }, key(req)));
}));
mobile.get('/collections/:collectionId', asyncHandler(async (req, res) => ok(res, await service.get(req.auth, id(req.params.collectionId)))));
mobile.post('/collections/:collectionId/payment-proof', (req, res, next) => upload(req, res, error => next(error ? badRequest('กรุณาใช้รูปภาพ PNG หรือ JPEG ขนาดไม่เกิน 5 MB') : undefined)),
  asyncHandler(async (req, res) => ok(res, await service.proof(req.auth, id(req.params.collectionId), req.file))));

management.use(authenticate, requireManagement, requireRoles('supervisor', 'admin', 'accounting'), collectionLog);
management.get('/markets/:marketId/audit-collections', requireMarketAccess(), asyncHandler(async (req, res) => {
  const status = parse(z.enum(['pending', 'processing', 'paid', 'failed', 'cancelled']).optional(), req.query.status);
  return ok(res, await service.list(req.auth, id(req.params.marketId), status || null));
}));
management.get('/audit-collections/:collectionId/proof', asyncHandler(async (req, res) => {
  const file = await service.proofImage(req.auth, id(req.params.collectionId));
  res.set('Cache-Control', 'no-store'); res.set('Content-Type', file.mime); return res.send(file.bytes);
}));
management.patch('/audit-collections/:collectionId/proof-status', asyncHandler(async (req, res) => {
  const body = parse(z.object({ status: z.enum(['paid', 'failed']) }).strict(), req.body);
  return ok(res, await service.review(req.auth, id(req.params.collectionId), body.status));
}));
module.exports = { mobile, management };
