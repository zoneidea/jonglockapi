UPDATE mobile_users mu
JOIN tenant_types current_type
  ON current_type.id = mu.tenant_type_id
JOIN (
  SELECT organization_id, name, MIN(id) AS keep_id
  FROM tenant_types
  GROUP BY organization_id, name
) canonical_type
  ON canonical_type.organization_id = current_type.organization_id
 AND canonical_type.name = current_type.name
SET mu.tenant_type_id = canonical_type.keep_id
WHERE mu.tenant_type_id <> canonical_type.keep_id;

DELETE duplicate_type
FROM tenant_types duplicate_type
JOIN tenant_types canonical_type
  ON duplicate_type.organization_id = canonical_type.organization_id
 AND duplicate_type.name = canonical_type.name
 AND duplicate_type.id > canonical_type.id;
