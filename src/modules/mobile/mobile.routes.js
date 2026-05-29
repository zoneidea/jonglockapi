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
const { PAYMENT_EXPIRES_MINUTES } = require('../../constants/booking');
const { applyVatToAmount, calculateVatBreakdown, getOrganizationVatSettings } = require('../../utils/vat');
const { assertPlanQuota, requireSubscriptionForMutations } = require('../../services/subscription.service');
const authService = require('../auth/auth.service');

const router = express.Router();

function arrayPlaceholders(values, prefix) {
  return values.map((_, index) => `:${prefix}${index}`).join(', ');
}

function arrayParams(values, prefix) {
  return values.reduce((params, value, index) => {
    params[`${prefix}${index}`] = value;
    return params;
  }, {});
}

function dateKey(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value || '').slice(0, 10);
}

function buildInsertRows(rows, columns, prefix) {
  const params = {};
  const valuesSql = rows.map((row, rowIndex) => {
    const placeholders = columns.map((column) => {
      const key = `${prefix}${rowIndex}_${column.key}`;
      params[key] = row[column.key];
      return `:${key}`;
    });
    return `(${placeholders.join(', ')})`;
  });
  return { sql: valuesSql.join(', '), params };
}

function isDuplicateKeyError(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

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
         CASE
           WHEN bdl.id IS NULL THEN 'available'
           WHEN bdl.status = 'paid' THEN 'paid'
           WHEN bdl.status = 'processing' THEN 'payment_processing'
           ELSE 'pending_payment'
         END AS booking_status
       FROM booths b
       LEFT JOIN booth_date_locks bdl
         ON bdl.booth_id = b.id
        AND bdl.organization_id = b.organization_id
        AND bdl.market_id = b.market_id
        AND bdl.booking_date = :bookingDate
        AND bdl.status IN ('held', 'processing', 'paid')
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
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    await assertPlanQuota(req.auth.organizationId, 'booking_management', items.length);
    const vatSettings = await getOrganizationVatSettings({ execute: query }, req.auth.organizationId);
    const result = await transaction(async (conn) => {
      const [marketRows] = await conn.execute(
        `SELECT id FROM markets WHERE id = :marketId AND organization_id = :organizationId AND status = 'active' LIMIT 1`,
        { marketId, organizationId: req.auth.organizationId },
      );
      if (!marketRows.length) throw notFound('Market not found');

      const boothIds = Array.from(new Set(items.map((item) => Number(item.boothId))));
      const [boothRows] = await conn.execute(
        `SELECT id, floor_plan_id, price
         FROM booths
         WHERE organization_id = :organizationId
           AND market_id = :marketId
           AND status = 'active'
           AND id IN (${arrayPlaceholders(boothIds, 'boothId')})
         ORDER BY id ASC`,
        {
          organizationId: req.auth.organizationId,
          marketId,
          ...arrayParams(boothIds, 'boothId'),
        },
      );
      const boothById = new Map(boothRows.map((booth) => [Number(booth.id), booth]));

      const requestedAccessories = items.flatMap((item) => item.accessories || []);
      const accessoryIds = Array.from(new Set(requestedAccessories.map((accessory) => Number(accessory.accessoryId))));
      let accessoryById = new Map();
      if (accessoryIds.length) {
        const [accessoryRows] = await conn.execute(
          `SELECT id, price
           FROM accessories
           WHERE organization_id = :organizationId
             AND market_id = :marketId
             AND status = 'active'
             AND id IN (${arrayPlaceholders(accessoryIds, 'accessoryId')})
           ORDER BY id ASC`,
          {
            organizationId: req.auth.organizationId,
            marketId,
            ...arrayParams(accessoryIds, 'accessoryId'),
          },
        );
        accessoryById = new Map(accessoryRows.map((accessory) => [Number(accessory.id), accessory]));
      }

      let subtotal = 0;
      const pricedItems = [];
      const itemKeys = new Set();
      for (const item of items) {
        const duplicateKey = `${item.boothId}:${item.bookingDate}`;
        if (itemKeys.has(duplicateKey)) throw badRequest(`Booth ${item.boothId} on ${item.bookingDate} is duplicated`);
        itemKeys.add(duplicateKey);

        const booth = boothById.get(Number(item.boothId));
        if (!booth) throw badRequest(`Booth ${item.boothId} is not available`);

        const unitPrice = Number(booth.price || 0);
        let accessoryAmount = 0;
        for (const accessory of item.accessories) {
          const accessoryRow = accessoryById.get(Number(accessory.accessoryId));
          if (!accessoryRow) throw badRequest(`Accessory ${accessory.accessoryId} is not available`);
          accessoryAmount += Number(accessoryRow.price || 0) * Number(accessory.quantity || 1);
        }
        subtotal += unitPrice + accessoryAmount;
        pricedItems.push({ ...item, floorPlanId: booth.floor_plan_id, unitPrice });
      }
      const totals = calculateVatBreakdown(subtotal, 0, vatSettings);

      const publicBookingId = publicId('BK');
      const [bookingResult] = await conn.execute(
        `INSERT INTO bookings (
          organization_id, public_id, market_id, mobile_user_id, source, status,
          subtotal_amount, discount_amount, vat_amount, total_amount, expires_at
        ) VALUES (
          :organizationId, :publicId, :marketId, :mobileUserId, 'mobile', 'pending_payment',
          :subtotalAmount, :discountAmount, :vatAmount, :totalAmount, DATE_ADD(NOW(), INTERVAL ${PAYMENT_EXPIRES_MINUTES} MINUTE)
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
      const [createdBookings] = await conn.execute(
        `SELECT expires_at FROM bookings WHERE id = :bookingId AND organization_id = :organizationId LIMIT 1`,
        { organizationId: req.auth.organizationId, bookingId: bookingResult.insertId },
      );
      const expiresAt = createdBookings[0]?.expires_at || null;

      const lockRows = pricedItems.map((item) => ({
        organizationId: req.auth.organizationId,
        marketId,
        floorPlanId: item.floorPlanId,
        boothId: item.boothId,
        bookingId: bookingResult.insertId,
        bookingItemId: null,
        bookingDate: item.bookingDate,
        status: 'held',
        expiresAt,
      }));
      const lockInsert = buildInsertRows(lockRows, [
        { key: 'organizationId' },
        { key: 'marketId' },
        { key: 'floorPlanId' },
        { key: 'boothId' },
        { key: 'bookingId' },
        { key: 'bookingItemId' },
        { key: 'bookingDate' },
        { key: 'status' },
        { key: 'expiresAt' },
      ], 'lock');
      try {
        await conn.execute(
          `INSERT INTO booth_date_locks (
            organization_id, market_id, floor_plan_id, booth_id, booking_id, booking_item_id,
            booking_date, status, expires_at
          ) VALUES ${lockInsert.sql}`,
          lockInsert.params,
        );
      } catch (error) {
        if (isDuplicateKeyError(error)) throw conflict('Some selected booth dates are no longer available');
        throw error;
      }

      const itemRows = pricedItems.map((item) => ({
        organizationId: req.auth.organizationId,
        bookingId: bookingResult.insertId,
        boothId: item.boothId,
        bookingDate: item.bookingDate,
        unitPrice: item.unitPrice,
        status: 'pending_payment',
      }));
      const itemInsert = buildInsertRows(itemRows, [
        { key: 'organizationId' },
        { key: 'bookingId' },
        { key: 'boothId' },
        { key: 'bookingDate' },
        { key: 'unitPrice' },
        { key: 'status' },
      ], 'item');
      await conn.execute(
        `INSERT INTO booking_items (
          organization_id, booking_id, booth_id, booking_date, unit_price, status
        ) VALUES ${itemInsert.sql}`,
        itemInsert.params,
      );

      await conn.execute(
        `UPDATE booth_date_locks bdl
         JOIN booking_items bi
           ON bi.organization_id = bdl.organization_id
          AND bi.booking_id = bdl.booking_id
          AND bi.booth_id = bdl.booth_id
          AND bi.booking_date = bdl.booking_date
         SET bdl.booking_item_id = bi.id
         WHERE bdl.organization_id = :organizationId
           AND bdl.booking_id = :bookingId`,
        { organizationId: req.auth.organizationId, bookingId: bookingResult.insertId },
      );

      const [createdItems] = await conn.execute(
        `SELECT id, booth_id, DATE_FORMAT(booking_date, '%Y-%m-%d') AS booking_date
         FROM booking_items
         WHERE organization_id = :organizationId AND booking_id = :bookingId`,
        { organizationId: req.auth.organizationId, bookingId: bookingResult.insertId },
      );
      const bookingItemByBoothDate = new Map(createdItems.map((item) => [`${item.booth_id}:${dateKey(item.booking_date)}`, item.id]));

      const bookingProductRows = [];
      const bookingAccessoryRows = [];
      for (const item of pricedItems) {
        const bookingItemId = bookingItemByBoothDate.get(`${item.boothId}:${item.bookingDate}`);
        if (!bookingItemId) throw badRequest(`Booking item for booth ${item.boothId} on ${item.bookingDate} was not created`);

        for (const productId of item.productIds) {
          bookingProductRows.push({
            organizationId: req.auth.organizationId,
            bookingItemId,
            productId,
          });
        }

        for (const accessory of item.accessories) {
          bookingAccessoryRows.push({
            organizationId: req.auth.organizationId,
            bookingItemId,
            accessoryId: accessory.accessoryId,
            quantity: accessory.quantity,
          });
        }
      }

      if (bookingProductRows.length) {
        const productInsert = buildInsertRows(bookingProductRows, [
          { key: 'organizationId' },
          { key: 'bookingItemId' },
          { key: 'productId' },
        ], 'product');
        await conn.execute(
          `INSERT INTO booking_products (organization_id, booking_item_id, product_id)
           VALUES ${productInsert.sql}`,
          productInsert.params,
        );
      }

      if (bookingAccessoryRows.length) {
        const accessoryInsert = buildInsertRows(bookingAccessoryRows, [
          { key: 'organizationId' },
          { key: 'bookingItemId' },
          { key: 'accessoryId' },
          { key: 'quantity' },
        ], 'bookingAccessory');
        await conn.execute(
          `INSERT INTO booking_accessories (organization_id, booking_item_id, accessory_id, quantity)
           VALUES ${accessoryInsert.sql}`,
          accessoryInsert.params,
        );
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
