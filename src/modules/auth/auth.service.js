const bcrypt = require('bcryptjs');
const env = require('../../config/env');
const { query } = require('../../config/db');
const { ROLES, MENU_ACCESS } = require('../../constants/roles');
const { signToken } = require('../../middlewares/auth');
const { blindIndex, decryptField } = require('../../utils/crypto');
const { unauthorized, forbidden } = require('../../utils/errors');

async function getAssignedMarketIds(adminUserId) {
  const rows = await query(
    `SELECT market_id FROM admin_market_assignments WHERE admin_user_id = :adminUserId AND status = 'active'`,
    { adminUserId },
  );
  return rows.map((row) => row.market_id);
}

async function loginManagement({ organizationCode, username, password }) {
  const usernameHash = blindIndex(username);
  const rows = await query(
    `SELECT au.id, au.organization_id, au.role, au.username_hash, au.password_hash, au.name_enc, au.email_enc, au.status,
            o.code AS organization_code, o.name AS organization_name
     FROM admin_users au
     JOIN organizations o ON o.id = au.organization_id
     WHERE au.username_hash = :usernameHash
       AND o.code = :organizationCode
     LIMIT 1`,
    { usernameHash, organizationCode },
  );

  const user = rows[0];
  if (!user || user.status !== 'active') throw unauthorized('Username or password is incorrect');

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw unauthorized('Username or password is incorrect');

  if (user.role === ROLES.AUDIT) {
    throw forbidden('Audit role must use mobile audit route');
  }

  const marketIds = await getAssignedMarketIds(user.id);
  const token = signToken({
    sub: user.id,
    userType: 'admin',
    role: user.role,
    organizationId: user.organization_id,
    marketIds,
  });

  return {
    token,
    user: {
      id: user.id,
      organizationId: user.organization_id,
      organizationCode: user.organization_code,
      organizationName: user.organization_name,
      role: user.role,
      menus: MENU_ACCESS[user.role] || [],
      marketIds,
      name: decryptField(user.name_enc),
      email: decryptField(user.email_enc),
    },
  };
}

async function loginMobile({ organizationId, username, password }) {
  const usernameHash = blindIndex(username);
  const rows = await query(
    `SELECT id, organization_id, password_hash, first_name_enc, last_name_enc, status
     FROM mobile_users
     WHERE organization_id = :organizationId AND username_hash = :usernameHash
     LIMIT 1`,
    { organizationId, usernameHash },
  );

  const user = rows[0];
  if (!user || user.status !== 'active') throw unauthorized('Username or password is incorrect');

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw unauthorized('Username or password is incorrect');

  const token = signToken(
    {
      sub: user.id,
      userType: 'customer',
      role: ROLES.CUSTOMER,
      organizationId: user.organization_id,
      marketIds: [],
    },
    { expiresIn: env.MOBILE_JWT_EXPIRES_IN },
  );

  return {
    token,
    user: {
      id: user.id,
      organizationId: user.organization_id,
      firstName: decryptField(user.first_name_enc),
      lastName: decryptField(user.last_name_enc),
    },
  };
}

async function loginAudit({ organizationCode, username, password }) {
  const usernameHash = blindIndex(username);
  const rows = await query(
    `SELECT au.id, au.organization_id, au.role, au.password_hash, au.name_enc, au.status,
            o.code AS organization_code, o.name AS organization_name
     FROM admin_users au
     JOIN organizations o ON o.id = au.organization_id
     WHERE au.username_hash = :usernameHash
       AND au.role = 'audit'
       AND o.code = :organizationCode
     LIMIT 1`,
    { usernameHash, organizationCode },
  );

  const user = rows[0];
  if (!user || user.status !== 'active') throw unauthorized('Username or password is incorrect');

  const valid = await bcrypt.compare(password, user.password_hash);
  if (!valid) throw unauthorized('Username or password is incorrect');

  const marketIds = await getAssignedMarketIds(user.id);
  const token = signToken(
    {
      sub: user.id,
      userType: 'audit',
      role: ROLES.AUDIT,
      organizationId: user.organization_id,
      marketIds,
    },
    { expiresIn: env.MOBILE_JWT_EXPIRES_IN },
  );

  return {
    token,
    user: {
      id: user.id,
      organizationId: user.organization_id,
      organizationCode: user.organization_code,
      organizationName: user.organization_name,
      role: user.role,
      menus: MENU_ACCESS[user.role],
      marketIds,
      name: decryptField(user.name_enc),
    },
  };
}

module.exports = {
  loginManagement,
  loginMobile,
  loginAudit,
};
