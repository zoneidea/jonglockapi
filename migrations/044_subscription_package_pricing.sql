UPDATE subscription_plans
SET name = 'สตาร์ทเตอร์',
    description = 'เหมาะสำหรับตลาดเดี่ยวหรืออาคารเดียวที่เริ่มใช้ระบบบริหารพื้นที่ขาย',
    trial_days = 90,
    billing_interval = 'monthly',
    billing_interval_count = 1,
    base_price = 999.00,
    price_display_label = '999 บาท/เดือน',
    included_markets = 1,
    included_admin_users = 1,
    included_active_booths = 80,
    included_monthly_bookings = 500,
    is_free_tier = 0,
    is_full_function = 0,
    public_visible = 1,
    status = 'active',
    sort_order = 1,
    features_json = JSON_ARRAY(
      '1 market',
      '1 admin user excluding supervisor',
      'vendor booking app',
      'audit workflow',
      'basic reports'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE code = 'starter';

UPDATE subscription_plans
SET name = 'ธุรกิจ',
    description = 'เหมาะสำหรับองค์กรที่มีหลายตลาดและต้องการบริหารงานหลายส่วนในระบบเดียว',
    trial_days = 90,
    billing_interval = 'monthly',
    billing_interval_count = 1,
    base_price = 1999.00,
    price_display_label = '1,999 บาท/เดือน',
    included_markets = 5,
    included_admin_users = 3,
    included_active_booths = 300,
    included_monthly_bookings = 3000,
    is_free_tier = 0,
    is_full_function = 0,
    public_visible = 1,
    status = 'active',
    sort_order = 2,
    features_json = JSON_ARRAY(
      'up to 5 markets',
      '3 admin users excluding supervisor',
      'advanced reports',
      'audit workflow',
      'PDPA tools',
      'announcements',
      'accounting reports'
    ),
    updated_at = CURRENT_TIMESTAMP
WHERE code = 'growth';

INSERT INTO subscription_plan_entitlements (plan_id, feature_key, enabled, limit_quantity, metadata_json)
SELECT p.id, x.feature_key, x.enabled, x.limit_quantity, JSON_OBJECT('annual_discount_percent', 15)
FROM subscription_plans p
JOIN (
  SELECT 'dashboard' AS feature_key, 1 AS enabled, NULL AS limit_quantity UNION ALL
  SELECT 'market_management', 1, 1 UNION ALL
  SELECT 'booth_management', 1, 80 UNION ALL
  SELECT 'product_management', 1, NULL UNION ALL
  SELECT 'coupon_management', 1, NULL UNION ALL
  SELECT 'booking_management', 1, 500 UNION ALL
  SELECT 'reports', 1, NULL UNION ALL
  SELECT 'accounting', 0, NULL UNION ALL
  SELECT 'mobile_booking_app', 1, NULL UNION ALL
  SELECT 'market_audit', 1, NULL UNION ALL
  SELECT 'announcements', 0, NULL UNION ALL
  SELECT 'tenant_management', 0, NULL UNION ALL
  SELECT 'pdpa_management', 0, NULL UNION ALL
  SELECT 'organization_settings', 1, NULL UNION ALL
  SELECT 'admin_management', 1, 1 UNION ALL
  SELECT 'subscription_billing', 0, NULL
) x
WHERE p.code = 'starter'
ON DUPLICATE KEY UPDATE
  enabled = VALUES(enabled),
  limit_quantity = VALUES(limit_quantity),
  metadata_json = VALUES(metadata_json);

INSERT INTO subscription_plan_entitlements (plan_id, feature_key, enabled, limit_quantity, metadata_json)
SELECT p.id, x.feature_key, x.enabled, x.limit_quantity, JSON_OBJECT('annual_discount_percent', 15)
FROM subscription_plans p
JOIN (
  SELECT 'dashboard' AS feature_key, 1 AS enabled, NULL AS limit_quantity UNION ALL
  SELECT 'market_management', 1, 5 UNION ALL
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
  SELECT 'pdpa_management', 1, NULL UNION ALL
  SELECT 'organization_settings', 1, NULL UNION ALL
  SELECT 'admin_management', 1, 3 UNION ALL
  SELECT 'subscription_billing', 0, NULL
) x
WHERE p.code = 'growth'
ON DUPLICATE KEY UPDATE
  enabled = VALUES(enabled),
  limit_quantity = VALUES(limit_quantity),
  metadata_json = VALUES(metadata_json);
