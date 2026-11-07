const express = require('express');
const { z } = require('zod');
const { verifiedGoogleIdentity } = require('../auth/google-customer.service');
const { deleteCustomerAccount } = require('../../services/customer-account-deletion.service');
const { validate } = require('../../middlewares/validate');
const { asyncHandler } = require('../../utils/async-handler');
const { ok } = require('../../utils/api-response');
const { AppError } = require('../../utils/errors');
const router = express.Router();

router.delete('/', validate(z.object({
  body: z.object({ confirmation: z.literal(true) }).strict(),
  query: z.object({}).strict(), params: z.object({}).strict(),
})), asyncHandler(async (req, res) => {
  const token = /^Bearer\s+(.+)$/i.exec(req.get('Authorization') || '')?.[1];
  if (!token) throw new AppError(401, 'Google authentication required', 'UNAUTHORIZED');
  const identity = await verifiedGoogleIdentity(token);
  return ok(res, await deleteCustomerAccount(identity), 'Account deleted');
}));

module.exports = router;
