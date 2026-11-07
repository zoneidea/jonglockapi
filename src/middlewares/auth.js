const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { unauthorized } = require('../utils/errors');
const { query } = require('../config/db');

function signToken(payload, options = {}) {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: options.expiresIn || env.JWT_EXPIRES_IN,
    issuer: 'jonglock-backend',
  });
}

async function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [, token] = header.match(/^Bearer\s+(.+)$/i) || [];

  if (!token) return next(unauthorized());

  try {
    req.auth = jwt.verify(token, env.JWT_SECRET, { issuer: 'jonglock-backend' });
  } catch (error) {
    return next(unauthorized('Invalid or expired token'));
  }
  if (req.auth.userType === 'customer') {
    try {
      const users = await query(`SELECT id FROM mobile_users
        WHERE organization_id = :organizationId AND id = :userId AND status = 'active' LIMIT 1`,
      { organizationId: req.auth.organizationId, userId: req.auth.sub });
      if (!users.length) return next(unauthorized('Account is no longer active'));
    } catch (error) { return next(error); }
  }
  return next();
}

module.exports = {
  authenticate,
  signToken,
};
