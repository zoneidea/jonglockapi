const { notFound, conflict } = require('../utils/errors');

// Called inside transaction() so the batch is committed only after every check passes.
async function deleteBooths(connection, { organizationId, marketId, boothIds }) {
  const ids = [...new Set(boothIds)].sort((a, b) => a - b);
  const params = { organizationId, marketId };
  const placeholders = ids.map((id, index) => {
    params[`boothId${index}`] = id;
    return `:boothId${index}`;
  }).join(', ');
  const [booths] = await connection.execute(
    `SELECT id, status FROM booths
     WHERE organization_id = :organizationId AND market_id = :marketId
       AND id IN (${placeholders})
     ORDER BY id FOR UPDATE`, params,
  );
  if (booths.length !== ids.length) throw notFound('One or more booths not found for this market');

  const [blockers] = await connection.execute(
    `SELECT bo.id FROM booths bo
     WHERE bo.organization_id = :organizationId AND bo.market_id = :marketId
       AND bo.id IN (${placeholders}) AND bo.status <> 'deleted'
       AND (
         EXISTS (
           SELECT 1 FROM booking_items bi
           JOIN bookings bk ON bk.id = bi.booking_id AND bk.organization_id = bi.organization_id
           WHERE bi.organization_id = :organizationId AND bi.booth_id = bo.id
             AND bi.status IN ('pending_payment', 'payment_processing', 'paid')
             AND bk.status IN ('pending_payment', 'payment_processing', 'paid')
         ) OR EXISTS (
           SELECT 1 FROM booth_date_locks bdl
           WHERE bdl.organization_id = :organizationId AND bdl.booth_id = bo.id
             AND bdl.status IN ('held', 'processing', 'paid')
         )
       ) LIMIT 1`, params,
  );
  if (blockers.length) throw conflict('Booths cannot be deleted because one or more have paid or in-progress bookings');

  const [result] = await connection.execute(
    `UPDATE booths SET status = 'deleted'
     WHERE organization_id = :organizationId AND market_id = :marketId
       AND id IN (${placeholders}) AND status <> 'deleted'`, params,
  );
  return { boothIds: ids, deletedCount: result.affectedRows, status: 'deleted' };
}

module.exports = { deleteBooths };
