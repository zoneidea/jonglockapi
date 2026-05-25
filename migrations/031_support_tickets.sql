CREATE TABLE IF NOT EXISTS support_tickets (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  tagged_organization_id BIGINT UNSIGNED NULL,
  created_by_admin_id BIGINT UNSIGNED NULL,
  category ENUM('issue','suggestion','inquiry') NOT NULL,
  topic VARCHAR(120) NOT NULL,
  priority ENUM('low','normal','high','urgent') NULL,
  subject VARCHAR(255) NOT NULL,
  message TEXT NOT NULL,
  status ENUM('open','in_progress','resolved','closed') NOT NULL DEFAULT 'open',
  related_event_log_id BIGINT UNSIGNED NULL,
  metadata_json JSON NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_support_tickets_org_status_created (organization_id, status, created_at),
  KEY idx_support_tickets_category_priority (category, priority, created_at),
  KEY idx_support_tickets_tagged_org (tagged_organization_id, created_at),
  CONSTRAINT fk_support_tickets_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_support_tickets_tagged_org FOREIGN KEY (tagged_organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_support_tickets_admin FOREIGN KEY (created_by_admin_id) REFERENCES admin_users(id),
  CONSTRAINT fk_support_tickets_event_log FOREIGN KEY (related_event_log_id) REFERENCES event_logs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_ticket_event_logs (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  support_ticket_id BIGINT UNSIGNED NOT NULL,
  event_log_id BIGINT UNSIGNED NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  UNIQUE KEY uq_support_ticket_event_log (support_ticket_id, event_log_id),
  KEY idx_support_ticket_event_logs_org (organization_id, created_at),
  CONSTRAINT fk_support_ticket_event_logs_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_support_ticket_event_logs_ticket FOREIGN KEY (support_ticket_id) REFERENCES support_tickets(id),
  CONSTRAINT fk_support_ticket_event_logs_event FOREIGN KEY (event_log_id) REFERENCES event_logs(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_ticket_messages (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  support_ticket_id BIGINT UNSIGNED NOT NULL,
  sender_type ENUM('management','platform','system') NOT NULL DEFAULT 'management',
  sender_admin_user_id BIGINT UNSIGNED NULL,
  message TEXT NOT NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_support_ticket_messages_ticket_created (support_ticket_id, id, created_at),
  KEY idx_support_ticket_messages_org_created (organization_id, created_at),
  CONSTRAINT fk_support_ticket_messages_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_support_ticket_messages_ticket FOREIGN KEY (support_ticket_id) REFERENCES support_tickets(id),
  CONSTRAINT fk_support_ticket_messages_admin FOREIGN KEY (sender_admin_user_id) REFERENCES admin_users(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;

CREATE TABLE IF NOT EXISTS support_ticket_attachments (
  id BIGINT UNSIGNED NOT NULL AUTO_INCREMENT,
  organization_id BIGINT UNSIGNED NOT NULL,
  support_ticket_id BIGINT UNSIGNED NOT NULL,
  support_ticket_message_id BIGINT UNSIGNED NULL,
  file_url VARCHAR(500) NOT NULL,
  file_name VARCHAR(255) NULL,
  file_size BIGINT UNSIGNED NULL,
  mime_type VARCHAR(120) NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (id),
  KEY idx_support_ticket_attachments_ticket (support_ticket_id, created_at),
  KEY idx_support_ticket_attachments_message (support_ticket_message_id, created_at),
  CONSTRAINT fk_support_ticket_attachments_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_support_ticket_attachments_ticket FOREIGN KEY (support_ticket_id) REFERENCES support_tickets(id),
  CONSTRAINT fk_support_ticket_attachments_message FOREIGN KEY (support_ticket_message_id) REFERENCES support_ticket_messages(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
