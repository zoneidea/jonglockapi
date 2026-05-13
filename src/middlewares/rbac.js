const { ROLES } = require('../constants/roles');
const { forbidden } = require('../utils/errors');

function requireRoles(...roles) {
  return (req, res, next) => {
    if (!req.auth || !roles.includes(req.auth.role)) {
      return next(forbidden('Role is not allowed'));
    }

    return next();
  };
}

function requireManagement(req, res, next) {
  if (!req.auth || req.auth.userType !== 'admin') {
    return next(forbidden('Management account is required'));
  }

  return next();
}

function requireMobileAccount(req, res, next) {
  if (!req.auth || !['customer', 'audit'].includes(req.auth.userType)) {
    return next(forbidden('Mobile account is required'));
  }

  return next();
}

function requireMarketAccess(paramName = 'marketId') {
  return (req, res, next) => {
    if (!req.auth) return next(forbidden());
    if ([ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role)) return next();

    const marketId = Number(req.params[paramName] || req.query[paramName] || req.body[paramName]);
    const allowed = req.auth.marketIds || [];

    if (!marketId || !allowed.includes(marketId)) {
      return next(forbidden('Market is not assigned to this account'));
    }

    return next();
  };
}

module.exports = {
  requireRoles,
  requireManagement,
  requireMobileAccount,
  requireMarketAccess,
};
