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
const { conflict } = require('../../utils/errors');

const router = express.Router();

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
