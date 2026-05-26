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

module.exports = router;
