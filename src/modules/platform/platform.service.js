const bcrypt = require('bcryptjs');
const { query } = require('../../config/db');
const { signToken } = require('../../middlewares/auth');
const { decryptField, blindIndex } = require('../../utils/crypto');
const { unauthorized, notFound } = require('../../utils/errors');
const {
  PLATFORM_MENU_ACCESS,
  PLATFORM_NAVIGATION,
} = require('../../constants/platform');

function buildNavigation(role) {
  const allowed = new Set(PLATFORM_MENU_ACCESS[role] || []);
  return PLATFORM_NAVIGATION.map((section) => ({
    ...section,
    items: section.items.filter((item) => allowed.has(item.key)),
  })).filter((section) => section.items.length > 0);
}

function mapPlatformUser(row) {
  return {
    id: row.id,
    role: row.role,
    status: row.status,
    name: decryptField(row.name_enc),
    email: decryptField(row.email_enc),
    menus: PLATFORM_MENU_ACCESS[row.role] || [],
    navigation: buildNavigation(row.role),
  };
}

function normalizePagination(page, pageSize) {
  const safePage = Number.isFinite(Number(page)) ? Math.max(Number(page), 1) : 1;
  const safePageSize = Number.isFinite(Number(pageSize)) ? Math.min(Math.max(Number(pageSize), 1), 100) : 10;
  return {
    page: safePage,
    pageSize: safePageSize,
    offset: (safePage - 1) * safePageSize,
  };
}

async function getPlatformUserById(userId) {
  const rows = await query(
    `SELECT id, role, status, name_enc, email_enc
     FROM platform_users
     WHERE id = :userId
     LIMIT 1`,
    { userId },
  );

  const user = rows[0];
  if (!user || user.status !== 'active') {
    throw notFound('ไม่พบผู้ใช้งานแพลตฟอร์ม');
  }

  return mapPlatformUser(user);
}

async function loginPlatform({ username, password }) {
  const usernameHash = blindIndex(username);
  const rows = await query(
    `SELECT id, role, status, password_hash, name_enc, email_enc
     FROM platform_users
     WHERE username_hash = :usernameHash
     LIMIT 1`,
    { usernameHash },
  );

  const user = rows[0];
  if (!user || user.status !== 'active') {
    throw unauthorized('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw unauthorized('ชื่อผู้ใช้หรือรหัสผ่านไม่ถูกต้อง');
  }

  await query(
    `UPDATE platform_users
     SET last_login_at = CURRENT_TIMESTAMP
     WHERE id = :userId`,
    { userId: user.id },
  );

  const token = signToken({
    sub: user.id,
    userType: 'platform',
    role: user.role,
    organizationId: null,
    marketIds: [],
  });

  return {
    token,
    user: mapPlatformUser(user),
  };
}

async function getPlatformDashboardSummary() {
  const [summary] = await query(
    `SELECT
        (SELECT COUNT(*) FROM organizations WHERE status = 'active') AS active_organizations,
        (SELECT COUNT(*) FROM organizations WHERE status <> 'deleted') AS total_organizations,
        (SELECT COUNT(*) FROM markets WHERE status = 'active') AS active_markets,
        (SELECT COUNT(*) FROM organization_signup_requests WHERE status IN ('pending_review', 'contacted')) AS pending_signups,
        (SELECT COUNT(*) FROM organization_subscriptions WHERE status IN ('pending_activation', 'trialing', 'active', 'past_due')) AS active_subscriptions,
        (SELECT COUNT(*) FROM support_tickets WHERE status IN ('opened', 'processing', 'reply')) AS open_support_tickets,
        (SELECT COUNT(*) FROM subscription_invoices WHERE status IN ('issued', 'overdue')) AS unpaid_subscription_invoices,
        (SELECT COALESCE(SUM(total_amount), 0) FROM subscription_invoices WHERE status = 'paid' AND DATE(paid_at) = CURRENT_DATE()) AS paid_subscription_amount_today`,
  );

  const recentOrganizations = await query(
    `SELECT
        o.id,
        o.code,
        o.name,
        o.status,
        os.status AS subscription_status,
        sp.name AS plan_name,
        o.created_at
     FROM organizations o
     LEFT JOIN organization_subscriptions os
       ON os.organization_id = o.id
      AND os.id = (
        SELECT os2.id
        FROM organization_subscriptions os2
        WHERE os2.organization_id = o.id
        ORDER BY os2.id DESC
        LIMIT 1
      )
     LEFT JOIN subscription_plans sp ON sp.id = os.plan_id
     ORDER BY o.created_at DESC
     LIMIT 8`,
  );

  return {
    metrics: {
      activeOrganizations: Number(summary?.active_organizations || 0),
      totalOrganizations: Number(summary?.total_organizations || 0),
      activeMarkets: Number(summary?.active_markets || 0),
      pendingSignups: Number(summary?.pending_signups || 0),
      activeSubscriptions: Number(summary?.active_subscriptions || 0),
      openSupportTickets: Number(summary?.open_support_tickets || 0),
      unpaidSubscriptionInvoices: Number(summary?.unpaid_subscription_invoices || 0),
      paidSubscriptionAmountToday: Number(summary?.paid_subscription_amount_today || 0),
    },
    recentOrganizations: recentOrganizations.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      subscriptionStatus: row.subscription_status || 'missing',
      planName: row.plan_name || 'ยังไม่ได้กำหนดแพ็กเกจ',
      createdAt: row.created_at,
    })),
  };
}

async function listOrganizations(filters = {}) {
  const { search = '', status = 'all', page = 1, pageSize = 10 } = filters;
  const pagination = normalizePagination(page, pageSize);
  const keyword = search.trim();
  const params = {
    keyword: `%${keyword}%`,
    status,
    limit: pagination.pageSize,
    offset: pagination.offset,
  };

  const statusClause = status !== 'all' ? `AND o.status = :status` : '';
  const searchClause = keyword
    ? `AND (o.code LIKE :keyword OR o.name LIKE :keyword OR o.email LIKE :keyword OR o.phone LIKE :keyword)`
    : '';

  const [totalRow] = await query(
    `SELECT COUNT(*) AS total
     FROM organizations o
     WHERE 1 = 1
       ${statusClause}
       ${searchClause}`,
    params,
  );

  const rows = await query(
    `SELECT
        o.id,
        o.code,
        o.name,
        o.status,
        o.email,
        o.phone,
        o.created_at,
        o.updated_at,
        COALESCE(mc.market_count, 0) AS market_count,
        COALESCE(ac.admin_count, 0) AS admin_count,
        COALESCE(muc.mobile_user_count, 0) AS mobile_user_count,
        COALESCE(bc.booking_count, 0) AS booking_count,
        os.status AS subscription_status,
        COALESCE(os.current_period_start, os.trial_starts_at, os.activated_at) AS subscription_start_at,
        COALESCE(os.current_period_end, os.trial_ends_at) AS subscription_end_at,
        sp.name AS plan_name
     FROM organizations o
     LEFT JOIN (
       SELECT organization_id, COUNT(*) AS market_count
       FROM markets
       GROUP BY organization_id
     ) mc ON mc.organization_id = o.id
     LEFT JOIN (
       SELECT organization_id, COUNT(*) AS admin_count
       FROM admin_users
       WHERE status <> 'inactive'
       GROUP BY organization_id
     ) ac ON ac.organization_id = o.id
     LEFT JOIN (
       SELECT organization_id, COUNT(*) AS mobile_user_count
       FROM mobile_users
       WHERE status <> 'deleted'
       GROUP BY organization_id
     ) muc ON muc.organization_id = o.id
     LEFT JOIN (
       SELECT organization_id, COUNT(*) AS booking_count
       FROM bookings
       GROUP BY organization_id
     ) bc ON bc.organization_id = o.id
     LEFT JOIN organization_subscriptions os
       ON os.organization_id = o.id
      AND os.id = (
        SELECT os2.id
        FROM organization_subscriptions os2
        WHERE os2.organization_id = o.id
        ORDER BY os2.id DESC
        LIMIT 1
      )
     LEFT JOIN subscription_plans sp ON sp.id = os.plan_id
     WHERE 1 = 1
       ${statusClause}
       ${searchClause}
     ORDER BY o.created_at DESC, o.id DESC
     LIMIT :limit OFFSET :offset`,
    params,
  );

  return {
    items: rows.map((row) => ({
      id: row.id,
      code: row.code,
      name: row.name,
      status: row.status,
      email: row.email || '',
      phone: row.phone || '',
      createdAt: row.created_at,
      updatedAt: row.updated_at,
      marketCount: Number(row.market_count || 0),
      adminCount: Number(row.admin_count || 0),
      mobileUserCount: Number(row.mobile_user_count || 0),
      bookingCount: Number(row.booking_count || 0),
      subscriptionStatus: row.subscription_status || 'missing',
      subscriptionStartAt: row.subscription_start_at,
      subscriptionEndAt: row.subscription_end_at,
      planName: row.plan_name || 'ยังไม่ได้กำหนดแพ็กเกจ',
    })),
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: Number(totalRow?.total || 0),
      totalPages: Math.max(Math.ceil(Number(totalRow?.total || 0) / pagination.pageSize), 1),
    },
  };
}

async function getOrganizationDetail(organizationId) {
  const rows = await query(
    `SELECT
        o.id,
        o.code,
        o.name,
        o.status,
        o.address,
        o.email,
        o.phone,
        o.line_id,
        o.created_at,
        o.updated_at,
        o.vat_enabled,
        o.vat_rate,
        os.id AS subscription_id,
        os.status AS subscription_status,
        COALESCE(os.current_period_start, os.trial_starts_at, os.activated_at) AS subscription_start_at,
        COALESCE(os.current_period_end, os.trial_ends_at) AS subscription_end_at,
        os.billing_interval,
        sp.name AS plan_name,
        COALESCE(mc.market_count, 0) AS market_count,
        COALESCE(ac.admin_count, 0) AS admin_count,
        COALESCE(muc.mobile_user_count, 0) AS mobile_user_count,
        COALESCE(bc.booking_count, 0) AS booking_count
     FROM organizations o
     LEFT JOIN (
       SELECT organization_id, COUNT(*) AS market_count
       FROM markets
       GROUP BY organization_id
     ) mc ON mc.organization_id = o.id
     LEFT JOIN (
       SELECT organization_id, COUNT(*) AS admin_count
       FROM admin_users
       WHERE status <> 'inactive'
       GROUP BY organization_id
     ) ac ON ac.organization_id = o.id
     LEFT JOIN (
       SELECT organization_id, COUNT(*) AS mobile_user_count
       FROM mobile_users
       WHERE status <> 'deleted'
       GROUP BY organization_id
     ) muc ON muc.organization_id = o.id
     LEFT JOIN (
       SELECT organization_id, COUNT(*) AS booking_count
       FROM bookings
       GROUP BY organization_id
     ) bc ON bc.organization_id = o.id
     LEFT JOIN organization_subscriptions os
       ON os.organization_id = o.id
      AND os.id = (
        SELECT os2.id
        FROM organization_subscriptions os2
        WHERE os2.organization_id = o.id
        ORDER BY os2.id DESC
        LIMIT 1
      )
     LEFT JOIN subscription_plans sp ON sp.id = os.plan_id
     WHERE o.id = :organizationId
     LIMIT 1`,
    { organizationId },
  );

  const row = rows[0];
  if (!row) {
    throw notFound('ไม่พบข้อมูลองค์กร');
  }

  const recentMarkets = await query(
    `SELECT id, code, name, status, open_date, close_date
     FROM markets
     WHERE organization_id = :organizationId
     ORDER BY created_at DESC, id DESC
     LIMIT 5`,
    { organizationId },
  );

  const recentAdmins = await query(
    `SELECT id, role, status, name_enc, email_enc, last_login_at
     FROM admin_users
     WHERE organization_id = :organizationId
     ORDER BY created_at DESC, id DESC
     LIMIT 5`,
    { organizationId },
  );

  return {
    id: row.id,
    code: row.code,
    name: row.name,
    status: row.status,
    address: row.address || '',
    email: row.email || '',
    phone: row.phone || '',
    lineId: row.line_id || '',
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    vatEnabled: Boolean(row.vat_enabled),
    vatRate: Number(row.vat_rate || 0),
    marketCount: Number(row.market_count || 0),
    adminCount: Number(row.admin_count || 0),
    mobileUserCount: Number(row.mobile_user_count || 0),
    bookingCount: Number(row.booking_count || 0),
    subscription: {
      id: row.subscription_id ? Number(row.subscription_id) : null,
      planName: row.plan_name || 'ยังไม่ได้กำหนดแพ็กเกจ',
      status: row.subscription_status || 'missing',
      startAt: row.subscription_start_at,
      endAt: row.subscription_end_at,
      billingInterval: row.billing_interval || '',
    },
    recentMarkets: recentMarkets.map((market) => ({
      id: market.id,
      code: market.code,
      name: market.name,
      status: market.status,
      openDate: market.open_date,
      closeDate: market.close_date,
    })),
    recentAdmins: recentAdmins.map((admin) => ({
      id: admin.id,
      role: admin.role,
      status: admin.status,
      name: decryptField(admin.name_enc) || '',
      email: decryptField(admin.email_enc) || '',
      lastLoginAt: admin.last_login_at,
    })),
  };
}

async function listSubscriptions(filters = {}) {
  const { search = '', status = 'all', page = 1, pageSize = 10 } = filters;
  const pagination = normalizePagination(page, pageSize);
  const keyword = search.trim();
  const params = {
    keyword: `%${keyword}%`,
    status,
    limit: pagination.pageSize,
    offset: pagination.offset,
  };

  const statusClause = status !== 'all' ? `AND os.status = :status` : '';
  const searchClause = keyword
    ? `AND (os.subscription_code LIKE :keyword OR o.code LIKE :keyword OR o.name LIKE :keyword OR sp.name LIKE :keyword)`
    : '';

  const [totalRow] = await query(
    `SELECT COUNT(*) AS total
     FROM organization_subscriptions os
     LEFT JOIN organizations o ON o.id = os.organization_id
     LEFT JOIN subscription_plans sp ON sp.id = os.plan_id
     WHERE 1 = 1
       ${statusClause}
       ${searchClause}`,
    params,
  );

  const rows = await query(
    `SELECT
        os.id,
        os.subscription_code,
        os.status,
        os.billing_interval,
        os.billing_interval_count,
        os.total_amount,
        os.billing_currency,
        os.included_markets,
        os.included_admin_users,
        os.included_active_booths,
        os.included_monthly_bookings,
        os.trial_starts_at,
        os.trial_ends_at,
        os.current_period_start,
        os.current_period_end,
        os.next_billing_at,
        os.created_at,
        o.id AS organization_id,
        o.code AS organization_code,
        o.name AS organization_name,
        o.status AS organization_status,
        sp.id AS plan_id,
        sp.code AS plan_code,
        sp.name AS plan_name,
        sp.price_display_label,
        COALESCE(inv.invoice_count, 0) AS invoice_count,
        COALESCE(inv.unpaid_invoice_count, 0) AS unpaid_invoice_count
     FROM organization_subscriptions os
     LEFT JOIN organizations o ON o.id = os.organization_id
     LEFT JOIN subscription_plans sp ON sp.id = os.plan_id
     LEFT JOIN (
       SELECT
         organization_subscription_id,
         COUNT(*) AS invoice_count,
         SUM(CASE WHEN status IN ('issued', 'overdue') THEN 1 ELSE 0 END) AS unpaid_invoice_count
       FROM subscription_invoices
       GROUP BY organization_subscription_id
     ) inv ON inv.organization_subscription_id = os.id
     WHERE 1 = 1
       ${statusClause}
       ${searchClause}
     ORDER BY os.created_at DESC, os.id DESC
     LIMIT :limit OFFSET :offset`,
    params,
  );

  return {
    items: rows.map((row) => ({
      id: row.id,
      subscriptionCode: row.subscription_code,
      status: row.status,
      billingInterval: row.billing_interval,
      billingIntervalCount: Number(row.billing_interval_count || 0),
      totalAmount: Number(row.total_amount || 0),
      currencyCode: row.billing_currency,
      includedMarkets: Number(row.included_markets || 0),
      includedAdminUsers: Number(row.included_admin_users || 0),
      includedActiveBooths: Number(row.included_active_booths || 0),
      includedMonthlyBookings: Number(row.included_monthly_bookings || 0),
      trialStartsAt: row.trial_starts_at,
      trialEndsAt: row.trial_ends_at,
      currentPeriodStart: row.current_period_start,
      currentPeriodEnd: row.current_period_end,
      nextBillingAt: row.next_billing_at,
      createdAt: row.created_at,
      organization: {
        id: row.organization_id,
        code: row.organization_code || '',
        name: row.organization_name || '',
        status: row.organization_status || '',
      },
      plan: {
        id: row.plan_id,
        code: row.plan_code || '',
        name: row.plan_name || 'ไม่ทราบแพ็กเกจ',
        priceDisplayLabel: row.price_display_label || 'N/A',
      },
      invoiceCount: Number(row.invoice_count || 0),
      unpaidInvoiceCount: Number(row.unpaid_invoice_count || 0),
    })),
    pagination: {
      page: pagination.page,
      pageSize: pagination.pageSize,
      total: Number(totalRow?.total || 0),
      totalPages: Math.max(Math.ceil(Number(totalRow?.total || 0) / pagination.pageSize), 1),
    },
  };
}

async function getSubscriptionDetail(subscriptionId) {
  const rows = await query(
    `SELECT
        os.id,
        os.subscription_code,
        os.status,
        os.billing_currency,
        os.billing_interval,
        os.billing_interval_count,
        os.unit_price,
        os.setup_fee,
        os.discount_amount,
        os.vat_rate,
        os.subtotal_amount,
        os.vat_amount,
        os.total_amount,
        os.included_markets,
        os.included_admin_users,
        os.included_active_booths,
        os.included_monthly_bookings,
        os.trial_starts_at,
        os.trial_ends_at,
        os.current_period_start,
        os.current_period_end,
        os.next_billing_at,
        os.activated_at,
        os.cancelled_at,
        os.created_at,
        o.id AS organization_id,
        o.code AS organization_code,
        o.name AS organization_name,
        o.status AS organization_status,
        sp.id AS plan_id,
        sp.code AS plan_code,
        sp.name AS plan_name,
        sp.description AS plan_description,
        sp.price_display_label,
        sp.public_visible,
        sp.is_free_tier,
        sp.is_full_function
     FROM organization_subscriptions os
     LEFT JOIN organizations o ON o.id = os.organization_id
     LEFT JOIN subscription_plans sp ON sp.id = os.plan_id
     WHERE os.id = :subscriptionId
     LIMIT 1`,
    { subscriptionId },
  );

  const row = rows[0];
  if (!row) {
    throw notFound('ไม่พบข้อมูลการสมัครใช้งาน');
  }

  const recentInvoices = await query(
    `SELECT
        id,
        invoice_no,
        invoice_type,
        status,
        subtotal_amount,
        vat_amount,
        total_amount,
        issued_at,
        due_at,
        paid_at
     FROM subscription_invoices
     WHERE organization_subscription_id = :subscriptionId
     ORDER BY created_at DESC, id DESC
     LIMIT 8`,
    { subscriptionId },
  );

  const entitlements = await query(
    `SELECT
        pe.feature_key,
        pe.enabled,
        pe.limit_quantity,
        fd.name,
        fd.category
     FROM subscription_plan_entitlements pe
     JOIN subscription_feature_definitions fd ON fd.feature_key = pe.feature_key
     WHERE pe.plan_id = :planId
     ORDER BY fd.category, fd.sort_order, fd.feature_key`,
    { planId: row.plan_id },
  );

  return {
    id: row.id,
    subscriptionCode: row.subscription_code,
    status: row.status,
    billingCurrency: row.billing_currency,
    billingInterval: row.billing_interval,
    billingIntervalCount: Number(row.billing_interval_count || 0),
    unitPrice: Number(row.unit_price || 0),
    setupFee: Number(row.setup_fee || 0),
    discountAmount: Number(row.discount_amount || 0),
    vatRate: Number(row.vat_rate || 0),
    subtotalAmount: Number(row.subtotal_amount || 0),
    vatAmount: Number(row.vat_amount || 0),
    totalAmount: Number(row.total_amount || 0),
    includedMarkets: Number(row.included_markets || 0),
    includedAdminUsers: Number(row.included_admin_users || 0),
    includedActiveBooths: Number(row.included_active_booths || 0),
    includedMonthlyBookings: Number(row.included_monthly_bookings || 0),
    trialStartsAt: row.trial_starts_at,
    trialEndsAt: row.trial_ends_at,
    currentPeriodStart: row.current_period_start,
    currentPeriodEnd: row.current_period_end,
    nextBillingAt: row.next_billing_at,
    activatedAt: row.activated_at,
    cancelledAt: row.cancelled_at,
    createdAt: row.created_at,
    organization: {
      id: row.organization_id,
      code: row.organization_code || '',
      name: row.organization_name || '',
      status: row.organization_status || '',
    },
    plan: {
      id: row.plan_id,
      code: row.plan_code || '',
      name: row.plan_name || 'ไม่ทราบแพ็กเกจ',
      description: row.plan_description || '',
      priceDisplayLabel: row.price_display_label || 'N/A',
      publicVisible: Boolean(row.public_visible),
      isFreeTier: Boolean(row.is_free_tier),
      isFullFunction: Boolean(row.is_full_function),
    },
    entitlements: entitlements.map((item) => ({
      featureKey: item.feature_key,
      name: item.name,
      category: item.category,
      enabled: Boolean(item.enabled),
      limitQuantity: item.limit_quantity == null ? null : Number(item.limit_quantity),
    })),
    recentInvoices: recentInvoices.map((invoice) => ({
      id: invoice.id,
      invoiceNo: invoice.invoice_no,
      invoiceType: invoice.invoice_type,
      status: invoice.status,
      subtotalAmount: Number(invoice.subtotal_amount || 0),
      vatAmount: Number(invoice.vat_amount || 0),
      totalAmount: Number(invoice.total_amount || 0),
      issuedAt: invoice.issued_at,
      dueAt: invoice.due_at,
      paidAt: invoice.paid_at,
    })),
  };
}

module.exports = {
  getPlatformDashboardSummary,
  getPlatformUserById,
  getOrganizationDetail,
  getSubscriptionDetail,
  listOrganizations,
  listSubscriptions,
  loginPlatform,
};
