CREATE TABLE IF NOT EXISTS platform_users (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  username_hash CHAR(64) NOT NULL,
  password_hash VARCHAR(255) NOT NULL,
  role ENUM('platform_superadmin','platform_support','platform_billing','platform_ops','platform_audit') NOT NULL DEFAULT 'platform_superadmin',
  name_enc TEXT NOT NULL,
  email_enc TEXT NULL,
  email_hash CHAR(64) NULL,
  status ENUM('active','inactive','suspended','deleted') NOT NULL DEFAULT 'active',
  last_login_at DATETIME NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_users_username_hash (username_hash),
  UNIQUE KEY uq_platform_users_email_hash (email_hash),
  KEY idx_platform_users_role_status (role, status)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS platform_user_preferences (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  platform_user_id BIGINT UNSIGNED NOT NULL,
  preference_key VARCHAR(80) NOT NULL,
  preference_value JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_platform_user_preferences_key (platform_user_id, preference_key),
  CONSTRAINT fk_platform_user_preferences_user FOREIGN KEY (platform_user_id) REFERENCES platform_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
