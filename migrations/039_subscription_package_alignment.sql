UPDATE subscription_plans
SET status = 'inactive',
    public_visible = 0
WHERE code = 'enterprise';

UPDATE subscription_plans
SET name = 'Starter',
    description = 'เหมาะสำหรับตลาดเดี่ยวหรืออาคารเดียวที่เริ่มใช้ระบบ',
    price_display_label = 'N/A',
    included_markets = 1,
    included_admin_users = 3,
    included_active_booths = 80,
    included_monthly_bookings = 500,
    is_free_tier = 0,
    is_full_function = 0,
    public_visible = 1,
    status = 'active',
    sort_order = 1,
    features_json = JSON_ARRAY('1 market', '3 admin users', 'vendor booking app', 'audit workflow', 'accounting reports')
WHERE code = 'starter';

UPDATE subscription_plans
SET name = 'Growth',
    description = 'เหมาะสำหรับองค์กรที่มีหลายตลาดและต้องการฟังก์ชั่นบริหารครบขึ้น',
    price_display_label = 'N/A',
    included_markets = 5,
    included_admin_users = 10,
    included_active_booths = 300,
    included_monthly_bookings = 3000,
    is_free_tier = 0,
    is_full_function = 0,
    public_visible = 1,
    status = 'active',
    sort_order = 2,
    features_json = JSON_ARRAY('up to 5 markets', '10 admin users', 'advanced reports', 'audit workflow', 'PDPA tools', 'announcements')
WHERE code = 'growth';

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
  SELECT 'market_audit', 1, NULL UNION ALL
  SELECT 'announcements', 0, NULL UNION ALL
  SELECT 'tenant_management', 0, NULL UNION ALL
  SELECT 'pdpa_management', 0, NULL UNION ALL
  SELECT 'organization_settings', 1, NULL UNION ALL
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
  SELECT 'admin_management', 1, 10 UNION ALL
  SELECT 'subscription_billing', 0, NULL
) x
WHERE p.code = 'growth'
ON DUPLICATE KEY UPDATE enabled = VALUES(enabled), limit_quantity = VALUES(limit_quantity);
