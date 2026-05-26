const express = require('express');
const { z } = require('zod');
const { authenticate } = require('../../middlewares/auth');
const { validate } = require('../../middlewares/validate');
const { asyncHandler } = require('../../utils/async-handler');
const { ok } = require('../../utils/api-response');
const { forbidden } = require('../../utils/errors');
const platformService = require('./platform.service');

const router = express.Router();

const loginSchema = z.object({
  body: z.object({
    username: z.string().min(3),
    password: z.string().min(10),
  }),
  query: z.object({}).optional(),
  params: z.object({}).optional(),
});

const organizationsQuerySchema = z.object({
  query: z.object({
    search: z.string().trim().max(120).optional(),
    status: z.enum(['all', 'active', 'inactive']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }).optional(),
  body: z.object({}).optional(),
  params: z.object({}).optional(),
});

const organizationDetailSchema = z.object({
  params: z.object({
    organizationId: z.coerce.number().int().positive(),
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional(),
});

const subscriptionsQuerySchema = z.object({
  query: z.object({
    search: z.string().trim().max(120).optional(),
    status: z.enum(['all', 'pending_activation', 'trialing', 'active', 'past_due', 'suspended', 'cancelled', 'expired']).optional(),
    page: z.coerce.number().int().min(1).optional(),
    pageSize: z.coerce.number().int().min(1).max(100).optional(),
  }).optional(),
  body: z.object({}).optional(),
  params: z.object({}).optional(),
});

const subscriptionDetailSchema = z.object({
  params: z.object({
    subscriptionId: z.coerce.number().int().positive(),
  }),
  body: z.object({}).optional(),
  query: z.object({}).optional(),
});

function requirePlatform(req, res, next) {
  if (req.auth?.userType !== 'platform') {
    return next(forbidden('Platform route only'));
  }
  return next();
}

router.post(
  '/auth/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await platformService.loginPlatform(req.validated.body);
    return ok(res, result);
  }),
);

router.use(authenticate, requirePlatform);

router.get(
  '/me',
  asyncHandler(async (req, res) => {
    const user = await platformService.getPlatformUserById(req.auth.sub);
    return ok(res, user);
  }),
);

router.get(
  '/dashboard/summary',
  asyncHandler(async (req, res) => {
    const summary = await platformService.getPlatformDashboardSummary();
    return ok(res, summary);
  }),
);

router.get(
  '/organizations',
  validate(organizationsQuerySchema),
  asyncHandler(async (req, res) => {
    const organizations = await platformService.listOrganizations(req.validated.query || {});
    return ok(res, organizations);
  }),
);

router.get(
  '/organizations/:organizationId',
  validate(organizationDetailSchema),
  asyncHandler(async (req, res) => {
    const organization = await platformService.getOrganizationDetail(req.validated.params.organizationId);
    return ok(res, organization);
  }),
);

router.get(
  '/subscriptions',
  validate(subscriptionsQuerySchema),
  asyncHandler(async (req, res) => {
    const subscriptions = await platformService.listSubscriptions(req.validated.query || {});
    return ok(res, subscriptions);
  }),
);

router.get(
  '/subscriptions/:subscriptionId',
  validate(subscriptionDetailSchema),
  asyncHandler(async (req, res) => {
    const subscription = await platformService.getSubscriptionDetail(req.validated.params.subscriptionId);
    return ok(res, subscription);
  }),
);

module.exports = router;
