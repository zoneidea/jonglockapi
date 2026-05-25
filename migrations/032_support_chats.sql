CREATE TABLE IF NOT EXISTS support_chats (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  subject VARCHAR(255) NOT NULL DEFAULT 'สอบถามทั่วไป',
  status ENUM('open','closed') NOT NULL DEFAULT 'open',
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_support_chats_org_status_updated (organization_id, status, updated_at),
  CONSTRAINT fk_support_chats_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_support_chats_admin FOREIGN KEY (created_by_admin_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_chat_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  support_chat_id BIGINT UNSIGNED NOT NULL,
  sender_type ENUM('management','platform','system') NOT NULL DEFAULT 'management',
  sender_admin_user_id BIGINT UNSIGNED NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_support_chat_messages_chat_created (support_chat_id, id, created_at),
  KEY idx_support_chat_messages_org_created (organization_id, created_at),
  CONSTRAINT fk_support_chat_messages_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_support_chat_messages_chat FOREIGN KEY (support_chat_id) REFERENCES support_chats(id),
  CONSTRAINT fk_support_chat_messages_admin FOREIGN KEY (sender_admin_user_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_chat_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  support_chat_id BIGINT UNSIGNED NOT NULL,
  support_chat_message_id BIGINT UNSIGNED NULL,
  file_url VARCHAR(500) NOT NULL,
  file_name VARCHAR(255) NULL,
  file_size BIGINT UNSIGNED NULL,
  mime_type VARCHAR(120) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_support_chat_attachments_chat (support_chat_id, created_at),
  KEY idx_support_chat_attachments_message (support_chat_message_id, created_at),
  CONSTRAINT fk_support_chat_attachments_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_support_chat_attachments_chat FOREIGN KEY (support_chat_id) REFERENCES support_chats(id),
  CONSTRAINT fk_support_chat_attachments_message FOREIGN KEY (support_chat_message_id) REFERENCES support_chat_messages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
