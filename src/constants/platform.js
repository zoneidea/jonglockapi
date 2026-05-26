const PLATFORM_ROLES = Object.freeze({
  SUPERADMIN: 'platform_superadmin',
  SUPPORT: 'platform_support',
  BILLING: 'platform_billing',
  OPS: 'platform_ops',
  AUDIT: 'platform_audit',
});

const PLATFORM_MENU_ACCESS = Object.freeze({
  [PLATFORM_ROLES.SUPERADMIN]: ['dashboard', 'organizations', 'subscriptions', 'billing', 'support', 'monitoring', 'settings'],
  [PLATFORM_ROLES.SUPPORT]: ['dashboard', 'organizations', 'support'],
  [PLATFORM_ROLES.BILLING]: ['dashboard', 'subscriptions', 'billing'],
  [PLATFORM_ROLES.OPS]: ['dashboard', 'organizations', 'monitoring'],
  [PLATFORM_ROLES.AUDIT]: ['dashboard', 'monitoring'],
});

const PLATFORM_NAVIGATION = Object.freeze([
  {
    section: 'Overview',
    items: [
      { key: 'dashboard', label: 'Dashboard', path: '/dashboard' },
    ],
  },
  {
    section: 'Platform',
    items: [
      { key: 'organizations', label: 'Organizations', path: '/organizations' },
      { key: 'subscriptions', label: 'Subscriptions', path: '/subscriptions' },
      { key: 'billing', label: 'Billing', path: '/billing' },
    ],
  },
  {
    section: 'Operations',
    items: [
      { key: 'support', label: 'Support Center', path: '/support' },
      { key: 'monitoring', label: 'Monitoring', path: '/monitoring' },
      { key: 'settings', label: 'Platform Settings', path: '/settings' },
    ],
  },
]);

module.exports = {
  PLATFORM_ROLES,
  PLATFORM_MENU_ACCESS,
  PLATFORM_NAVIGATION,
};
