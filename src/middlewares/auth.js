const jwt = require('jsonwebtoken');
const env = require('../config/env');
const { unauthorized } = require('../utils/errors');

function signToken(payload, options = {}) {
  return jwt.sign(payload, env.JWT_SECRET, {
    expiresIn: options.expiresIn || env.JWT_EXPIRES_IN,
    issuer: 'jonglock-backend',
  });
}

function authenticate(req, res, next) {
  const header = req.headers.authorization || '';
  const [, token] = header.match(/^Bearer\s+(.+)$/i) || [];

  if (!token) return next(unauthorized());

  try {
    req.auth = jwt.verify(token, env.JWT_SECRET, { issuer: 'jonglock-backend' });
    return next();
  } catch (error) {
    return next(unauthorized('Invalid or expired token'));
  }
}

module.exports = {
  authenticate,
  signToken,
};
