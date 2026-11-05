ALTER TABLE markets
  ADD COLUMN collection_mode ENUM('self', 'system') NOT NULL DEFAULT 'system';
