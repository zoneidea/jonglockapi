CREATE TABLE IF NOT EXISTS audit_collection_requests (
  organization_id BIGINT UNSIGNED NOT NULL,
  actor_id BIGINT UNSIGNED NOT NULL,
  request_key VARCHAR(160) NOT NULL,
  state ENUM('open','completed','cancelled') NOT NULL DEFAULT 'open',
  request_hash CHAR(64) NULL,
  collection_id BIGINT UNSIGNED NULL,
  created_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (organization_id, actor_id, request_key),
  CONSTRAINT fk_audit_request_org FOREIGN KEY (organization_id) REFERENCES organizations(id),
  CONSTRAINT fk_audit_request_collection FOREIGN KEY (collection_id) REFERENCES audit_collections(id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci;
