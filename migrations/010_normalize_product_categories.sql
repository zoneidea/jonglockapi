INSERT INTO product_categories (organization_id, market_id, name, status)
SELECT m.organization_id, m.id, 'อาหาร', 'active'
FROM markets m
LEFT JOIN product_categories pc
  ON pc.organization_id = m.organization_id
 AND pc.market_id = m.id
 AND pc.name = 'อาหาร'
WHERE pc.id IS NULL;

INSERT INTO product_categories (organization_id, market_id, name, status)
SELECT m.organization_id, m.id, 'ไม่ใช่อาหาร', 'active'
FROM markets m
LEFT JOIN product_categories pc
  ON pc.organization_id = m.organization_id
 AND pc.market_id = m.id
 AND pc.name = 'ไม่ใช่อาหาร'
WHERE pc.id IS NULL;

UPDATE products p
JOIN product_categories current_category
  ON current_category.id = p.category_id
JOIN product_categories target_category
  ON target_category.organization_id = p.organization_id
 AND target_category.market_id = p.market_id
 AND target_category.name = CASE WHEN current_category.name = 'อาหาร' THEN 'อาหาร' ELSE 'ไม่ใช่อาหาร' END
SET p.category_id = target_category.id
WHERE current_category.name NOT IN ('อาหาร', 'ไม่ใช่อาหาร')
   OR current_category.market_id IS NULL
   OR current_category.market_id <> p.market_id;

UPDATE product_groups pg
JOIN product_categories current_category
  ON current_category.id = pg.category_id
JOIN product_categories target_category
  ON target_category.organization_id = pg.organization_id
 AND target_category.market_id = pg.market_id
 AND target_category.name = CASE WHEN current_category.name = 'อาหาร' THEN 'อาหาร' ELSE 'ไม่ใช่อาหาร' END
SET pg.category_id = target_category.id
WHERE current_category.name NOT IN ('อาหาร', 'ไม่ใช่อาหาร')
   OR current_category.market_id IS NULL
   OR current_category.market_id <> pg.market_id;

UPDATE booths b
JOIN product_categories current_category
  ON current_category.id = b.category_id
JOIN product_categories target_category
  ON target_category.organization_id = b.organization_id
 AND target_category.market_id = b.market_id
 AND target_category.name = CASE WHEN current_category.name = 'อาหาร' THEN 'อาหาร' ELSE 'ไม่ใช่อาหาร' END
SET b.category_id = target_category.id
WHERE current_category.name NOT IN ('อาหาร', 'ไม่ใช่อาหาร')
   OR current_category.market_id IS NULL
   OR current_category.market_id <> b.market_id;

UPDATE product_categories pc
JOIN (
  SELECT organization_id, market_id, name, MIN(id) AS keep_id
  FROM product_categories
  WHERE name IN ('อาหาร', 'ไม่ใช่อาหาร')
  GROUP BY organization_id, market_id, name
) canonical
  ON canonical.organization_id = pc.organization_id
 AND canonical.market_id = pc.market_id
 AND canonical.name = pc.name
SET pc.status = CASE WHEN pc.id = canonical.keep_id THEN 'active' ELSE 'inactive' END
WHERE pc.name IN ('อาหาร', 'ไม่ใช่อาหาร');

UPDATE products p
JOIN product_categories current_category
  ON current_category.id = p.category_id
JOIN (
  SELECT organization_id, market_id, name, MIN(id) AS keep_id
  FROM product_categories
  WHERE name IN ('อาหาร', 'ไม่ใช่อาหาร')
  GROUP BY organization_id, market_id, name
) canonical
  ON canonical.organization_id = current_category.organization_id
 AND canonical.market_id = current_category.market_id
 AND canonical.name = current_category.name
SET p.category_id = canonical.keep_id
WHERE p.category_id <> canonical.keep_id;

UPDATE product_groups pg
JOIN product_categories current_category
  ON current_category.id = pg.category_id
JOIN (
  SELECT organization_id, market_id, name, MIN(id) AS keep_id
  FROM product_categories
  WHERE name IN ('อาหาร', 'ไม่ใช่อาหาร')
  GROUP BY organization_id, market_id, name
) canonical
  ON canonical.organization_id = current_category.organization_id
 AND canonical.market_id = current_category.market_id
 AND canonical.name = current_category.name
SET pg.category_id = canonical.keep_id
WHERE pg.category_id <> canonical.keep_id;

UPDATE booths b
JOIN product_categories current_category
  ON current_category.id = b.category_id
JOIN (
  SELECT organization_id, market_id, name, MIN(id) AS keep_id
  FROM product_categories
  WHERE name IN ('อาหาร', 'ไม่ใช่อาหาร')
  GROUP BY organization_id, market_id, name
) canonical
  ON canonical.organization_id = current_category.organization_id
 AND canonical.market_id = current_category.market_id
 AND canonical.name = current_category.name
SET b.category_id = canonical.keep_id
WHERE b.category_id <> canonical.keep_id;

UPDATE product_categories
SET status = 'inactive'
WHERE name NOT IN ('อาหาร', 'ไม่ใช่อาหาร');
