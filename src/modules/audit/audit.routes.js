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
const { decryptField } = require('../../utils/crypto');
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
  '/inspections',
  validate(
    z.object({
      query: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        filter: z.enum(['all', 'pending', 'violation', 'fine']).optional().default('all'),
      }).passthrough(),
      params: z.object({}).passthrough(),
      body: z.any().optional(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const bookingDate = req.validated.query.date || new Date().toISOString().slice(0, 10);
    const filter = req.validated.query.filter || 'all';
    const marketIds = Array.isArray(req.auth.marketIds) ? req.auth.marketIds.filter(Boolean) : [];

    if (!marketIds.length) {
      return ok(res, { bookingDate, filter, items: [] });
    }

    const marketIdPlaceholders = marketIds.map((_, index) => `:marketId${index}`).join(', ');
    const marketParams = marketIds.reduce((accumulator, marketId, index) => {
      accumulator[`marketId${index}`] = marketId;
      return accumulator;
    }, {});

    const filterSql = {
      all: '',
      pending: `AND (bi.audit_status IS NULL OR bi.audit_status = 'pending')`,
      violation: `AND bi.audit_status = 'failed'`,
      fine: `AND COALESCE(ac_latest.total_fine_amount, 0) > 0`,
    }[filter];

    const rows = await query(
      `SELECT
          bi.id AS booking_item_id,
          bi.booking_id,
          b.public_id AS booking_public_id,
          DATE_FORMAT(bi.booking_date, '%Y-%m-%d') AS booking_date,
          bi.audit_status,
          bi.checked_in_at,
          b.market_id,
          b.paid_at AS booking_paid_at,
          m.name AS market_name,
          bo.code AS booth_code,
          bo.name AS booth_name,
          mu.first_name_enc,
          mu.last_name_enc,
          ac_latest.result AS latest_audit_result,
          ac_latest.total_fine_amount AS latest_fine_amount,
          ac_latest.checked_at AS latest_checked_at,
          payment_summary.paid_at AS payment_paid_at
       FROM booking_items bi
       JOIN bookings b
         ON b.id = bi.booking_id
        AND b.organization_id = bi.organization_id
       JOIN markets m
         ON m.id = b.market_id
        AND m.organization_id = b.organization_id
       JOIN booths bo
         ON bo.id = bi.booth_id
        AND bo.organization_id = bi.organization_id
       LEFT JOIN mobile_users mu
         ON mu.id = b.mobile_user_id
        AND mu.organization_id = b.organization_id
       LEFT JOIN audit_checks ac_latest
         ON ac_latest.id = (
           SELECT ac2.id
           FROM audit_checks ac2
           WHERE ac2.booking_item_id = bi.id
           ORDER BY ac2.id DESC
           LIMIT 1
         )
       LEFT JOIN (
         SELECT organization_id, booking_id, MAX(COALESCE(paid_at, created_at)) AS paid_at
         FROM payments
         WHERE status = 'paid'
         GROUP BY organization_id, booking_id
       ) payment_summary
         ON payment_summary.booking_id = b.id
        AND payment_summary.organization_id = b.organization_id
       WHERE bi.organization_id = :organizationId
         AND b.market_id IN (${marketIdPlaceholders})
         AND b.status = 'paid'
         AND bi.status = 'paid'
         AND bi.booking_date = :bookingDate
         ${filterSql}
       ORDER BY m.name ASC, bo.sort_order ASC, bo.name ASC, b.public_id ASC`,
      {
        organizationId: req.auth.organizationId,
        bookingDate,
        ...marketParams,
      },
    );

    return ok(res, {
      bookingDate,
      filter,
      items: rows.map((row) => {
        const firstName = decryptField(row.first_name_enc) || '';
        const lastName = decryptField(row.last_name_enc) || '';
        return {
          bookingItemId: row.booking_item_id,
          bookingId: row.booking_id,
          bookingPublicId: row.booking_public_id,
          bookingDate: row.booking_date,
          marketId: row.market_id,
          marketName: row.market_name,
          boothCode: row.booth_code,
          boothName: row.booth_name,
          customerName: [firstName, lastName].filter(Boolean).join(' ').trim() || 'ไม่ระบุชื่อ',
          auditStatus: row.audit_status || 'pending',
          latestAuditResult: row.latest_audit_result || null,
          latestFineAmount: Number(row.latest_fine_amount || 0),
          latestCheckedAt: row.latest_checked_at || null,
          checkedInAt: row.checked_in_at || null,
          checkinStatus: row.checked_in_at ? 'checked_in' : 'waiting',
          paidAt: row.booking_paid_at || row.payment_paid_at || null,
        };
      }),
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
