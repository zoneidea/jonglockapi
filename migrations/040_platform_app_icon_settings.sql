CREATE TABLE IF NOT EXISTS platform_app_icon_settings (
  id TINYINT UNSIGNED NOT NULL PRIMARY KEY,
  active_icon_key VARCHAR(50) NOT NULL DEFAULT 'default',
  updated_by_platform_user_id BIGINT UNSIGNED NULL,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  metadata_json JSON NULL,
  CONSTRAINT fk_platform_app_icon_settings_user
    FOREIGN KEY (updated_by_platform_user_id) REFERENCES platform_users(id)
    ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

INSERT INTO platform_app_icon_settings (id, active_icon_key, metadata_json)
VALUES (1, 'default', JSON_OBJECT('source', 'migration'))
ON DUPLICATE KEY UPDATE id = id;
