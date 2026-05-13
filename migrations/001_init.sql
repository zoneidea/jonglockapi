CREATE TABLE organizations (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_organizations_code (code)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE markets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(50) NOT NULL,
  name VARCHAR(255) NOT NULL,
  description TEXT NULL,
  open_date DATE NULL,
  close_date DATE NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_markets_org_code (organization_id, code),
  KEY idx_markets_org_status (organization_id, status),
  CONSTRAINT fk_markets_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  username_hash CHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('supervisor','admin','accounting','audit') NOT NULL,
  name_enc TEXT NULL,
  email_enc TEXT NULL,
  email_hash CHAR(64) NULL,
  phone_enc TEXT NULL,
  phone_hash CHAR(64) NULL,
  status ENUM('active','suspended','inactive') NOT NULL DEFAULT 'active',
  last_login_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_users_org_username (organization_id, username_hash),
  KEY idx_admin_users_org_role (organization_id, role),
  CONSTRAINT fk_admin_users_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE admin_market_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  admin_user_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_admin_market (admin_user_id, market_id),
  KEY idx_admin_market_org (organization_id, market_id),
  CONSTRAINT fk_admin_market_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_admin_market_user FOREIGN KEY (admin_user_id) REFERENCES admin_users(id),
  CONSTRAINT fk_admin_market_market FOREIGN KEY (market_id) REFERENCES markets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE mobile_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  public_id VARCHAR(40) NOT NULL,
  username_hash CHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  first_name_enc TEXT NULL,
  last_name_enc TEXT NULL,
  phone_enc TEXT NULL,
  phone_hash CHAR(64) NULL,
  email_enc TEXT NULL,
  email_hash CHAR(64) NULL,
  id_card_enc TEXT NULL,
  id_card_hash CHAR(64) NULL,
  address_enc TEXT NULL,
  accepted_consent_at DATETIME NULL,
  status ENUM('active','pending','suspended','deleted') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_mobile_users_public_id (public_id),
  UNIQUE KEY uq_mobile_users_org_username (organization_id, username_hash),
  KEY idx_mobile_users_org_phone (organization_id, phone_hash),
  KEY idx_mobile_users_org_email (organization_id, email_hash),
  CONSTRAINT fk_mobile_users_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_categories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NULL,
  name VARCHAR(255) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_product_categories_scope (organization_id, market_id, status),
  CONSTRAINT fk_product_categories_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_product_categories_market FOREIGN KEY (market_id) REFERENCES markets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE product_groups (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_product_groups_scope (organization_id, market_id, category_id, status),
  CONSTRAINT fk_product_groups_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_product_groups_market FOREIGN KEY (market_id) REFERENCES markets(id),
  CONSTRAINT fk_product_groups_category FOREIGN KEY (category_id) REFERENCES product_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE floor_plans (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  plan_image_url TEXT NULL,
  start_date DATE NOT NULL,
  end_date DATE NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_floor_plans_market_date (organization_id, market_id, start_date, end_date, status),
  CONSTRAINT fk_floor_plans_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_floor_plans_market FOREIGN KEY (market_id) REFERENCES markets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE booths (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  floor_plan_id BIGINT UNSIGNED NULL,
  category_id BIGINT UNSIGNED NULL,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  x DECIMAL(10,2) NULL,
  y DECIMAL(10,2) NULL,
  width DECIMAL(10,2) NULL,
  height DECIMAL(10,2) NULL,
  sort_order INT NOT NULL DEFAULT 0,
  status ENUM('active','inactive','maintenance') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_booths_market_code (organization_id, market_id, code),
  KEY idx_booths_market (organization_id, market_id, floor_plan_id, status),
  CONSTRAINT fk_booths_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_booths_market FOREIGN KEY (market_id) REFERENCES markets(id),
  CONSTRAINT fk_booths_floor_plan FOREIGN KEY (floor_plan_id) REFERENCES floor_plans(id),
  CONSTRAINT fk_booths_category FOREIGN KEY (category_id) REFERENCES product_categories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  category_id BIGINT UNSIGNED NOT NULL,
  group_id BIGINT UNSIGNED NULL,
  name VARCHAR(255) NOT NULL,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_products_market (organization_id, market_id, category_id, group_id, status),
  CONSTRAINT fk_products_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_products_market FOREIGN KEY (market_id) REFERENCES markets(id),
  CONSTRAINT fk_products_category FOREIGN KEY (category_id) REFERENCES product_categories(id),
  CONSTRAINT fk_products_group FOREIGN KEY (group_id) REFERENCES product_groups(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE accessories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  name VARCHAR(255) NOT NULL,
  price DECIMAL(12,2) NOT NULL DEFAULT 0,
  stock_quantity INT NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_accessories_market (organization_id, market_id, status),
  CONSTRAINT fk_accessories_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_accessories_market FOREIGN KEY (market_id) REFERENCES markets(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE coupons (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  code VARCHAR(80) NOT NULL,
  name VARCHAR(255) NOT NULL,
  discount_type ENUM('amount','percent') NOT NULL DEFAULT 'amount',
  discount_value DECIMAL(12,2) NOT NULL,
  usage_limit INT NULL,
  starts_at DATETIME NOT NULL,
  ends_at DATETIME NOT NULL,
  created_by_admin_id BIGINT UNSIGNED NOT NULL,
  status ENUM('active','assigned','redeemed','expired','inactive') NOT NULL DEFAULT 'active',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_coupons_org_code (organization_id, code),
  KEY idx_coupons_market_status (organization_id, market_id, status, starts_at, ends_at),
  CONSTRAINT fk_coupons_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_coupons_market FOREIGN KEY (market_id) REFERENCES markets(id),
  CONSTRAINT fk_coupons_created_by FOREIGN KEY (created_by_admin_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE coupon_assignments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  coupon_id BIGINT UNSIGNED NOT NULL,
  mobile_user_id BIGINT UNSIGNED NOT NULL,
  status ENUM('available','used','cancelled') NOT NULL DEFAULT 'available',
  message TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  used_at DATETIME NULL,
  PRIMARY KEY (id),
  UNIQUE KEY uq_coupon_user (coupon_id, mobile_user_id),
  KEY idx_coupon_assignments_user (organization_id, mobile_user_id, status),
  CONSTRAINT fk_coupon_assignments_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_coupon_assignments_coupon FOREIGN KEY (coupon_id) REFERENCES coupons(id),
  CONSTRAINT fk_coupon_assignments_user FOREIGN KEY (mobile_user_id) REFERENCES mobile_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE bookings (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  public_id VARCHAR(40) NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  mobile_user_id BIGINT UNSIGNED NOT NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  source ENUM('mobile','management') NOT NULL DEFAULT 'mobile',
  status ENUM('draft','pending_payment','payment_processing','paid','expired','cancelled','refunded') NOT NULL DEFAULT 'draft',
  subtotal_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  discount_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  expires_at DATETIME NULL,
  paid_at DATETIME NULL,
  comment TEXT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_bookings_public_id (public_id),
  KEY idx_bookings_market_status (organization_id, market_id, status, created_at),
  KEY idx_bookings_mobile_user (organization_id, mobile_user_id, created_at),
  CONSTRAINT fk_bookings_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_bookings_market FOREIGN KEY (market_id) REFERENCES markets(id),
  CONSTRAINT fk_bookings_mobile_user FOREIGN KEY (mobile_user_id) REFERENCES mobile_users(id),
  CONSTRAINT fk_bookings_created_by FOREIGN KEY (created_by_admin_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE booking_items (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  booking_id BIGINT UNSIGNED NOT NULL,
  booth_id BIGINT UNSIGNED NOT NULL,
  booking_date DATE NOT NULL,
  unit_price DECIMAL(12,2) NOT NULL DEFAULT 0,
  status ENUM('pending_payment','payment_processing','paid','cancelled','expired') NOT NULL DEFAULT 'pending_payment',
  audit_status ENUM('pending','pass','warning','failed') NOT NULL DEFAULT 'pending',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_booking_items_booth_date (organization_id, booth_id, booking_date, status),
  KEY idx_booking_items_booking (booking_id),
  CONSTRAINT fk_booking_items_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_booking_items_booking FOREIGN KEY (booking_id) REFERENCES bookings(id),
  CONSTRAINT fk_booking_items_booth FOREIGN KEY (booth_id) REFERENCES booths(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE booking_products (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  booking_item_id BIGINT UNSIGNED NOT NULL,
  product_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_booking_products_item (booking_item_id),
  CONSTRAINT fk_booking_products_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_booking_products_item FOREIGN KEY (booking_item_id) REFERENCES booking_items(id),
  CONSTRAINT fk_booking_products_product FOREIGN KEY (product_id) REFERENCES products(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE booking_accessories (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  booking_item_id BIGINT UNSIGNED NOT NULL,
  accessory_id BIGINT UNSIGNED NOT NULL,
  quantity INT NOT NULL DEFAULT 1,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_booking_accessories_item (booking_item_id),
  CONSTRAINT fk_booking_accessories_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_booking_accessories_item FOREIGN KEY (booking_item_id) REFERENCES booking_items(id),
  CONSTRAINT fk_booking_accessories_accessory FOREIGN KEY (accessory_id) REFERENCES accessories(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  public_id VARCHAR(40) NOT NULL,
  booking_id BIGINT UNSIGNED NULL,
  audit_check_id BIGINT UNSIGNED NULL,
  coupon_id BIGINT UNSIGNED NULL,
  provider ENUM('ksher','manual','mock') NOT NULL DEFAULT 'ksher',
  provider_reference VARCHAR(255) NULL,
  status ENUM('created','waiting','paid','failed','cancelled','refunded') NOT NULL DEFAULT 'created',
  amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  paid_at DATETIME NULL,
  raw_response_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_payments_public_id (public_id),
  KEY idx_payments_org_status (organization_id, status, created_at),
  CONSTRAINT fk_payments_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_payments_booking FOREIGN KEY (booking_id) REFERENCES bookings(id),
  CONSTRAINT fk_payments_coupon FOREIGN KEY (coupon_id) REFERENCES coupons(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_checks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  market_id BIGINT UNSIGNED NOT NULL,
  booking_item_id BIGINT UNSIGNED NOT NULL,
  checked_by_admin_id BIGINT UNSIGNED NOT NULL,
  result ENUM('pass','warning','failed') NOT NULL,
  note TEXT NULL,
  fine_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  accessories_fine_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  damage_fine_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  total_fine_amount DECIMAL(12,2) NOT NULL DEFAULT 0,
  fine_payment_status ENUM('none','pending','waiting','paid','cancelled') NOT NULL DEFAULT 'none',
  checked_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_checks_market (organization_id, market_id, checked_at),
  KEY idx_audit_checks_item (booking_item_id),
  CONSTRAINT fk_audit_checks_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_audit_checks_market FOREIGN KEY (market_id) REFERENCES markets(id),
  CONSTRAINT fk_audit_checks_item FOREIGN KEY (booking_item_id) REFERENCES booking_items(id),
  CONSTRAINT fk_audit_checks_admin FOREIGN KEY (checked_by_admin_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

ALTER TABLE payments
  ADD CONSTRAINT fk_payments_audit_check FOREIGN KEY (audit_check_id) REFERENCES audit_checks(id);

CREATE TABLE audit_check_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  audit_check_id BIGINT UNSIGNED NOT NULL,
  file_url TEXT NOT NULL,
  file_name VARCHAR(255) NULL,
  file_size INT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_check_images_check (audit_check_id),
  CONSTRAINT fk_audit_check_images_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_audit_check_images_check FOREIGN KEY (audit_check_id) REFERENCES audit_checks(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  mobile_user_id BIGINT UNSIGNED NULL,
  admin_user_id BIGINT UNSIGNED NULL,
  type VARCHAR(80) NOT NULL,
  title VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  is_read TINYINT(1) NOT NULL DEFAULT 0,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_notifications_mobile (organization_id, mobile_user_id, is_read, created_at),
  KEY idx_notifications_admin (organization_id, admin_user_id, is_read, created_at),
  CONSTRAINT fk_notifications_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_notifications_mobile_user FOREIGN KEY (mobile_user_id) REFERENCES mobile_users(id),
  CONSTRAINT fk_notifications_admin_user FOREIGN KEY (admin_user_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE payment_callbacks (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NULL,
  provider VARCHAR(80) NOT NULL,
  payload_json JSON NOT NULL,
  received_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_payment_callbacks_provider (provider, received_at),
  CONSTRAINT fk_payment_callbacks_org FOREIGN KEY (organization_id) REFERENCES organizations(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE audit_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  actor_admin_user_id BIGINT UNSIGNED NULL,
  actor_mobile_user_id BIGINT UNSIGNED NULL,
  action VARCHAR(120) NOT NULL,
  entity_type VARCHAR(120) NOT NULL,
  entity_id BIGINT UNSIGNED NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_audit_logs_entity (organization_id, entity_type, entity_id, created_at),
  CONSTRAINT fk_audit_logs_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_audit_logs_admin_user FOREIGN KEY (actor_admin_user_id) REFERENCES admin_users(id),
  CONSTRAINT fk_audit_logs_mobile_user FOREIGN KEY (actor_mobile_user_id) REFERENCES mobile_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
