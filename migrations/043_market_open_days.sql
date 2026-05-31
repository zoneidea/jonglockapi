ALTER TABLE markets
  ADD COLUMN open_days_json JSON NULL AFTER opening_hours;

UPDATE markets
SET open_days_json = JSON_ARRAY('sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat')
WHERE open_days_json IS NULL;
