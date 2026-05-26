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
    section: 'ภาพรวม',
    items: [
      { key: 'dashboard', label: 'แดชบอร์ด', path: '/dashboard' },
    ],
  },
  {
    section: 'แพลตฟอร์ม',
    items: [
      { key: 'organizations', label: 'จัดการองค์กร', path: '/organizations' },
      { key: 'subscriptions', label: 'การสมัครใช้งาน', path: '/subscriptions' },
      { key: 'billing', label: 'การเงินแพลตฟอร์ม', path: '/billing' },
    ],
  },
  {
    section: 'ปฏิบัติการ',
    items: [
      { key: 'support', label: 'ศูนย์ช่วยเหลือ', path: '/support' },
      { key: 'monitoring', label: 'ติดตามระบบ', path: '/monitoring' },
      { key: 'settings', label: 'ตั้งค่าแพลตฟอร์ม', path: '/settings' },
    ],
  },
]);

module.exports = {
  PLATFORM_ROLES,
  PLATFORM_MENU_ACCESS,
  PLATFORM_NAVIGATION,
};
