SET @tenant_types_org_fk := (
  SELECT CONSTRAINT_NAME
  FROM information_schema.KEY_COLUMN_USAGE
  WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME = 'tenant_types'
    AND COLUMN_NAME = 'organization_id'
    AND REFERENCED_TABLE_NAME = 'organizations'
  LIMIT 1
);

SET @drop_tenant_types_org_fk := IF(
  @tenant_types_org_fk IS NULL,
  'SELECT 1',
  CONCAT('ALTER TABLE tenant_types DROP FOREIGN KEY ', @tenant_types_org_fk)
);

PREPARE drop_tenant_types_org_fk_stmt FROM @drop_tenant_types_org_fk;
EXECUTE drop_tenant_types_org_fk_stmt;
DEALLOCATE PREPARE drop_tenant_types_org_fk_stmt;

ALTER TABLE tenant_types
  MODIFY organization_id BIGINT UNSIGNED NULL;

INSERT INTO tenant_types (organization_id, name, status)
SELECT NULL, 'บุคคลธรรมดา', 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_types WHERE name = 'บุคคลธรรมดา'
);

INSERT INTO tenant_types (organization_id, name, status)
SELECT NULL, 'นิติบุคคล', 'active'
WHERE NOT EXISTS (
  SELECT 1 FROM tenant_types WHERE name = 'นิติบุคคล'
);

UPDATE mobile_users mu
LEFT JOIN tenant_types current_type
  ON current_type.id = mu.tenant_type_id
JOIN (
  SELECT MIN(id) AS keep_id
  FROM tenant_types
  WHERE name = 'บุคคลธรรมดา'
) fallback_type
SET mu.tenant_type_id = fallback_type.keep_id
WHERE mu.tenant_type_id IS NULL
   OR current_type.id IS NULL
   OR current_type.name NOT IN ('บุคคลธรรมดา', 'นิติบุคคล');

UPDATE mobile_users mu
JOIN tenant_types current_type
  ON current_type.id = mu.tenant_type_id
JOIN (
  SELECT name, MIN(id) AS keep_id
  FROM tenant_types
  WHERE name IN ('บุคคลธรรมดา', 'นิติบุคคล')
  GROUP BY name
) canonical_type
  ON canonical_type.name = current_type.name
SET mu.tenant_type_id = canonical_type.keep_id
WHERE mu.tenant_type_id <> canonical_type.keep_id;

DELETE duplicate_type
FROM tenant_types duplicate_type
JOIN (
  SELECT name, MIN(id) AS keep_id
  FROM tenant_types
  GROUP BY name
) canonical_type
  ON canonical_type.name = duplicate_type.name
 AND canonical_type.keep_id <> duplicate_type.id;

UPDATE tenant_types
SET organization_id = NULL,
    status = CASE
      WHEN name IN ('บุคคลธรรมดา', 'นิติบุคคล') THEN 'active'
      ELSE 'inactive'
    END;

ALTER TABLE tenant_types
  ADD UNIQUE KEY uq_tenant_types_name (name),
  ADD KEY idx_tenant_types_status_name (status, name);
