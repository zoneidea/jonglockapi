const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { query, transaction } = require('../../config/db');
const { authenticate } = require('../../middlewares/auth');
const { requireMobileAccount } = require('../../middlewares/rbac');
const { validate } = require('../../middlewares/validate');
const { asyncHandler } = require('../../utils/async-handler');
const { ok, created } = require('../../utils/api-response');
const { badRequest, conflict, forbidden, notFound } = require('../../utils/errors');
const { encryptField, blindIndex } = require('../../utils/crypto');
const { publicId } = require('../../utils/id');
const { assertPasswordPolicy, PASSWORD_POLICY_MESSAGE } = require('../../utils/password-policy');
const { expireStaleBookings } = require('../../utils/booking-status');
const { applyVatToAmount, calculateVatBreakdown, getOrganizationVatSettings } = require('../../utils/vat');
const { requireSubscriptionForMutations } = require('../../services/subscription.service');
const authService = require('../auth/auth.service');

const router = express.Router();

const loginSchema = z.object({
  body: z.object({
    organizationId: z.coerce.number().int().positive(),
    username: z.string().min(1),
    password: z.string().min(1),
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

router.post(
  '/auth/login',
  validate(loginSchema),
  asyncHandler(async (req, res) => {
    const result = await authService.loginMobile(req.validated.body);
    return ok(res, result);
  }),
);

const registerSchema = z.object({
  body: z.object({
    organizationId: z.coerce.number().int().positive(),
    username: z.string().min(3),
    password: z.string().min(10).refine(assertPasswordPolicy, PASSWORD_POLICY_MESSAGE),
    firstName: z.string().min(1),
    lastName: z.string().min(1),
    phone: z.string().optional().default(''),
    email: z.string().email().optional().or(z.literal('')).default(''),
    idCard: z.string().optional().default(''),
    address: z.string().optional().default(''),
    acceptedConsent: z.boolean().default(false),
  }),
  query: z.object({}).passthrough(),
  params: z.object({}).passthrough(),
});

router.post(
  '/auth/register',
  validate(registerSchema),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const organization = await query(`SELECT id FROM organizations WHERE id = :id AND status = 'active'`, {
      id: body.organizationId,
    });
    if (!organization.length) throw badRequest('Organization is not active');

    const usernameHash = blindIndex(body.username);
    const existing = await query(
      `SELECT id FROM mobile_users WHERE organization_id = :organizationId AND username_hash = :usernameHash LIMIT 1`,
      { organizationId: body.organizationId, usernameHash },
    );
    if (existing.length) throw conflict('Username already exists');

    const passwordHash = await bcrypt.hash(body.password, 12);
    const result = await query(
      `INSERT INTO mobile_users (
        organization_id, public_id, username_hash, password_hash,
        first_name_enc, last_name_enc, phone_enc, phone_hash,
        email_enc, email_hash, id_card_enc, id_card_hash, address_enc,
        accepted_consent_at, status
      ) VALUES (
        :organizationId, :publicId, :usernameHash, :passwordHash,
        :firstNameEnc, :lastNameEnc, :phoneEnc, :phoneHash,
        :emailEnc, :emailHash, :idCardEnc, :idCardHash, :addressEnc,
        :acceptedConsentAt, 'active'
      )`,
      {
        organizationId: body.organizationId,
        publicId: publicId('MB'),
        usernameHash,
        passwordHash,
        firstNameEnc: encryptField(body.firstName),
        lastNameEnc: encryptField(body.lastName),
        phoneEnc: encryptField(body.phone),
        phoneHash: blindIndex(body.phone),
        emailEnc: encryptField(body.email),
        emailHash: blindIndex(body.email),
        idCardEnc: encryptField(body.idCard),
        idCardHash: blindIndex(body.idCard),
        addressEnc: encryptField(body.address),
        acceptedConsentAt: body.acceptedConsent ? new Date() : null,
      },
    );

    return created(res, { id: result.insertId }, 'registered');
  }),
);

router.use(authenticate, requireMobileAccount);
router.use(requireSubscriptionForMutations({
  resolveFeature: () => 'mobile_booking_app',
}));

router.get(
  '/markets',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, code, name, description, open_date, close_date, status
       FROM markets
       WHERE organization_id = :organizationId AND status = 'active'
       ORDER BY name`,
      { organizationId: req.auth.organizationId },
    );
    return ok(res, rows);
  }),
);

router.get(
  '/markets/:marketId/floor-plans',
  asyncHandler(async (req, res) => {
    const marketId = Number(req.params.marketId);
    const rows = await query(
      `SELECT id, name, start_date, end_date, status
       FROM floor_plans
       WHERE organization_id = :organizationId
         AND market_id = :marketId
         AND status = 'active'
       ORDER BY start_date DESC, id DESC`,
      { organizationId: req.auth.organizationId, marketId },
    );
    return ok(res, rows);
  }),
);

router.get(
  '/markets/:marketId/booths',
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const marketId = Number(req.params.marketId);
    const bookingDate = req.query.date;
    const categoryId = req.query.categoryId ? Number(req.query.categoryId) : null;
    if (!bookingDate) throw badRequest('date is required');

    const rows = await query(
      `SELECT
         b.id, b.code, b.name, b.price, b.category_id,
         CASE WHEN bi.id IS NULL THEN 'available' ELSE bk.status END AS booking_status
       FROM booths b
       LEFT JOIN booking_items bi
         ON bi.booth_id = b.id
        AND bi.booking_date = :bookingDate
        AND bi.status IN ('pending_payment', 'paid', 'payment_processing')
       LEFT JOIN bookings bk
         ON bk.id = bi.booking_id
        AND bk.status IN ('pending_payment', 'paid', 'payment_processing')
       WHERE b.organization_id = :organizationId
         AND b.market_id = :marketId
         AND b.status = 'active'
         AND (:categoryId IS NULL OR b.category_id = :categoryId)
       ORDER BY b.sort_order ASC, b.name ASC`,
      { organizationId: req.auth.organizationId, marketId, bookingDate, categoryId },
    );

    const vatSettings = await getOrganizationVatSettings({ execute: query }, req.auth.organizationId);
    return ok(res, rows.map((row) => ({ ...row, gross_price: applyVatToAmount(row.price, vatSettings) })));
  }),
);

router.post(
  '/bookings',
  validate(
    z.object({
      body: z.object({
        marketId: z.coerce.number().int().positive(),
        items: z
          .array(
            z.object({
              boothId: z.coerce.number().int().positive(),
              bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              productIds: z.array(z.coerce.number().int().positive()).default([]),
              accessories: z
                .array(z.object({ accessoryId: z.coerce.number().int().positive(), quantity: z.coerce.number().int().positive() }))
                .default([]),
            }),
          )
          .min(1),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { marketId, items } = req.validated.body;
    const result = await transaction(async (conn) => {
      await expireStaleBookings(conn, req.auth.organizationId);
      const [marketRows] = await conn.execute(
        `SELECT id FROM markets WHERE id = :marketId AND organization_id = :organizationId AND status = 'active' FOR UPDATE`,
        { marketId, organizationId: req.auth.organizationId },
      );
      if (!marketRows.length) throw notFound('Market not found');

      const vatSettings = await getOrganizationVatSettings(conn, req.auth.organizationId);
      let subtotal = 0;
      const pricedItems = [];
      for (const item of items) {
        const [boothRows] = await conn.execute(
          `SELECT id, price FROM booths
           WHERE id = :boothId AND market_id = :marketId AND organization_id = :organizationId AND status = 'active'
           FOR UPDATE`,
          { boothId: item.boothId, marketId, organizationId: req.auth.organizationId },
        );
        if (!boothRows.length) throw badRequest(`Booth ${item.boothId} is not available`);

        const [locked] = await conn.execute(
          `SELECT bi.id
           FROM booking_items bi
           JOIN bookings bk ON bk.id = bi.booking_id
           WHERE bi.booth_id = :boothId
             AND bi.booking_date = :bookingDate
             AND bi.status IN ('pending_payment', 'paid', 'payment_processing')
             AND bk.status IN ('pending_payment', 'paid', 'payment_processing')
           LIMIT 1
           FOR UPDATE`,
          { boothId: item.boothId, bookingDate: item.bookingDate },
        );
        if (locked.length) throw conflict(`Booth ${item.boothId} has already been booked on ${item.bookingDate}`);
        const unitPrice = Number(boothRows[0].price || 0);
        let accessoryAmount = 0;
        for (const accessory of item.accessories) {
          const [accessoryRows] = await conn.execute(
            `SELECT id, price
             FROM accessories
             WHERE id = :accessoryId
               AND organization_id = :organizationId
               AND market_id = :marketId
               AND status = 'active'
             LIMIT 1`,
            {
              accessoryId: accessory.accessoryId,
              organizationId: req.auth.organizationId,
              marketId,
            },
          );
          if (!accessoryRows.length) throw badRequest(`Accessory ${accessory.accessoryId} is not available`);
          accessoryAmount += Number(accessoryRows[0].price || 0) * Number(accessory.quantity || 1);
        }
        subtotal += unitPrice + accessoryAmount;
        pricedItems.push({ ...item, unitPrice });
      }
      const totals = calculateVatBreakdown(subtotal, 0, vatSettings);

      const publicBookingId = publicId('BK');
      const [bookingResult] = await conn.execute(
        `INSERT INTO bookings (
          organization_id, public_id, market_id, mobile_user_id, source, status,
          subtotal_amount, discount_amount, vat_amount, total_amount, expires_at
        ) VALUES (
          :organizationId, :publicId, :marketId, :mobileUserId, 'mobile', 'pending_payment',
          :subtotalAmount, :discountAmount, :vatAmount, :totalAmount, DATE_ADD(NOW(), INTERVAL 30 MINUTE)
        )`,
        {
          organizationId: req.auth.organizationId,
          publicId: publicBookingId,
          marketId,
          mobileUserId: req.auth.sub,
          subtotalAmount: totals.subtotalAmount,
          discountAmount: totals.discountAmount,
          vatAmount: totals.vatAmount,
          totalAmount: totals.totalAmount,
        },
      );

      for (const item of pricedItems) {
        const [detailResult] = await conn.execute(
          `INSERT INTO booking_items (
            organization_id, booking_id, booth_id, booking_date, unit_price, status
          ) VALUES (
            :organizationId, :bookingId, :boothId, :bookingDate, :unitPrice, 'pending_payment'
          )`,
          {
            organizationId: req.auth.organizationId,
            bookingId: bookingResult.insertId,
            boothId: item.boothId,
            bookingDate: item.bookingDate,
            unitPrice: item.unitPrice,
          },
        );

        for (const productId of item.productIds) {
          await conn.execute(
            `INSERT INTO booking_products (organization_id, booking_item_id, product_id)
             VALUES (:organizationId, :bookingItemId, :productId)`,
            { organizationId: req.auth.organizationId, bookingItemId: detailResult.insertId, productId },
          );
        }

        for (const accessory of item.accessories) {
          await conn.execute(
            `INSERT INTO booking_accessories (organization_id, booking_item_id, accessory_id, quantity)
             VALUES (:organizationId, :bookingItemId, :accessoryId, :quantity)`,
            {
              organizationId: req.auth.organizationId,
              bookingItemId: detailResult.insertId,
              accessoryId: accessory.accessoryId,
              quantity: accessory.quantity,
            },
          );
        }
      }

      return { id: bookingResult.insertId, publicId: publicBookingId, ...totals };
    });

    return created(res, result, 'booking created');
  }),
);

router.get(
  '/bookings',
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    if (req.auth.userType !== 'customer') throw forbidden('Customer account is required');

    const rows = await query(
      `SELECT id, public_id, market_id, status, subtotal_amount, discount_amount, vat_amount, total_amount, expires_at, created_at
       FROM bookings
       WHERE organization_id = :organizationId AND mobile_user_id = :mobileUserId
       ORDER BY created_at DESC
       LIMIT 100`,
      { organizationId: req.auth.organizationId, mobileUserId: req.auth.sub },
    );
    return ok(res, rows);
  }),
);

module.exports = router;
