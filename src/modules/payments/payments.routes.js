const express = require('express');
const { z } = require('zod');
const { query, transaction } = require('../../config/db');
const { authenticate } = require('../../middlewares/auth');
const { requireMobileAccount } = require('../../middlewares/rbac');
const { validate } = require('../../middlewares/validate');
const { asyncHandler } = require('../../utils/async-handler');
const { created, ok } = require('../../utils/api-response');
const { badRequest, notFound } = require('../../utils/errors');
const { publicId } = require('../../utils/id');

const router = express.Router();

router.post(
  '/transactions',
  authenticate,
  requireMobileAccount,
  validate(
    z.object({
      body: z.object({
        bookingId: z.coerce.number().int().positive(),
        provider: z.enum(['ksher', 'manual', 'mock']).default('mock'),
        couponId: z.coerce.number().int().positive().optional().nullable(),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const result = await transaction(async (conn) => {
      const [bookings] = await conn.execute(
        `SELECT id, total_amount, status
         FROM bookings
         WHERE id = :bookingId
           AND organization_id = :organizationId
           AND mobile_user_id = :mobileUserId
         LIMIT 1
         FOR UPDATE`,
        { bookingId: body.bookingId, organizationId: req.auth.organizationId, mobileUserId: req.auth.sub },
      );
      const booking = bookings[0];
      if (!booking) throw notFound('Booking not found');
      if (booking.status !== 'pending_payment') throw badRequest('Booking is not payable');

      const publicPaymentId = publicId('PAY');
      const [payment] = await conn.execute(
        `INSERT INTO payments (
          organization_id, public_id, booking_id, provider, status, amount, coupon_id
        ) VALUES (
          :organizationId, :publicId, :bookingId, :provider, 'created', :amount, :couponId
        )`,
        {
          organizationId: req.auth.organizationId,
          publicId: publicPaymentId,
          bookingId: booking.id,
          provider: body.provider,
          amount: booking.total_amount,
          couponId: body.couponId || null,
        },
      );

      await conn.execute(
        `UPDATE bookings SET status = 'payment_processing' WHERE id = :bookingId AND organization_id = :organizationId`,
        { bookingId: booking.id, organizationId: req.auth.organizationId },
      );
      await conn.execute(
        `UPDATE booking_items SET status = 'payment_processing' WHERE booking_id = :bookingId AND organization_id = :organizationId`,
        { bookingId: booking.id, organizationId: req.auth.organizationId },
      );

      return {
        id: payment.insertId,
        publicId: publicPaymentId,
        provider: body.provider,
        amount: booking.total_amount,
        redirectUrl: null,
      };
    });

    return created(res, result, 'payment transaction created');
  }),
);

router.post(
  '/callbacks/:provider',
  asyncHandler(async (req, res) => {
    await query(
      `INSERT INTO payment_callbacks (organization_id, provider, payload_json, received_at)
       VALUES (NULL, :provider, :payloadJson, NOW())`,
      { provider: req.params.provider, payloadJson: JSON.stringify(req.body || {}) },
    );

    return ok(res, { accepted: true });
  }),
);

module.exports = router;
