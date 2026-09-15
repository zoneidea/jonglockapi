const express = require('express');
const bcrypt = require('bcryptjs');
const db = require('../../config/db');
const { logger } = require('../../config/logger');
const { decryptField } = require('../../utils/crypto');
const { validate } = require('../../middlewares/validate');
const { asyncHandler } = require('../../utils/async-handler');
const { ok } = require('../../utils/api-response');
const { forbidden } = require('../../utils/errors');
const platformService = require('./platform.service');
const { createOrganizationService } = require('./organization.service');
const schemas = require('./organization.schemas');

const router = express.Router();
const service = createOrganizationService({ ...db, logger, decryptField, hashPassword: (password) => bcrypt.hash(password, 12) });
const WRITE_ROLES = new Set(['platform_superadmin', 'platform_support']);

// Restricted to organization routes, not the shared authentication middleware.
router.use(asyncHandler(async (req, res, next) => {
  const actor = await platformService.getPlatformUserById(req.auth.sub);
  if (!actor.menus.includes('organizations')) throw forbidden('ไม่มีสิทธิ์เข้าถึงองค์กร');
  req.platformOrganizationActor = actor;
  res.set('Cache-Control', 'no-store');
  next();
}));

router.get('/:organizationId/markets', validate(schemas.listSchema), asyncHandler(async (req, res) => ok(res, await service.listMarkets(req.validated.params.organizationId, req.validated.query))));
router.get('/:organizationId/markets/:marketId/zones', validate(schemas.zonesSchema), asyncHandler(async (req, res) => ok(res, await service.listZones(req.validated.params.organizationId, req.validated.params.marketId, req.validated.query))));
router.get('/:organizationId/markets/:marketId/booths', validate(schemas.boothsSchema), asyncHandler(async (req, res) => ok(res, await service.listBooths(req.validated.params.organizationId, req.validated.params.marketId, req.validated.query))));
router.get('/:organizationId/users', validate(schemas.listSchema), asyncHandler(async (req, res) => {
  const data = await service.listUsers(req.validated.params.organizationId, req.validated.query);
  return ok(res, { ...data, canManage: WRITE_ROLES.has(req.platformOrganizationActor.role) });
}));
router.patch('/:organizationId/users/:userId', (req, res, next) => {
  if (!WRITE_ROLES.has(req.platformOrganizationActor.role)) return next(forbidden('ไม่มีสิทธิ์จัดการผู้ใช้งานองค์กร'));
  return next();
}, validate(schemas.userSchema), asyncHandler(async (req, res) => ok(res, await service.updateUser(req.validated.params.organizationId, req.validated.params.userId, req.validated.body, req.auth.sub))));
router.get('/:organizationId/bookings', validate(schemas.bookingsSchema), asyncHandler(async (req, res) => ok(res, await service.listBookings(req.validated.params.organizationId, req.validated.query))));

module.exports = router;
