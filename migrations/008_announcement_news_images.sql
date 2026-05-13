ALTER TABLE announcement_items
  MODIFY COLUMN description MEDIUMTEXT NULL;

CREATE TABLE announcement_item_images (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  announcement_item_id BIGINT UNSIGNED NOT NULL,
  image_url TEXT NOT NULL,
  sort_order INT NOT NULL DEFAULT 0,
  is_cover TINYINT(1) NOT NULL DEFAULT 0,
  status ENUM('active','inactive') NOT NULL DEFAULT 'active',
  created_by_admin_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_announcement_item_images_scope (organization_id, announcement_item_id, status, sort_order),
  CONSTRAINT fk_announcement_item_images_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_announcement_item_images_item FOREIGN KEY (announcement_item_id) REFERENCES announcement_items(id),
  CONSTRAINT fk_announcement_item_images_admin FOREIGN KEY (created_by_admin_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
