const express = require('express');
const env = require('../../config/env');
const { query } = require('../../config/db');
const { asyncHandler } = require('../../utils/async-handler');
const { ok } = require('../../utils/api-response');
const { forbidden } = require('../../utils/errors');
const { expireStaleBookings } = require('../../utils/booking-status');
const { cleanupExpiredBoothTempLocks } = require('../../services/firestore-locks.service');

const router = express.Router();

function requireCronSecret(req) {
  if (!env.CRON_SECRET) return;
  const provided = req.get('x-cron-secret') || req.query.secret || '';
  if (provided !== env.CRON_SECRET) throw forbidden('Invalid cron secret');
}

const expireBookingsHandler = asyncHandler(async (req, res) => {
  requireCronSecret(req);
  const organizationId = req.body?.organizationId || req.query.organizationId;
  const organizations = organizationId
    ? [{ id: Number(organizationId) }]
    : await query(`SELECT id FROM organizations WHERE status = 'active'`, {});

  const results = [];
  for (const organization of organizations) {
    const result = await expireStaleBookings({ execute: query }, organization.id);
    results.push({ organizationId: organization.id, ...result });
  }
  const firestoreCleanup = await cleanupExpiredBoothTempLocks();

  return ok(res, {
    checkedOrganizations: results.length,
    expiredBookings: results.reduce((total, item) => total + Number(item.expiredBookings || 0), 0),
    releasedLocks: results.reduce((total, item) => total + Number(item.releasedLocks || 0), 0),
    firestoreCleanup,
    results,
  });
});

router.post('/expire-bookings', expireBookingsHandler);
router.get('/expire-bookings', expireBookingsHandler);

module.exports = router;
