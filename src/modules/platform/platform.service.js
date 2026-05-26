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
    throw notFound('Platform user not found');
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
    throw unauthorized('Username or password is incorrect');
  }

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) {
    throw unauthorized('Username or password is incorrect');
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
      planName: row.plan_name || 'No plan',
      createdAt: row.created_at,
    })),
  };
}

module.exports = {
  getPlatformDashboardSummary,
  getPlatformUserById,
  loginPlatform,
};
