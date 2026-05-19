ALTER TABLE subscription_plans
  ADD COLUMN public_visible TINYINT(1) NOT NULL DEFAULT 1 AFTER status,
  ADD COLUMN is_free_tier TINYINT(1) NOT NULL DEFAULT 0 AFTER public_visible,
  ADD COLUMN is_full_function TINYINT(1) NOT NULL DEFAULT 0 AFTER is_free_tier,
  ADD COLUMN price_display_label VARCHAR(80) NOT NULL DEFAULT 'N/A' AFTER base_price,
  ADD COLUMN grace_period_days INT NOT NULL DEFAULT 0 AFTER trial_days;

CREATE TABLE subscription_feature_definitions (
  feature_key VARCHAR(80) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  category VARCHAR(80) NOT NULL DEFAULT 'management',
  sort_order INT NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (feature_key),
  KEY idx_subscription_feature_definitions_status (status, category, sort_order)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE subscription_plan_entitlements (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  plan_id BIGINT UNSIGNED NOT NULL,
  feature_key VARCHAR(80) NOT NULL,
  enabled TINYINT(1) NOT NULL DEFAULT 1,
  limit_quantity INT NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_subscription_plan_entitlements_plan_feature (plan_id, feature_key),
  KEY idx_subscription_plan_entitlements_feature (feature_key, enabled),
  CONSTRAINT fk_subscription_plan_entitlements_plan FOREIGN KEY (plan_id) REFERENCES subscription_plans(id),
  CONSTRAINT fk_subscription_plan_entitlements_feature FOREIGN KEY (feature_key) REFERENCES subscription_feature_definitions(feature_key)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO subscription_feature_definitions (feature_key, name, description, category, sort_order, status) VALUES
('dashboard', 'Dashboard', 'ดูภาพรวมระบบ', 'management', 10, 'active'),
('market_management', 'Market management', 'จัดการตลาด รูปภาพตลาด วันหยุด และข้อมูลทั่วไป', 'management', 20, 'active'),
('booth_management', 'Booth management', 'จัดการแบบ Booth และ Booth', 'management', 30, 'active'),
('product_management', 'Product management', 'จัดการประเภทสินค้า หมวดหมู่ และสินค้า', 'management', 40, 'active'),
('coupon_management', 'Coupon management', 'จัดการโค้ดส่วนลดและรายการแจกโค้ด', 'management', 50, 'active'),
('booking_management', 'Booking management', 'จองแทนสมาชิก แก้ไขการจอง และจัดการรายการจอง', 'management', 60, 'active'),
('reports', 'Reports', 'ดูและส่งออกรายงาน', 'management', 70, 'active'),
('market_audit', 'Market audit', 'ตรวจสอบตลาดและจัดการค่าปรับ', 'management', 80, 'active'),
('announcements', 'Announcements', 'จัดการข่าวสารและประชาสัมพันธ์', 'management', 90, 'active'),
('tenant_management', 'Tenant management', 'จัดการรายงานผู้เช่า', 'management', 100, 'active'),
('pdpa_management', 'PDPA management', 'จัดการ PDPA และเนื้อหายินยอม', 'management', 110, 'active'),
('organization_settings', 'Organization settings', 'จัดการข้อมูลองค์กรและภาษี', 'management', 120, 'active'),
('admin_management', 'Admin management', 'จัดการผู้ดูแลระบบและสิทธิ์ตลาด', 'management', 130, 'active'),
('accounting', 'Accounting', 'รายงานบัญชี เอกสารบัญชี ภาษีขาย และลูกหนี้', 'management', 140, 'active'),
('mobile_booking_app', 'Mobile booking app', 'ให้ผู้ค้าใช้งานแอปและสร้างรายการจอง', 'mobile', 150, 'active'),
('subscription_billing', 'Subscription billing', 'รองรับการคิดค่าบริการ subscription, usage และ invoice', 'billing', 160, 'active')
ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  category = VALUES(category),
  sort_order = VALUES(sort_order),
  status = VALUES(status);

INSERT INTO subscription_plans (
  code, name, description, trial_days, grace_period_days, billing_interval, billing_interval_count,
  currency_code, base_price, price_display_label, setup_fee, included_markets, included_admin_users,
  included_active_booths, included_monthly_bookings, overage_market_price, overage_admin_user_price,
  overage_booth_price, overage_booking_price, vat_applicable, features_json, status, public_visible,
  is_free_tier, is_full_function, sort_order
) VALUES (
  'free_full_1y',
  'Free tier 1 ปี',
  'ใช้ฟรี 1 ปีแบบ Full function สำหรับช่วงเปิดตัว',
  365,
  0,
  'yearly',
  1,
  'THB',
  0.00,
  'ใช้ฟรี 1 ปี',
  0.00,
  9999,
  9999,
  999999,
  999999,
  0.00,
  0.00,
  0.00,
  0.00,
  0,
  JSON_ARRAY('Full function 1 year', 'unlimited markets during trial', 'all management modules', 'mobile booking app', 'accounting reports'),
  'active',
  1,
  1,
  1,
  0
) ON DUPLICATE KEY UPDATE
  name = VALUES(name),
  description = VALUES(description),
  trial_days = VALUES(trial_days),
  grace_period_days = VALUES(grace_period_days),
  base_price = VALUES(base_price),
  price_display_label = VALUES(price_display_label),
  included_markets = VALUES(included_markets),
  included_admin_users = VALUES(included_admin_users),
  included_active_booths = VALUES(included_active_booths),
  included_monthly_bookings = VALUES(included_monthly_bookings),
  vat_applicable = VALUES(vat_applicable),
  features_json = VALUES(features_json),
  status = VALUES(status),
  public_visible = VALUES(public_visible),
  is_free_tier = VALUES(is_free_tier),
  is_full_function = VALUES(is_full_function),
  sort_order = VALUES(sort_order);

UPDATE subscription_plans
SET price_display_label = 'N/A',
    public_visible = 1,
    is_free_tier = 0,
    is_full_function = CASE WHEN code = 'enterprise' THEN 1 ELSE 0 END
WHERE code IN ('starter', 'growth', 'enterprise');

INSERT INTO subscription_plan_entitlements (plan_id, feature_key, enabled, limit_quantity)
SELECT p.id, f.feature_key, 1, NULL
FROM subscription_plans p
CROSS JOIN subscription_feature_definitions f
WHERE p.code IN ('free_full_1y', 'enterprise')
ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), limit_quantity = VALUES(limit_quantity);

INSERT INTO subscription_plan_entitlements (plan_id, feature_key, enabled, limit_quantity)
SELECT p.id, x.feature_key, x.enabled, x.limit_quantity
FROM subscription_plans p
JOIN (
  SELECT 'dashboard' AS feature_key, 1 AS enabled, NULL AS limit_quantity UNION ALL
  SELECT 'market_management', 1, 1 UNION ALL
  SELECT 'booth_management', 1, 80 UNION ALL
  SELECT 'product_management', 1, NULL UNION ALL
  SELECT 'coupon_management', 1, NULL UNION ALL
  SELECT 'booking_management', 1, 500 UNION ALL
  SELECT 'reports', 1, NULL UNION ALL
  SELECT 'accounting', 1, NULL UNION ALL
  SELECT 'mobile_booking_app', 1, NULL UNION ALL
  SELECT 'market_audit', 0, NULL UNION ALL
  SELECT 'announcements', 0, NULL UNION ALL
  SELECT 'tenant_management', 0, NULL UNION ALL
  SELECT 'pdpa_management', 0, NULL UNION ALL
  SELECT 'organization_settings', 0, NULL UNION ALL
  SELECT 'admin_management', 1, 3 UNION ALL
  SELECT 'subscription_billing', 0, NULL
) x
WHERE p.code = 'starter'
ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), limit_quantity = VALUES(limit_quantity);

INSERT INTO subscription_plan_entitlements (plan_id, feature_key, enabled, limit_quantity)
SELECT p.id, x.feature_key, x.enabled, x.limit_quantity
FROM subscription_plans p
JOIN (
  SELECT 'dashboard' AS feature_key, 1 AS enabled, NULL AS limit_quantity UNION ALL
  SELECT 'market_management', 1, 3 UNION ALL
  SELECT 'booth_management', 1, 300 UNION ALL
  SELECT 'product_management', 1, NULL UNION ALL
  SELECT 'coupon_management', 1, NULL UNION ALL
  SELECT 'booking_management', 1, 3000 UNION ALL
  SELECT 'reports', 1, NULL UNION ALL
  SELECT 'accounting', 1, NULL UNION ALL
  SELECT 'mobile_booking_app', 1, NULL UNION ALL
  SELECT 'market_audit', 1, NULL UNION ALL
  SELECT 'announcements', 1, NULL UNION ALL
  SELECT 'tenant_management', 1, NULL UNION ALL
  SELECT 'pdpa_management', 0, NULL UNION ALL
  SELECT 'organization_settings', 1, NULL UNION ALL
  SELECT 'admin_management', 1, 10 UNION ALL
  SELECT 'subscription_billing', 1, NULL
) x
WHERE p.code = 'growth'
ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), limit_quantity = VALUES(limit_quantity);

INSERT INTO organization_subscriptions (
  subscription_code, organization_id, plan_id, status, billing_currency, billing_interval, billing_interval_count,
  unit_price, setup_fee, discount_amount, vat_rate, subtotal_amount, vat_amount, total_amount,
  included_markets, included_admin_users, included_active_booths, included_monthly_bookings,
  trial_starts_at, trial_ends_at, current_period_start, current_period_end, next_billing_at, activated_at, metadata_json
)
SELECT
  CONCAT('OSUB', DATE_FORMAT(NOW(), '%y%m%d'), LPAD(o.id, 6, '0')),
  o.id,
  p.id,
  'trialing',
  p.currency_code,
  'yearly',
  1,
  0,
  0,
  0,
  0,
  0,
  0,
  0,
  p.included_markets,
  p.included_admin_users,
  p.included_active_booths,
  p.included_monthly_bookings,
  NOW(),
  DATE_ADD(NOW(), INTERVAL 365 DAY),
  NOW(),
  DATE_ADD(NOW(), INTERVAL 365 DAY),
  DATE_ADD(NOW(), INTERVAL 365 DAY),
  NOW(),
  JSON_OBJECT('source', 'migration_018_free_full_1y')
FROM organizations o
JOIN subscription_plans p ON p.code = 'free_full_1y'
WHERE NOT EXISTS (
  SELECT 1
  FROM organization_subscriptions os
  WHERE os.organization_id = o.id
    AND os.status IN ('pending_activation', 'trialing', 'active', 'past_due')
);
