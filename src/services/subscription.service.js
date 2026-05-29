const { query } = require('../config/db');
const { forbidden } = require('../utils/errors');

const FEATURE_BY_PATH = [
  [/^\/organization-settings/, 'organization_settings'],
  [/^\/admins/, 'admin_management'],
  [/^\/pdpa/, 'pdpa_management'],
  [/^\/announcements/, 'announcements'],
  [/^\/tenant/, 'tenant_management'],
  [/^\/markets\/next-code/, 'market_management'],
  [/^\/markets\/\d+\/booth-types/, 'booth_management'],
  [/^\/markets\/\d+\/booths/, 'booth_management'],
  [/^\/markets\/\d+\/holidays/, 'market_management'],
  [/^\/markets\/\d+\/images/, 'market_management'],
  [/^\/markets\/\d+\/accessories/, 'market_management'],
  [/^\/markets\/\d+\/product-categories/, 'product_management'],
  [/^\/markets\/\d+\/product-groups/, 'product_management'],
  [/^\/markets\/\d+\/products/, 'product_management'],
  [/^\/markets\/\d+\/audit/, 'market_audit'],
  [/^\/markets/, 'market_management'],
  [/^\/coupons/, 'coupon_management'],
  [/^\/payment-proofs/, 'booking_management'],
  [/^\/bookings/, 'booking_management'],
  [/^\/booking-edit/, 'booking_management'],
  [/^\/accounting/, 'accounting'],
  [/^\/reports/, 'reports'],
  [/^\/dashboard/, 'dashboard'],
];

const QUOTA_FEATURES = [
  { key: 'market_management', label: 'ตลาด', code: 'markets' },
  { key: 'admin_management', label: 'ผู้ดูแลระบบ', code: 'adminUsers' },
  { key: 'booth_management', label: 'บูธที่เปิดใช้งาน', code: 'activeBooths' },
  { key: 'booking_management', label: 'รายการจองต่อเดือน', code: 'monthlyBookings' },
];

function parseJson(value, fallback = {}) {
  if (!value) return fallback;
  if (typeof value === 'object') return value;
  try {
    return JSON.parse(value);
  } catch {
    return fallback;
  }
}

function normalizeDate(value) {
  return value ? new Date(value) : null;
}

function isDateExpired(value, gracePeriodDays = 0) {
  const date = normalizeDate(value);
  if (!date) return false;
  date.setDate(date.getDate() + Number(gracePeriodDays || 0));
  return date.getTime() < Date.now();
}

function resolveFeatureFromPath(path = '') {
  const matched = FEATURE_BY_PATH.find(([pattern]) => pattern.test(path));
  return matched?.[1] || 'dashboard';
}

async function getCurrentSubscription(organizationId) {
  const rows = await query(
    `SELECT
        os.id, os.subscription_code, os.organization_id, os.status, os.billing_interval,
        os.trial_starts_at, os.trial_ends_at, os.current_period_start, os.current_period_end,
        os.next_billing_at, os.activated_at, os.cancelled_at,
        p.id AS plan_id, p.code AS plan_code, p.name AS plan_name, p.description AS plan_description,
        p.trial_days, p.grace_period_days, p.currency_code, p.base_price, p.price_display_label,
        p.included_markets, p.included_admin_users, p.included_active_booths, p.included_monthly_bookings,
        p.is_free_tier, p.is_full_function, p.features_json
     FROM organization_subscriptions os
     JOIN subscription_plans p ON p.id = os.plan_id
     WHERE os.organization_id = :organizationId
     ORDER BY
       CASE os.status
         WHEN 'trialing' THEN 1
         WHEN 'active' THEN 2
         WHEN 'pending_activation' THEN 3
         WHEN 'past_due' THEN 4
         ELSE 9
       END,
       os.current_period_end DESC,
       os.id DESC
     LIMIT 1`,
    { organizationId },
  );

  if (!rows.length) {
    return {
      exists: false,
      status: 'missing',
      accessStatus: 'missing',
      active: false,
      expired: true,
      writeAllowed: false,
      currentFeatureAllowed: false,
      entitlements: {},
      features: [],
    };
  }

  const row = rows[0];
  const entitlementRows = await query(
    `SELECT feature_key, enabled, limit_quantity, metadata_json
     FROM subscription_plan_entitlements
     WHERE plan_id = :planId`,
    { planId: row.plan_id },
  );

  const entitlements = {};
  for (const entitlement of entitlementRows) {
    entitlements[entitlement.feature_key] = {
      enabled: Number(entitlement.enabled) === 1,
      limit: entitlement.limit_quantity === null ? null : Number(entitlement.limit_quantity),
      metadata: parseJson(entitlement.metadata_json, {}),
    };
  }

  const gracePeriodDays = Number(row.grace_period_days || 0);
  const effectiveEndAt = row.current_period_end || row.trial_ends_at || row.next_billing_at;
  const terminalStatus = ['expired', 'cancelled', 'suspended'].includes(row.status);
  const expired = terminalStatus || isDateExpired(effectiveEndAt, gracePeriodDays);
  const fullFunction = Number(row.is_full_function) === 1;
  const active = !expired && ['pending_activation', 'trialing', 'active'].includes(row.status);
  const plan = {
    id: row.plan_id,
    code: row.plan_code,
    name: row.plan_name,
    description: row.plan_description,
    trialDays: Number(row.trial_days || 0),
    currencyCode: row.currency_code,
    basePrice: Number(row.base_price || 0),
    priceDisplayLabel: row.price_display_label || 'N/A',
    includedMarkets: Number(row.included_markets || 0),
    includedAdminUsers: Number(row.included_admin_users || 0),
    includedActiveBooths: Number(row.included_active_booths || 0),
    includedMonthlyBookings: Number(row.included_monthly_bookings || 0),
    isFreeTier: Number(row.is_free_tier) === 1,
    isFullFunction: fullFunction,
    features: parseJson(row.features_json, []),
  };
  const quotaSubscription = { plan, entitlements };
  const quotas = {};
  for (const item of QUOTA_FEATURES) {
    const limit = getPlanLimit(quotaSubscription, item.key);
    const used = await getQuotaUsage(row.organization_id, item.key);
    quotas[item.key] = {
      code: item.code,
      label: item.label,
      used,
      limit,
      unlimited: limit === null || limit === undefined || limit <= 0,
      exceeded: !fullFunction && limit !== null && limit !== undefined && limit > 0 && used > limit,
    };
  }
  const quotaViolations = Object.values(quotas).filter((item) => item.exceeded);
  const quotaExceeded = quotaViolations.length > 0;
  const writeAllowed = active && !quotaExceeded;

  return {
    exists: true,
    id: row.id,
    subscriptionCode: row.subscription_code,
    status: row.status,
    accessStatus: expired ? 'expired' : quotaExceeded ? 'over_quota' : active ? 'active' : 'read_only',
    active,
    expired,
    writeAllowed,
    quotaExceeded,
    quotaViolations,
    quotas,
    effectiveEndAt,
    gracePeriodDays,
    fullFunction,
    plan,
    entitlements,
  };
}

function canUseFeature(subscription, featureKey) {
  if (!subscription?.writeAllowed) return false;
  if (subscription.fullFunction) return true;
  return Boolean(subscription.entitlements?.[featureKey]?.enabled);
}

function getPlanLimit(subscription, featureKey) {
  const entitlementLimit = subscription?.entitlements?.[featureKey]?.limit;
  if (entitlementLimit !== null && entitlementLimit !== undefined) return Number(entitlementLimit);

  const plan = subscription?.plan || {};
  if (featureKey === 'market_management') return Number(plan.includedMarkets || 0);
  if (featureKey === 'admin_management') return Number(plan.includedAdminUsers || 0);
  if (featureKey === 'booth_management') return Number(plan.includedActiveBooths || 0);
  if (featureKey === 'booking_management') return Number(plan.includedMonthlyBookings || 0);
  return null;
}

async function getQuotaUsage(organizationId, featureKey) {
  if (featureKey === 'market_management') {
    const rows = await query(
      `SELECT COUNT(*) AS total
       FROM markets
       WHERE organization_id = :organizationId
         AND status = 'active'`,
      { organizationId },
    );
    return Number(rows[0]?.total || 0);
  }

  if (featureKey === 'admin_management') {
    const rows = await query(
      `SELECT COUNT(*) AS total
       FROM admin_users
       WHERE organization_id = :organizationId
         AND status = 'active'`,
      { organizationId },
    );
    return Number(rows[0]?.total || 0);
  }

  if (featureKey === 'booth_management') {
    const rows = await query(
      `SELECT COUNT(*) AS total
       FROM booths
       WHERE organization_id = :organizationId
         AND status = 'active'`,
      { organizationId },
    );
    return Number(rows[0]?.total || 0);
  }

  if (featureKey === 'booking_management') {
    const rows = await query(
      `SELECT COUNT(bi.id) AS total
       FROM booking_items bi
       JOIN bookings b
         ON b.id = bi.booking_id
        AND b.organization_id = bi.organization_id
       WHERE bi.organization_id = :organizationId
         AND b.created_at >= DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01')
         AND b.created_at < DATE_ADD(DATE_FORMAT(CURRENT_DATE(), '%Y-%m-01'), INTERVAL 1 MONTH)
         AND b.status NOT IN ('expired', 'cancelled_by_customer')
         AND bi.status NOT IN ('expired', 'cancelled_by_customer')`,
      { organizationId },
    );
    return Number(rows[0]?.total || 0);
  }

  return 0;
}

async function assertPlanQuota(organizationId, featureKey, requestedQuantity = 1) {
  const subscription = await getCurrentSubscription(organizationId);
  if (!subscription.writeAllowed) {
    if (subscription.accessStatus === 'over_quota' || subscription.quotaExceeded) {
      throw forbidden('Subscription package quota exceeded. Please upgrade package or reduce active data before making changes.');
    }
    throw forbidden('Subscription is expired or inactive');
  }
  if (!canUseFeature(subscription, featureKey)) {
    throw forbidden(`Current subscription plan does not include ${featureKey}`);
  }

  const limit = getPlanLimit(subscription, featureKey);
  if (limit === null || limit === undefined || limit <= 0) return subscription;

  const usage = await getQuotaUsage(organizationId, featureKey);
  const requested = Number(requestedQuantity || 1);
  if (usage + requested > limit) {
    throw forbidden(`Package quota exceeded for ${featureKey}. Limit ${limit}, current ${usage}, requested ${requested}`);
  }

  return subscription;
}

async function assertFeatureAccess(organizationId, featureKey) {
  const subscription = await getCurrentSubscription(organizationId);
  if (!subscription.writeAllowed) {
    if (subscription.accessStatus === 'over_quota' || subscription.quotaExceeded) {
      throw forbidden('Subscription package quota exceeded. Please upgrade package or reduce active data before making changes.');
    }
    throw forbidden('Subscription is expired or inactive');
  }
  if (!canUseFeature(subscription, featureKey)) {
    throw forbidden(`Current subscription plan does not include ${featureKey}`);
  }
  return subscription;
}

function requireSubscriptionForMutations(options = {}) {
  const resolveFeature = options.resolveFeature || resolveFeatureFromPath;
  const excluded = options.excluded || [];

  return async (req, res, next) => {
    if (!['POST', 'PUT', 'PATCH', 'DELETE'].includes(req.method)) return next();
    if (excluded.some((pattern) => pattern.test(req.path))) return next();

    try {
      const featureKey = resolveFeature(req.path, req);
      await assertFeatureAccess(req.auth.organizationId, featureKey);
      return next();
    } catch (error) {
      return next(error);
    }
  };
}

module.exports = {
  assertFeatureAccess,
  assertPlanQuota,
  canUseFeature,
  getCurrentSubscription,
  requireSubscriptionForMutations,
  resolveFeatureFromPath,
};
