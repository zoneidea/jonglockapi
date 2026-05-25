CREATE TABLE IF NOT EXISTS mobile_notifications (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  mobile_user_id BIGINT UNSIGNED NOT NULL,
  title VARCHAR(255) NOT NULL,
  body TEXT NOT NULL,
  data_json JSON NULL,
  channel ENUM('in_app','push') NOT NULL DEFAULT 'in_app',
  status ENUM('unread','read','sent','failed') NOT NULL DEFAULT 'unread',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  read_at DATETIME NULL,
  PRIMARY KEY (id),
  KEY idx_mobile_notifications_user_status (organization_id, mobile_user_id, status, created_at),
  CONSTRAINT fk_mobile_notifications_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_mobile_notifications_user FOREIGN KEY (mobile_user_id) REFERENCES mobile_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
