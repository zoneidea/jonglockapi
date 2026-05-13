ALTER TABLE markets
  ADD COLUMN main_image_url TEXT NULL AFTER description;

ALTER TABLE accessories
  ADD COLUMN image_url TEXT NULL AFTER name;
