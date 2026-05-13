const ROLES = Object.freeze({
  SUPERVISOR: 'supervisor',
  ADMIN: 'admin',
  ACCOUNTING: 'accounting',
  AUDIT: 'audit',
  CUSTOMER: 'customer',
});

const MENU_ACCESS = Object.freeze({
  [ROLES.SUPERVISOR]: ['markets', 'products', 'coupons', 'bookings', 'reports', 'market_audit', 'accounting', 'admins'],
  [ROLES.ADMIN]: ['markets', 'products', 'coupons', 'bookings', 'reports', 'market_audit'],
  [ROLES.ACCOUNTING]: ['accounting'],
  [ROLES.AUDIT]: ['mobile_audit'],
});

module.exports = {
  ROLES,
  MENU_ACCESS,
};
