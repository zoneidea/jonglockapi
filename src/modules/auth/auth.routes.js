const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../../utils/async-handler');
const { ok } = require('../../utils/api-response');
const { validate } = require('../../middlewares/validate');
const authService = require('./auth.service');

const router = express.Router();

const managementLoginSchema = z.object({
  body: z.object({
    organizationCode: z.string().min(1),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

const mobileLoginSchema = z.object({
  body: z.object({
    organizationId: z.coerce.number().int().positive(),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

router.post(
  '/management/login',
  validate(managementLoginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.loginManagement(req.validated.body);
    return ok(res, result);
  }),
);

router.post(
  '/mobile/login',
  validate(mobileLoginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.loginMobile(req.validated.body);
    return ok(res, result);
  }),
);

router.post(
  '/mobile/audit/login',
  validate(
    z.object({
      body: z.object({
        organizationCode: z.string().min(1),
        username: z.string().min(1),
        password: z.string().min(1),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await authService.loginAudit(req.validated.body);
    return ok(res, result);
  }),
);

module.exports = router;
