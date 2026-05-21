const express = require('express');
const bcrypt = require('bcryptjs');
const { z } = require('zod');
const { query, transaction } = require('../../config/db');
const { validate } = require('../../middlewares/validate');
const { asyncHandler } = require('../../utils/async-handler');
const { ok, created } = require('../../utils/api-response');
const { blindIndex, encryptField } = require('../../utils/crypto');
const { publicId } = require('../../utils/id');
const { assertPasswordPolicy, PASSWORD_POLICY_MESSAGE } = require('../../utils/password-policy');
const { badRequest, conflict } = require('../../utils/errors');
const { expireStaleBookings } = require('../../utils/booking-status');
const { attachBookingItemToLock, insertBoothDateLock } = require('../../utils/booth-locks');
const { PAYMENT_EXPIRES_MINUTES } = require('../../constants/booking');
const { applyVatToAmount, calculateVatBreakdown, getOrganizationVatSettings } = require('../../utils/vat');

const router = express.Router();

function mapMarket(row) {
  const galleryImages = row.gallery_images
    ? String(row.gallery_images).split('||').filter(Boolean)
    : [];

  return {
    id: row.id,
    organizationId: row.organization_id,
    code: row.code,
    name: row.name,
    description: row.description || '',
    terms: row.terms || '',
    mainImageUrl: row.main_image_url || galleryImages[0] || '',
    address: row.address || '',
    openingHours: row.opening_hours || '',
    phone: row.phone || '',
    lineId: row.line_id || '',
    email: row.email || '',
    openDate: row.open_date,
    closeDate: row.close_date,
    galleryImages,
  };
}

function mapAnnouncement(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    marketId: row.market_id,
    marketCode: row.market_code || '',
    marketName: row.market_name || '',
    type: row.type,
    title: row.title,
    description: row.description || '',
    imageUrl: row.image_url || '',
    startDate: row.start_date,
    endDate: row.end_date,
    createdAt: row.created_at,
  };
}

function mapFloorPlan(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    marketId: row.market_id,
    name: row.name,
    planImageUrl: row.plan_image_url || '',
    startDate: row.start_date,
    endDate: row.end_date,
    status: row.status,
    boothCount: Number(row.booth_count || 0),
  };
}

function mapBooth(row) {
  return {
    id: row.id,
    organizationId: row.organization_id,
    marketId: row.market_id,
    floorPlanId: row.floor_plan_id,
    categoryId: row.category_id,
    categoryName: row.category_name || '',
    code: row.code,
    name: row.name,
    price: Number(row.price || 0),
    grossPrice: Number(row.gross_price || row.price || 0),
    status: row.status,
    availabilityStatus: row.availability_status,
  };
}

function todayIso() {
  return new Date().toISOString().slice(0, 10);
}

function datePlaceholders(dates) {
  return dates.map((_, index) => `:date${index}`).join(', ');
}

function dateParams(dates) {
  return dates.reduce((params, date, index) => ({ ...params, [`date${index}`]: date }), {});
}

function normalizeNameParts(name, fallbackEmail) {
  const cleanName = String(name || '').trim();
  if (!cleanName) {
    return {
      firstName: fallbackEmail.split('@')[0] || 'Mobile',
      lastName: '',
    };
  }
  const [firstName, ...lastNameParts] = cleanName.split(/\s+/);
  return {
    firstName,
    lastName: lastNameParts.join(' '),
  };
}

async function findOrCreatePublicMobileUser(conn, organizationId, user) {
  const email = String(user.email || '').trim().toLowerCase();
  if (!email) {
    throw badRequest('user.email is required');
  }

  const emailHash = blindIndex(email);
  const [existingRows] = await conn.execute(
    `SELECT id
     FROM mobile_users
     WHERE organization_id = :organizationId
       AND email_hash = :emailHash
       AND status <> 'deleted'
     LIMIT 1`,
    { organizationId, emailHash },
  );
  if (existingRows.length) {
    return existingRows[0].id;
  }

  const usernameHash = blindIndex(`gmail:${email}`);
  const { firstName, lastName } = normalizeNameParts(user.name, email);
  const passwordHash = await bcrypt.hash(publicId('GM'), 12);
  const [result] = await conn.execute(
    `INSERT INTO mobile_users (
      organization_id, public_id, username_hash, password_hash,
      first_name_enc, last_name_enc, email_enc, email_hash,
      accepted_consent_at, status
    ) VALUES (
      :organizationId, :publicId, :usernameHash, :passwordHash,
      :firstNameEnc, :lastNameEnc, :emailEnc, :emailHash,
      NOW(), 'active'
    )`,
    {
      organizationId,
      publicId: publicId('MB'),
      usernameHash,
      passwordHash,
      firstNameEnc: encryptField(firstName),
      lastNameEnc: encryptField(lastName),
      emailEnc: encryptField(email),
      emailHash,
    },
  );
  return result.insertId;
}

router.get(
  '/markets',
  asyncHandler(async (req, res) => {
    const search = String(req.query.q || '').trim();
    const params = {};
    const where = [`m.status = 'active'`, `o.status = 'active'`];

    if (search) {
      where.push(`(m.name LIKE :search OR m.code LIKE :search OR o.name LIKE :search)`);
      params.search = `%${search}%`;
    }

    const rows = await query(
      `SELECT
          m.id, m.organization_id, m.code, m.name, m.description, m.terms, m.main_image_url,
          m.address, m.opening_hours, m.phone, m.line_id, m.email, m.open_date, m.close_date,
          GROUP_CONCAT(mi.image_url ORDER BY mi.sort_order ASC, mi.id DESC SEPARATOR '||') AS gallery_images
       FROM markets m
       JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN market_images mi
         ON mi.market_id = m.id
        AND mi.organization_id = m.organization_id
        AND mi.status = 'active'
       WHERE ${where.join(' AND ')}
       GROUP BY m.id
       ORDER BY m.name ASC`,
      params,
    );

    return ok(res, rows.map(mapMarket));
  }),
);

router.get(
  '/markets/:marketId',
  asyncHandler(async (req, res) => {
    const marketId = Number(req.params.marketId);
    const rows = await query(
      `SELECT
          m.id, m.organization_id, m.code, m.name, m.description, m.terms, m.main_image_url,
          m.address, m.opening_hours, m.phone, m.line_id, m.email, m.open_date, m.close_date,
          GROUP_CONCAT(mi.image_url ORDER BY mi.sort_order ASC, mi.id DESC SEPARATOR '||') AS gallery_images
       FROM markets m
       JOIN organizations o ON o.id = m.organization_id
       LEFT JOIN market_images mi
         ON mi.market_id = m.id
        AND mi.organization_id = m.organization_id
        AND mi.status = 'active'
       WHERE m.id = :marketId
         AND m.status = 'active'
         AND o.status = 'active'
       GROUP BY m.id
       LIMIT 1`,
      { marketId },
    );

    return ok(res, rows[0] ? mapMarket(rows[0]) : null);
  }),
);

router.get(
  '/markets/:marketId/floor-plans',
  asyncHandler(async (req, res) => {
    const marketId = Number(req.params.marketId);
    const rows = await query(
      `SELECT
          fp.id, fp.organization_id, fp.market_id, fp.name, fp.plan_image_url,
          fp.start_date, fp.end_date, fp.status,
          COUNT(b.id) AS booth_count
       FROM floor_plans fp
       JOIN markets m
         ON m.id = fp.market_id
        AND m.organization_id = fp.organization_id
       JOIN organizations o ON o.id = fp.organization_id
       LEFT JOIN booths b
         ON b.floor_plan_id = fp.id
        AND b.organization_id = fp.organization_id
        AND b.market_id = fp.market_id
        AND b.status = 'active'
       WHERE fp.market_id = :marketId
         AND fp.status = 'active'
         AND m.status = 'active'
         AND o.status = 'active'
       GROUP BY fp.id
       ORDER BY fp.start_date DESC, fp.id DESC`,
      { marketId },
    );

    return ok(res, rows.map(mapFloorPlan));
  }),
);

router.get(
  '/floor-plans/:floorPlanId/booths',
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      params: z.object({ floorPlanId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { floorPlanId } = req.validated.params;
    const bookingDate = req.validated.query.date || todayIso();
    const [floorPlan] = await query(
      `SELECT fp.id, fp.organization_id, fp.market_id
       FROM floor_plans fp
       JOIN markets m
         ON m.id = fp.market_id
        AND m.organization_id = fp.organization_id
       JOIN organizations o ON o.id = fp.organization_id
       WHERE fp.id = :floorPlanId
         AND fp.status = 'active'
         AND m.status = 'active'
         AND o.status = 'active'
       LIMIT 1`,
      { floorPlanId },
    );

    if (!floorPlan) return ok(res, []);

    await expireStaleBookings({ execute: query }, floorPlan.organization_id);

    const rows = await query(
      `SELECT
          b.id, b.organization_id, b.market_id, b.floor_plan_id, b.category_id,
          c.name AS category_name, b.code, b.name, b.price, b.status,
          CASE
            WHEN b.status <> 'active' THEN 'unavailable'
            WHEN booking_state.availability_rank = 2 THEN 'booked'
            WHEN booking_state.availability_rank = 1 THEN 'processing'
            ELSE 'available'
          END AS availability_status
       FROM booths b
       LEFT JOIN product_categories c ON c.id = b.category_id
       LEFT JOIN (
         SELECT bdl.booth_id,
                MAX(CASE
                  WHEN bdl.status = 'paid' THEN 2
                  WHEN bdl.status IN ('held', 'processing') THEN 1
                  ELSE 0
                END) AS availability_rank
         FROM booth_date_locks bdl
         WHERE bdl.organization_id = :organizationId
           AND bdl.market_id = :marketId
           AND bdl.floor_plan_id = :floorPlanId
           AND bdl.booking_date = :bookingDate
           AND bdl.status IN ('held', 'processing', 'paid')
         GROUP BY bdl.booth_id
       ) booking_state ON booking_state.booth_id = b.id
       WHERE b.organization_id = :organizationId
         AND b.market_id = :marketId
         AND b.floor_plan_id = :floorPlanId
       ORDER BY b.sort_order ASC, b.code ASC, b.name ASC`,
      {
        organizationId: floorPlan.organization_id,
        marketId: floorPlan.market_id,
        floorPlanId,
        bookingDate,
      },
    );

    const vatSettings = await getOrganizationVatSettings({ execute: query }, floorPlan.organization_id);
    return ok(res, rows.map((row) => mapBooth({
      ...row,
      gross_price: applyVatToAmount(row.price, vatSettings),
    })));
  }),
);

router.post(
  '/floor-plans/:floorPlanId/booths/availability',
  validate(
    z.object({
      body: z.object({
        dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(90),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ floorPlanId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { floorPlanId } = req.validated.params;
    const dates = Array.from(new Set(req.validated.body.dates));
    const [floorPlan] = await query(
      `SELECT fp.id, fp.organization_id, fp.market_id
       FROM floor_plans fp
       JOIN markets m
         ON m.id = fp.market_id
        AND m.organization_id = fp.organization_id
       JOIN organizations o ON o.id = fp.organization_id
       WHERE fp.id = :floorPlanId
         AND fp.status = 'active'
         AND m.status = 'active'
         AND o.status = 'active'
       LIMIT 1`,
      { floorPlanId },
    );

    if (!floorPlan) return ok(res, []);

    await expireStaleBookings({ execute: query }, floorPlan.organization_id);

    const boothRows = await query(
      `SELECT
          b.id, b.organization_id, b.market_id, b.floor_plan_id, b.category_id,
          c.name AS category_name, b.code, b.name, b.price, b.status
       FROM booths b
       LEFT JOIN product_categories c ON c.id = b.category_id
       WHERE b.organization_id = :organizationId
         AND b.market_id = :marketId
         AND b.floor_plan_id = :floorPlanId
       ORDER BY b.sort_order ASC, b.code ASC, b.name ASC`,
      {
        organizationId: floorPlan.organization_id,
        marketId: floorPlan.market_id,
        floorPlanId,
      },
    );

    const lockedRows = await query(
      `SELECT bdl.booth_id, DATE_FORMAT(bdl.booking_date, '%Y-%m-%d') AS booking_date,
              MAX(CASE
                WHEN bdl.status = 'paid' THEN 2
                WHEN bdl.status IN ('held', 'processing') THEN 1
                ELSE 0
              END) AS availability_rank
       FROM booth_date_locks bdl
       WHERE bdl.organization_id = :organizationId
         AND bdl.market_id = :marketId
         AND bdl.floor_plan_id = :floorPlanId
         AND bdl.booking_date IN (${datePlaceholders(dates)})
         AND bdl.status IN ('held', 'processing', 'paid')
       GROUP BY bdl.booth_id, bdl.booking_date`,
      {
        organizationId: floorPlan.organization_id,
        marketId: floorPlan.market_id,
        floorPlanId,
        ...dateParams(dates),
      },
    );

    const lockedByBoothDate = new Map(
      lockedRows.map((row) => [
        `${row.booth_id}:${String(row.booking_date).slice(0, 10)}`,
        Number(row.availability_rank || 0),
      ]),
    );
    const vatSettings = await getOrganizationVatSettings({ execute: query }, floorPlan.organization_id);
    const rows = boothRows.map((booth) => {
      const dateAvailability = dates.map((date) => {
        if (booth.status !== 'active') {
          return { date, status: 'unavailable' };
        }
        const rank = lockedByBoothDate.get(`${booth.id}:${date}`) || 0;
        if (rank === 2) return { date, status: 'booked' };
        if (rank === 1) return { date, status: 'processing' };
        return { date, status: 'available' };
      });
      const availableCount = dateAvailability.filter((item) => item.status === 'available').length;
      let availabilityStatus = 'processing';
      if (booth.status !== 'active') {
        availabilityStatus = 'unavailable';
      } else if (availableCount === dates.length) {
        availabilityStatus = 'available';
      } else if (availableCount === 0) {
        availabilityStatus = 'booked';
      }

      return {
        ...mapBooth({
          ...booth,
          availability_status: availabilityStatus,
          gross_price: applyVatToAmount(booth.price, vatSettings),
        }),
        availabilityDates: dateAvailability,
        availableDateCount: availableCount,
        unavailableDateCount: dates.length - availableCount,
        selectedDateCount: dates.length,
      };
    });

    return ok(res, rows);
  }),
);

router.post(
  '/booths/:boothId/hold',
  validate(
    z.object({
      body: z.object({
        dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(90),
        user: z.object({
          email: z.string().email(),
          name: z.string().optional().default(''),
        }),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ boothId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { boothId } = req.validated.params;
    const requestedDates = Array.from(new Set(req.validated.body.dates)).sort();
    const result = await transaction(async (conn) => {
      const [boothRows] = await conn.execute(
        `SELECT
            b.id, b.organization_id, b.market_id, b.floor_plan_id, b.price, b.status,
            DATE_FORMAT(fp.start_date, '%Y-%m-%d') AS start_date,
            DATE_FORMAT(fp.end_date, '%Y-%m-%d') AS end_date
         FROM booths b
         JOIN floor_plans fp
           ON fp.id = b.floor_plan_id
          AND fp.organization_id = b.organization_id
          AND fp.market_id = b.market_id
         JOIN markets m
           ON m.id = b.market_id
          AND m.organization_id = b.organization_id
         JOIN organizations o ON o.id = b.organization_id
         WHERE b.id = :boothId
           AND b.status = 'active'
           AND fp.status = 'active'
           AND m.status = 'active'
           AND o.status = 'active'
         LIMIT 1
         FOR UPDATE`,
        { boothId },
      );
      if (!boothRows.length) {
        throw badRequest('Booth is not available');
      }

      const booth = boothRows[0];
      await expireStaleBookings(conn, booth.organization_id);

      const startDate = booth.start_date ? String(booth.start_date).slice(0, 10) : '';
      const endDate = booth.end_date ? String(booth.end_date).slice(0, 10) : '';
      const today = todayIso();
      const validDates = requestedDates.filter((date) => {
        if (date < today) return false;
        if (startDate && date < startDate) return false;
        if (endDate && date > endDate) return false;
        return true;
      });
      if (!validDates.length) {
        throw badRequest('No valid booking dates');
      }

      const [lockedRows] = await conn.execute(
        `SELECT DATE_FORMAT(booking_date, '%Y-%m-%d') AS booking_date
         FROM booth_date_locks
         WHERE organization_id = :organizationId
           AND booth_id = :boothId
           AND booking_date IN (${datePlaceholders(validDates)})
           AND status IN ('held', 'processing', 'paid')
         FOR UPDATE`,
        {
          organizationId: booth.organization_id,
          boothId,
          ...dateParams(validDates),
        },
      );
      const unavailableDateSet = new Set(lockedRows.map((row) => String(row.booking_date).slice(0, 10)));
      const lockedDates = validDates.filter((date) => !unavailableDateSet.has(date));
      const unavailableDates = requestedDates.filter((date) => !lockedDates.includes(date));
      if (!lockedDates.length) {
        throw conflict('Selected booth dates are no longer available');
      }

      const mobileUserId = await findOrCreatePublicMobileUser(conn, booth.organization_id, req.validated.body.user);
      const subtotal = Number(booth.price || 0) * lockedDates.length;
      const vatSettings = await getOrganizationVatSettings(conn, booth.organization_id);
      const totals = calculateVatBreakdown(subtotal, 0, vatSettings);
      const publicBookingId = publicId('BK');
      const [bookingResult] = await conn.execute(
        `INSERT INTO bookings (
          organization_id, public_id, market_id, mobile_user_id, source, status,
          subtotal_amount, discount_amount, vat_amount, total_amount,
          expires_at
        ) VALUES (
          :organizationId, :publicId, :marketId, :mobileUserId, 'mobile', 'pending_payment',
          :subtotalAmount, :discountAmount, :vatAmount, :totalAmount,
          DATE_ADD(NOW(), INTERVAL ${PAYMENT_EXPIRES_MINUTES} MINUTE)
        )`,
        {
          organizationId: booth.organization_id,
          publicId: publicBookingId,
          marketId: booth.market_id,
          mobileUserId,
          subtotalAmount: totals.subtotalAmount,
          discountAmount: totals.discountAmount,
          vatAmount: totals.vatAmount,
          totalAmount: totals.totalAmount,
        },
      );
      const bookingId = bookingResult.insertId;
      const [bookingRows] = await conn.execute(
        `SELECT expires_at
         FROM bookings
         WHERE id = :bookingId AND organization_id = :organizationId
         LIMIT 1`,
        { bookingId, organizationId: booth.organization_id },
      );
      const expiresAt = bookingRows[0]?.expires_at || null;

      for (const bookingDate of lockedDates) {
        await insertBoothDateLock(conn, {
          organizationId: booth.organization_id,
          marketId: booth.market_id,
          floorPlanId: booth.floor_plan_id,
          boothId,
          bookingId,
          bookingDate,
          status: 'held',
          expiresAt,
        });
        const [bookingItemResult] = await conn.execute(
          `INSERT INTO booking_items (
            organization_id, booking_id, booth_id, booking_date, unit_price, status
          ) VALUES (
            :organizationId, :bookingId, :boothId, :bookingDate, :unitPrice, 'pending_payment'
          )`,
          {
            organizationId: booth.organization_id,
            bookingId,
            boothId,
            bookingDate,
            unitPrice: booth.price,
          },
        );
        await attachBookingItemToLock(conn, {
          organizationId: booth.organization_id,
          bookingId,
          boothId,
          bookingDate,
          bookingItemId: bookingItemResult.insertId,
        });
      }

      return {
        bookingId,
        publicId: publicBookingId,
        organizationId: booth.organization_id,
        marketId: booth.market_id,
        floorPlanId: booth.floor_plan_id,
        boothId,
        lockedDates,
        unavailableDates,
        expiresAt,
        ...totals,
      };
    });

    return created(res, result, 'booth held');
  }),
);

router.post(
  '/booths/:boothId/availability',
  validate(
    z.object({
      body: z.object({
        dates: z.array(z.string().regex(/^\d{4}-\d{2}-\d{2}$/)).min(1).max(90),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ boothId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { boothId } = req.validated.params;
    const dates = Array.from(new Set(req.validated.body.dates));
    const [booth] = await query(
      `SELECT b.id, b.organization_id, b.market_id, b.floor_plan_id, b.category_id,
              c.name AS category_name, b.code, b.name, b.price, b.status
       FROM booths b
       JOIN markets m
         ON m.id = b.market_id
        AND m.organization_id = b.organization_id
       JOIN organizations o ON o.id = b.organization_id
       LEFT JOIN product_categories c ON c.id = b.category_id
       WHERE b.id = :boothId
         AND m.status = 'active'
         AND o.status = 'active'
       LIMIT 1`,
      { boothId },
    );

    if (!booth) return ok(res, null);

    await expireStaleBookings({ execute: query }, booth.organization_id);

    const lockedRows = await query(
      `SELECT DATE_FORMAT(bdl.booking_date, '%Y-%m-%d') AS booking_date,
              MAX(CASE
                WHEN bdl.status = 'paid' THEN 2
                WHEN bdl.status IN ('held', 'processing') THEN 1
                ELSE 0
              END) AS availability_rank
       FROM booth_date_locks bdl
       WHERE bdl.organization_id = :organizationId
         AND bdl.market_id = :marketId
         AND bdl.booth_id = :boothId
         AND bdl.booking_date IN (${datePlaceholders(dates)})
         AND bdl.status IN ('held', 'processing', 'paid')
       GROUP BY bdl.booking_date`,
      {
        organizationId: booth.organization_id,
        marketId: booth.market_id,
        boothId,
        ...dateParams(dates),
      },
    );

    const lockedByDate = new Map(
      lockedRows.map((row) => [
        String(row.booking_date).slice(0, 10),
        Number(row.availability_rank || 0),
      ]),
    );
    const availability = dates.map((date) => {
      if (booth.status !== 'active') {
        return { date, status: 'unavailable' };
      }
      const rank = lockedByDate.get(date) || 0;
      if (rank === 2) return { date, status: 'booked' };
      if (rank === 1) return { date, status: 'processing' };
      return { date, status: 'available' };
    });

    const vatSettings = await getOrganizationVatSettings({ execute: query }, booth.organization_id);
    return ok(res, {
      booth: mapBooth({
        ...booth,
        availability_status: booth.status === 'active' ? 'available' : 'unavailable',
        gross_price: applyVatToAmount(booth.price, vatSettings),
      }),
      dates: availability,
    });
  }),
);

router.get(
  '/announcements',
  asyncHandler(async (req, res) => {
    const type = ['news', 'banner'].includes(String(req.query.type || '')) ? String(req.query.type) : null;
    const limit = Math.min(Math.max(Number(req.query.limit || 20), 1), 50);

    const rows = await query(
      `SELECT
          ai.id, ai.organization_id, ai.market_id, ai.market_code, ai.type, ai.title, ai.description, ai.image_url,
          ai.start_date, ai.end_date, ai.created_at, m.name AS market_name
       FROM announcement_items ai
       LEFT JOIN markets m
         ON m.id = ai.market_id
        AND m.organization_id = ai.organization_id
        AND m.status = 'active'
       JOIN organizations o ON o.id = ai.organization_id
       WHERE ai.status = 'active'
         AND o.status = 'active'
         AND (:type IS NULL OR ai.type = :type)
         AND (ai.start_date IS NULL OR ai.start_date <= CURRENT_DATE())
         AND (ai.end_date IS NULL OR ai.end_date >= CURRENT_DATE())
       ORDER BY COALESCE(ai.start_date, DATE(ai.created_at)) DESC, ai.id DESC
       LIMIT ${limit}`,
      { type },
    );

    return ok(res, rows.map(mapAnnouncement));
  }),
);

router.get(
  '/subscription/overview',
  asyncHandler(async (req, res) => {
    const [summary] = await query(
      `SELECT
          (SELECT COUNT(*) FROM organizations WHERE status = 'active') AS active_organizations,
          (SELECT COUNT(*) FROM markets WHERE status = 'active') AS active_markets,
          (SELECT COUNT(*) FROM booths WHERE status = 'active') AS active_booths,
          (SELECT COUNT(*) FROM organization_signup_requests WHERE status IN ('pending_review', 'contacted')) AS pending_signup_requests,
          (SELECT COUNT(*) FROM organization_subscriptions WHERE status IN ('pending_activation', 'trialing', 'active', 'past_due')) AS active_subscriptions,
          (SELECT COUNT(*) FROM bookings WHERE status = 'paid' AND DATE(COALESCE(paid_at, created_at)) = CURRENT_DATE()) AS paid_bookings_today,
          (SELECT COALESCE(SUM(total_amount), 0) FROM bookings WHERE status = 'paid' AND DATE(COALESCE(paid_at, created_at)) = CURRENT_DATE()) AS paid_amount_today,
          (SELECT COUNT(*)
             FROM booking_items
            WHERE status = 'paid'
              AND booking_date = CURRENT_DATE()) AS occupied_booths_today`,
    );

    const activeBooths = Number(summary?.active_booths || 0);
    const occupiedBoothsToday = Number(summary?.occupied_booths_today || 0);
    const occupancyRateToday = activeBooths > 0
      ? Math.min(100, Math.round((occupiedBoothsToday / activeBooths) * 100))
      : 0;

    return ok(res, {
      activeOrganizations: Number(summary?.active_organizations || 0),
      activeMarkets: Number(summary?.active_markets || 0),
      activeBooths,
      pendingSignupRequests: Number(summary?.pending_signup_requests || 0),
      activeSubscriptions: Number(summary?.active_subscriptions || 0),
      paidBookingsToday: Number(summary?.paid_bookings_today || 0),
      paidAmountToday: Number(summary?.paid_amount_today || 0),
      occupiedBoothsToday,
      occupancyRateToday,
    });
  }),
);

router.get(
  '/subscription/plans',
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, code, name, description, trial_days, grace_period_days, billing_interval, billing_interval_count, currency_code,
              base_price, price_display_label, setup_fee, included_markets, included_admin_users, included_active_booths,
              included_monthly_bookings, overage_market_price, overage_admin_user_price, overage_booth_price,
              overage_booking_price, vat_applicable, features_json, is_free_tier, is_full_function, sort_order
       FROM subscription_plans
       WHERE status = 'active'
         AND public_visible = 1
       ORDER BY sort_order ASC, id ASC`,
    );
    return ok(res, rows.map((row) => ({
      ...row,
      features: Array.isArray(row.features_json) ? row.features_json : typeof row.features_json === 'string' ? JSON.parse(row.features_json) : [],
      features_json: undefined,
    })));
  }),
);

router.post(
  '/subscription/signup',
  validate(
    z.object({
      body: z.object({
        companyName: z.string().min(2).max(255),
        companyEmail: z.string().email(),
        companyPhone: z.string().min(8).max(30),
        lineId: z.string().max(120).optional().or(z.literal('')).default(''),
        address: z.string().min(5).max(1000),
        supervisorName: z.string().min(2).max(255),
        supervisorEmail: z.string().email(),
        supervisorPhone: z.string().min(8).max(30).optional().or(z.literal('')).default(''),
        password: z.string().min(10).refine(assertPasswordPolicy, PASSWORD_POLICY_MESSAGE),
        marketCountEstimate: z.coerce.number().int().min(1).max(999).optional().default(1),
        expectedGoLiveDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().or(z.literal('')).default(''),
        preferredPlanCode: z.string().min(1).max(50).optional().default('free_full_1y'),
        preferredBillingInterval: z.enum(['monthly', 'yearly']).optional().default('yearly'),
        notes: z.string().max(2000).optional().or(z.literal('')).default(''),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const result = await transaction(async (conn) => {
      const [plans] = await conn.execute(
        `SELECT *
         FROM subscription_plans
         WHERE code = :code
           AND status = 'active'
         LIMIT 1`,
        { code: body.preferredPlanCode },
      );
      const plan = plans[0];
      if (!plan) throw conflict('Selected subscription plan is not available');

      const companyEmailHash = blindIndex(body.companyEmail);
      const supervisorEmailHash = blindIndex(body.supervisorEmail);
      const [existing] = await conn.execute(
        `SELECT id, request_no, status
         FROM organization_signup_requests
         WHERE company_email_hash IN (:companyEmailHash, :supervisorEmailHash)
            OR supervisor_email_hash IN (:companyEmailHash, :supervisorEmailHash)
         ORDER BY id DESC
         LIMIT 1`,
        { companyEmailHash, supervisorEmailHash },
      );
      if (existing[0] && ['pending_review', 'contacted', 'approved', 'provisioned'].includes(existing[0].status)) {
        throw conflict('This email already has an active signup request');
      }

      const requestNo = publicId('SUB');
      const subscriptionCode = publicId('OSUB');
      const now = new Date();
      const trialEndsAt = new Date(now.getTime() + Number(plan.trial_days || 0) * 24 * 60 * 60 * 1000);
      const basePrice = Number(plan.base_price || 0);
      const setupFee = Number(plan.setup_fee || 0);
      const subtotalAmount = basePrice + setupFee;
      const vatRate = Number(plan.vat_applicable || 0) === 1 ? 7 : 0;
      const vatAmount = vatRate > 0 ? Math.round(subtotalAmount * vatRate) / 100 : 0;
      const totalAmount = subtotalAmount + vatAmount;

      const [signup] = await conn.execute(
        `INSERT INTO organization_signup_requests (
          request_no, company_name, company_email_enc, company_email_hash, company_phone_enc, company_phone_hash,
          line_id_enc, address_enc, supervisor_name_enc, supervisor_email_enc, supervisor_email_hash,
          supervisor_phone_enc, supervisor_phone_hash, supervisor_password_hash, market_count_estimate,
          expected_go_live_date, preferred_plan_id, preferred_billing_interval, notes, status, source,
          ip_address, user_agent, metadata_json
        ) VALUES (
          :requestNo, :companyName, :companyEmailEnc, :companyEmailHash, :companyPhoneEnc, :companyPhoneHash,
          :lineIdEnc, :addressEnc, :supervisorNameEnc, :supervisorEmailEnc, :supervisorEmailHash,
          :supervisorPhoneEnc, :supervisorPhoneHash, :supervisorPasswordHash, :marketCountEstimate,
          :expectedGoLiveDate, :preferredPlanId, :preferredBillingInterval, :notes, 'pending_review', 'landing',
          :ipAddress, :userAgent, :metadataJson
        )`,
        {
          requestNo,
          companyName: body.companyName,
          companyEmailEnc: encryptField(body.companyEmail),
          companyEmailHash,
          companyPhoneEnc: encryptField(body.companyPhone),
          companyPhoneHash: blindIndex(body.companyPhone),
          lineIdEnc: encryptField(body.lineId),
          addressEnc: encryptField(body.address),
          supervisorNameEnc: encryptField(body.supervisorName),
          supervisorEmailEnc: encryptField(body.supervisorEmail),
          supervisorEmailHash,
          supervisorPhoneEnc: encryptField(body.supervisorPhone),
          supervisorPhoneHash: blindIndex(body.supervisorPhone),
          supervisorPasswordHash: await bcrypt.hash(body.password, 12),
          marketCountEstimate: body.marketCountEstimate,
          expectedGoLiveDate: body.expectedGoLiveDate || null,
          preferredPlanId: plan.id,
          preferredBillingInterval: body.preferredBillingInterval,
          notes: body.notes || null,
          ipAddress: req.ip || null,
          userAgent: String(req.headers['user-agent'] || '').slice(0, 500) || null,
          metadataJson: JSON.stringify({
            planCode: plan.code,
            planName: plan.name,
            sourceHost: req.get('host') || null,
          }),
        },
      );

      await conn.execute(
        `INSERT INTO organization_subscriptions (
          subscription_code, signup_request_id, plan_id, status, billing_currency, billing_interval, billing_interval_count,
          unit_price, setup_fee, discount_amount, vat_rate, subtotal_amount, vat_amount, total_amount,
          included_markets, included_admin_users, included_active_booths, included_monthly_bookings,
          trial_starts_at, trial_ends_at, current_period_start, current_period_end, next_billing_at, metadata_json
        ) VALUES (
          :subscriptionCode, :signupRequestId, :planId, 'pending_activation', :billingCurrency, :billingInterval, :billingIntervalCount,
          :unitPrice, :setupFee, 0, :vatRate, :subtotalAmount, :vatAmount, :totalAmount,
          :includedMarkets, :includedAdminUsers, :includedActiveBooths, :includedMonthlyBookings,
          NOW(), :trialEndsAt, NOW(), :trialEndsAt, :trialEndsAt, :metadataJson
        )`,
        {
          subscriptionCode,
          signupRequestId: signup.insertId,
          planId: plan.id,
          billingCurrency: plan.currency_code,
          billingInterval: body.preferredBillingInterval,
          billingIntervalCount: plan.billing_interval_count,
          unitPrice: basePrice,
          setupFee,
          vatRate,
          subtotalAmount,
          vatAmount,
          totalAmount,
          includedMarkets: plan.included_markets,
          includedAdminUsers: plan.included_admin_users,
          includedActiveBooths: plan.included_active_booths,
          includedMonthlyBookings: plan.included_monthly_bookings,
          trialEndsAt,
          metadataJson: JSON.stringify({
            planCode: plan.code,
            requestedMarketCount: body.marketCountEstimate,
          }),
        },
      );

      return {
        requestNo,
        subscriptionCode,
        companyName: body.companyName,
        preferredPlan: plan.name,
        preferredPlanCode: plan.code,
        trialEndsAt,
        status: 'pending_review',
      };
    });

    return created(res, result, 'subscription signup submitted');
  }),
);

module.exports = router;
