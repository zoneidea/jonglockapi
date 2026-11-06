const { query } = require('../config/db');
const types = new Set(['booth','entrance','exit','toilet','tree','rest_area','stage','parking','walkway','road','text','custom']);

async function getPublishedMarketLayout(marketId, floorPlanId) {
  const rows = await query(`SELECT ml.id, ml.market_id, ml.organization_id, ml.floor_plan_id,
      ml.name, ml.rows_count, ml.columns_count, ml.layout_json, ml.updated_at
    FROM market_layouts ml
    JOIN markets m ON m.id = ml.market_id AND m.organization_id = ml.organization_id
    JOIN organizations o ON o.id = m.organization_id
    JOIN floor_plans fp ON fp.id = ml.floor_plan_id AND fp.market_id = ml.market_id AND fp.organization_id = ml.organization_id
    WHERE ml.market_id = :marketId AND ml.floor_plan_id = :floorPlanId
      AND ml.is_active = 1 AND ml.status = 'published' AND fp.status = 'active'
      AND m.status = 'active' AND m.deleted_at IS NULL AND m.collection_mode = 'system'
      AND o.status = 'active'
    ORDER BY ml.updated_at DESC, ml.id DESC LIMIT 1`, {marketId, floorPlanId});
  const row = rows[0];
  if (!row) return null;
  let json;
  try { json = typeof row.layout_json === 'string' ? JSON.parse(row.layout_json) : row.layout_json; } catch { return null; }
  const height = Number(row.rows_count), width = Number(row.columns_count);
  if (!Number.isInteger(height) || height < 1 || height > 200 || !Number.isInteger(width) || width < 1 || width > 200 || !Array.isArray(json?.items)) return null;
  const booths = await query(`SELECT id, code FROM booths WHERE organization_id = :organizationId
    AND market_id = :marketId AND floor_plan_id = :floorPlanId AND status = 'active'`,
  {organizationId:row.organization_id,marketId,floorPlanId});
  const boothMap = new Map(booths.map(b => [Number(b.id), b]));
  const items = [];
  const usedIds = new Set();
  for (const raw of json.items) {
    if (!raw || !types.has(raw.type) || !raw.id || usedIds.has(String(raw.id))) continue;
    const r=Number(raw.row), c=Number(raw.col), rowSpan=Number(raw.rowSpan || 1), colSpan=Number(raw.colSpan || 1);
    if (![r,c,rowSpan,colSpan].every(n => Number.isInteger(n) && n >= 1) || r + rowSpan - 1 > height || c + colSpan - 1 > width) continue;
    const booth = raw.type === 'booth' ? boothMap.get(Number(raw.boothId)) : null;
    if (raw.type === 'booth' && !booth) continue;
    usedIds.add(String(raw.id));
    items.push({id:String(raw.id),type:raw.type,label:String(booth?.code || raw.label || '').slice(0,120),
      row:r,col:c,rowSpan,colSpan,...(booth ? {boothId:Number(booth.id)} : {})});
  }
  return {id:Number(row.id),marketId:Number(row.market_id),floorPlanId:Number(row.floor_plan_id),
    name:row.name,rowsCount:height,columnsCount:width,updatedAt:row.updated_at,items};
}
module.exports = { getPublishedMarketLayout };
