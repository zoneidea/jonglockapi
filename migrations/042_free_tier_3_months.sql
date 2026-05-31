UPDATE subscription_plans
SET
  name = 'Free tier 3 เดือน',
  description = 'ใช้ฟรี 3 เดือนแบบ Full function สำหรับช่วงเปิดตัว',
  trial_days = 90,
  price_display_label = 'ใช้ฟรี 3 เดือน',
  features_json = JSON_ARRAY(
    'Full function 3 months',
    'unlimited markets during trial',
    'all management modules',
    'mobile booking app',
    'accounting reports'
  ),
  updated_at = CURRENT_TIMESTAMP
WHERE code = 'free_full_1y';

UPDATE organization_subscriptions os
JOIN subscription_plans sp
  ON sp.id = os.plan_id
 AND sp.code = 'free_full_1y'
SET
  os.trial_ends_at = DATE_ADD(COALESCE(os.trial_starts_at, os.activated_at, os.created_at), INTERVAL 90 DAY),
  os.current_period_end = DATE_ADD(COALESCE(os.current_period_start, os.trial_starts_at, os.activated_at, os.created_at), INTERVAL 90 DAY),
  os.next_billing_at = DATE_ADD(COALESCE(os.current_period_start, os.trial_starts_at, os.activated_at, os.created_at), INTERVAL 90 DAY),
  os.updated_at = CURRENT_TIMESTAMP
WHERE os.status IN ('pending_activation', 'trialing');
