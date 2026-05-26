const express = require('express');
const { z } = require('zod');
const { query, transaction } = require('../../config/db');
const { authenticate } = require('../../middlewares/auth');
const { requireRoles, requireMarketAccess } = require('../../middlewares/rbac');
const { validate } = require('../../middlewares/validate');
const { ROLES } = require('../../constants/roles');
const { asyncHandler } = require('../../utils/async-handler');
const { ok, created } = require('../../utils/api-response');
const { notFound } = require('../../utils/errors');
const { calculateVatBreakdown, getOrganizationVatSettings } = require('../../utils/vat');
const authService = require('../auth/auth.service');

const router = express.Router();

router.post(
  '/auth/login',
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

router.use(authenticate, requireRoles(ROLES.AUDIT));

router.get(
  '/summary',
  asyncHandler(async (req, res) => {
    const bookingDate = req.query.date || new Date().toISOString().slice(0, 10);
    const marketIds = Array.isArray(req.auth.marketIds) ? req.auth.marketIds.filter(Boolean) : [];

    if (!marketIds.length) {
      return ok(res, {
        bookingDate,
        totalJobs: 0,
        pendingJobs: 0,
        violationJobs: 0,
        totalFineAmount: 0,
      });
    }

    const marketIdPlaceholders = marketIds.map((_, index) => `:marketId${index}`).join(', ');
    const marketParams = marketIds.reduce((accumulator, marketId, index) => {
      accumulator[`marketId${index}`] = marketId;
      return accumulator;
    }, {});

    const rows = await query(
      `SELECT COUNT(*) AS total_jobs,
              SUM(CASE
                    WHEN bi.audit_status IS NULL
                      OR bi.audit_status NOT IN ('pass', 'warning', 'failed')
                    THEN 1
                    ELSE 0
                  END) AS pending_jobs,
              SUM(CASE WHEN bi.audit_status = 'failed' THEN 1 ELSE 0 END) AS violation_jobs,
              COALESCE(SUM(COALESCE(ac_latest.total_fine_amount, 0)), 0) AS total_fine_amount
       FROM booking_items bi
       JOIN bookings b ON b.id = bi.booking_id
       LEFT JOIN audit_checks ac_latest
         ON ac_latest.id = (
           SELECT ac2.id
           FROM audit_checks ac2
           WHERE ac2.booking_item_id = bi.id
           ORDER BY ac2.id DESC
           LIMIT 1
         )
       WHERE bi.organization_id = :organizationId
         AND b.market_id IN (${marketIdPlaceholders})
         AND b.status = 'paid'
         AND bi.booking_date = :bookingDate`,
      {
        organizationId: req.auth.organizationId,
        bookingDate,
        ...marketParams,
      },
    );

    const summary = rows[0] || {};
    return ok(res, {
      bookingDate,
      totalJobs: Number(summary.total_jobs || 0),
      pendingJobs: Number(summary.pending_jobs || 0),
      violationJobs: Number(summary.violation_jobs || 0),
      totalFineAmount: Number(summary.total_fine_amount || 0),
    });
  }),
);

router.get(
  '/markets/:marketId/bookings',
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const bookingDate = req.query.date || new Date().toISOString().slice(0, 10);
    const rows = await query(
      `SELECT bi.id AS booking_item_id, b.public_id AS booking_public_id, bi.booking_date,
              bo.name AS booth_name, bi.audit_status, b.mobile_user_id
       FROM booking_items bi
       JOIN bookings b ON b.id = bi.booking_id
       JOIN booths bo ON bo.id = bi.booth_id
       WHERE bi.organization_id = :organizationId
         AND b.market_id = :marketId
         AND bi.booking_date = :bookingDate
         AND b.status = 'paid'
       ORDER BY bo.sort_order ASC, bo.name ASC`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId), bookingDate },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/markets/:marketId/checks',
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({
        bookingItemId: z.coerce.number().int().positive(),
        result: z.enum(['pass', 'warning', 'failed']),
        note: z.string().optional().default(''),
        fineAmount: z.coerce.number().min(0).default(0),
        accessoriesFineAmount: z.coerce.number().min(0).default(0),
        damageFineAmount: z.coerce.number().min(0).default(0),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const result = await transaction(async (conn) => {
      const [items] = await conn.execute(
        `SELECT bi.id, bi.booking_id
         FROM booking_items bi
         JOIN bookings b ON b.id = bi.booking_id
         WHERE bi.id = :bookingItemId
           AND bi.organization_id = :organizationId
           AND b.market_id = :marketId
         LIMIT 1
         FOR UPDATE`,
        {
          bookingItemId: body.bookingItemId,
          organizationId: req.auth.organizationId,
          marketId: req.validated.params.marketId,
        },
      );
      if (!items.length) throw notFound('Booking item not found');

      const vatSettings = await getOrganizationVatSettings(conn, req.auth.organizationId);
      const fineSubtotal = body.fineAmount + body.accessoriesFineAmount + body.damageFineAmount;
      const fineTotals = calculateVatBreakdown(fineSubtotal, 0, vatSettings);
      const [check] = await conn.execute(
        `INSERT INTO audit_checks (
          organization_id, market_id, booking_item_id, checked_by_admin_id,
          result, note, fine_amount, accessories_fine_amount, damage_fine_amount, vat_amount, total_fine_amount,
          fine_payment_status
        ) VALUES (
          :organizationId, :marketId, :bookingItemId, :checkedByAdminId,
          :result, :note, :fineAmount, :accessoriesFineAmount, :damageFineAmount, :vatAmount, :totalFineAmount,
          :finePaymentStatus
        )`,
        {
          organizationId: req.auth.organizationId,
          marketId: req.validated.params.marketId,
          bookingItemId: body.bookingItemId,
          checkedByAdminId: req.auth.sub,
          result: body.result,
          note: body.note,
          fineAmount: body.fineAmount,
          accessoriesFineAmount: body.accessoriesFineAmount,
          damageFineAmount: body.damageFineAmount,
          vatAmount: fineTotals.vatAmount,
          totalFineAmount: fineTotals.totalAmount,
          finePaymentStatus: fineTotals.totalAmount > 0 ? 'pending' : 'none',
        },
      );

      await conn.execute(
        `UPDATE booking_items
         SET audit_status = :auditStatus
         WHERE id = :bookingItemId AND organization_id = :organizationId`,
        { auditStatus: body.result, bookingItemId: body.bookingItemId, organizationId: req.auth.organizationId },
      );

      return { id: check.insertId, vatAmount: fineTotals.vatAmount, totalFineAmount: fineTotals.totalAmount };
    });

    return created(res, result, 'audit check saved');
  }),
);

module.exports = router;
