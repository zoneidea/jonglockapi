INSERT INTO tenant_types (organization_id, name, status)
SELECT o.id, 'บุคคลธรรมดา', 'active'
FROM organizations o
LEFT JOIN tenant_types tt
  ON tt.organization_id = o.id
 AND tt.name = 'บุคคลธรรมดา'
WHERE tt.id IS NULL;

INSERT INTO tenant_types (organization_id, name, status)
SELECT o.id, 'นิติบุคคล', 'active'
FROM organizations o
LEFT JOIN tenant_types tt
  ON tt.organization_id = o.id
 AND tt.name = 'นิติบุคคล'
WHERE tt.id IS NULL;

UPDATE mobile_users mu
JOIN tenant_types current_type
  ON current_type.id = mu.tenant_type_id
JOIN tenant_types fallback_type
  ON fallback_type.organization_id = mu.organization_id
 AND fallback_type.name = 'บุคคลธรรมดา'
SET mu.tenant_type_id = fallback_type.id
WHERE current_type.name NOT IN ('บุคคลธรรมดา', 'นิติบุคคล');

UPDATE tenant_types
SET status = 'active'
WHERE name IN ('บุคคลธรรมดา', 'นิติบุคคล');

UPDATE tenant_types
SET status = 'inactive'
WHERE name NOT IN ('บุคคลธรรมดา', 'นิติบุคคล');
