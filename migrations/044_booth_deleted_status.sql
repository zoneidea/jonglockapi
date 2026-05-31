ALTER TABLE booths
  MODIFY status ENUM('active','inactive','maintenance','deleted') NOT NULL DEFAULT 'active';
