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
    section: 'เมนูหลัก',
    items: [
      { key: 'dashboard', label: 'ภาพรวมระบบ', path: '/dashboard' },
    ],
  },
  {
    section: 'บริหารแพลตฟอร์ม',
    items: [
      { key: 'organizations', label: 'องค์กร', path: '/organizations' },
      { key: 'subscriptions', label: 'การสมัครแพ็กเกจ', path: '/subscriptions' },
      { key: 'billing', label: 'การเงิน', path: '/billing' },
    ],
  },
  {
    section: 'เครื่องมือ',
    items: [
      { key: 'support', label: 'ช่วยเหลือ', path: '/support' },
      { key: 'monitoring', label: 'สถานะระบบ', path: '/monitoring' },
      { key: 'settings', label: 'ตั้งค่าระบบ', path: '/settings' },
    ],
  },
]);

module.exports = {
  PLATFORM_ROLES,
  PLATFORM_MENU_ACCESS,
  PLATFORM_NAVIGATION,
};
