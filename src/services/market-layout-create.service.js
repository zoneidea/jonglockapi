const { badRequest, conflict, notFound } = require('../utils/errors');

async function createMarketLayout(connection, scope, body, layoutJson) {
  // Serialize creates per market so two requests cannot reserve the same floor plan.
  const [markets] = await connection.execute(`SELECT id FROM markets
    WHERE id = :marketId AND organization_id = :organizationId AND deleted_at IS NULL FOR UPDATE`, scope);
  if (!markets.length) throw notFound('Market not found');
  let floorPlanName = '';
  if (body.floorPlanId) {
    const params = { ...scope, floorPlanId: body.floorPlanId };
    const [plans] = await connection.execute(`SELECT id, name FROM floor_plans
      WHERE id = :floorPlanId AND organization_id = :organizationId AND market_id = :marketId
      LIMIT 1 FOR UPDATE`, params);
    if (!plans.length) throw badRequest('Floor plan not found for this market');
    const [existing] = await connection.execute(`SELECT id FROM market_layouts
      WHERE organization_id = :organizationId AND market_id = :marketId
        AND floor_plan_id = :floorPlanId AND is_active = 1 LIMIT 1 FOR UPDATE`, params);
    if (existing.length) throw conflict('แผนผังบูธนี้มี Visual Plan อยู่แล้ว กรุณาแก้ไขรายการเดิมหรือลบก่อนสร้างใหม่');
    floorPlanName = plans[0].name || '';
  }
  const [result] = await connection.execute(`INSERT INTO market_layouts (
    organization_id, market_id, floor_plan_id, name, description, rows_count, columns_count, cell_size,
    layout_json, status, is_active, created_by, updated_by
  ) VALUES (:organizationId, :marketId, :floorPlanId, :name, :description, :rowsCount, :columnsCount,
    :cellSize, :layoutJson, 'draft', 1, :adminUserId, :adminUserId)`, {
    ...scope, floorPlanId: body.floorPlanId || null, name: body.name.trim(), description: body.description || '',
    rowsCount: body.rowsCount, columnsCount: body.columnsCount, cellSize: body.cellSize,
    layoutJson: JSON.stringify(layoutJson),
  });
  return { insertId: result.insertId, floorPlanName };
}
module.exports = { createMarketLayout };
