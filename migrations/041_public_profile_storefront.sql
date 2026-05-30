ALTER TABLE public_user_profiles
  ADD COLUMN store_name_enc TEXT NULL AFTER avatar_url,
  ADD COLUMN store_logo_url VARCHAR(1024) NULL AFTER store_name_enc,
  ADD COLUMN store_product_desc_enc TEXT NULL AFTER store_logo_url,
  ADD COLUMN store_facebook_url VARCHAR(1024) NULL AFTER store_product_desc_enc,
  ADD COLUMN store_line_id VARCHAR(191) NULL AFTER store_facebook_url,
  ADD COLUMN store_website_url VARCHAR(1024) NULL AFTER store_line_id,
  ADD COLUMN store_contact_phone_enc TEXT NULL AFTER store_website_url,
  ADD COLUMN store_gallery_json LONGTEXT NULL AFTER store_contact_phone_enc;
