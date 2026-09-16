const { notFound, conflict } = require('../utils/errors');

async function lockMarket(connection, { organizationId, marketId }) {
  const [rows] = await connection.execute(
    `SELECT id, status, deleted_at FROM markets
     WHERE organization_id = :organizationId AND id = :marketId FOR UPDATE`,
    { organizationId, marketId },
  );
  if (!rows[0] || rows[0].deleted_at) throw notFound('ไม่พบตลาด หรือตลาดถูกลบแล้ว');
  return rows[0];
}

async function updateMarketBasics(connection, scope, changes) {
  await lockMarket(connection, scope);
  await connection.execute(
    `UPDATE markets SET name = :name, status = :status
     WHERE organization_id = :organizationId AND id = :marketId AND deleted_at IS NULL`,
    { ...scope, name: changes.name, status: changes.status },
  );
  return { id: scope.marketId, name: changes.name, status: changes.status };
}

async function softDeleteMarket(connection, scope) {
  await lockMarket(connection, scope);
  // Lock booking rows before checking payment history. Creation paths lock the
  // same market row, so a booking cannot slip between this check and deletion.
  const [bookings] = await connection.execute(
    `SELECT id, status, paid_at FROM bookings
     WHERE organization_id = :organizationId AND market_id = :marketId FOR UPDATE`, scope,
  );
  if (bookings.some((booking) => booking.paid_at || ['paid', 'refunded'].includes(booking.status))) {
    throw conflict('ลบตลาดไม่ได้ เนื่องจากมีประวัติการจองที่ชำระเงินแล้ว');
  }
  const [payments] = await connection.execute(
    `SELECT p.id FROM payments p
     JOIN bookings b ON b.id = p.booking_id AND b.organization_id = p.organization_id
     WHERE p.organization_id = :organizationId AND b.market_id = :marketId
       AND (p.paid_at IS NOT NULL OR p.status IN ('paid', 'refunded', 'created', 'waiting'))
     LIMIT 1 FOR UPDATE`, scope,
  );
  const [paidItems] = await connection.execute(
    `SELECT bi.id FROM booking_items bi
     JOIN bookings b ON b.id = bi.booking_id AND b.organization_id = bi.organization_id
     WHERE bi.organization_id = :organizationId AND b.market_id = :marketId
       AND bi.status = 'paid' LIMIT 1 FOR UPDATE`, scope,
  );
  if (payments.length || paidItems.length) throw conflict('ลบตลาดไม่ได้ มีประวัติชำระเงินหรือธุรกรรมที่ยังดำเนินการอยู่');
  if (bookings.some((booking) => ['draft', 'pending_payment', 'payment_processing'].includes(booking.status))) {
    throw conflict('ลบตลาดไม่ได้ มีรายการจองที่ยังไม่สิ้นสุด กรุณายกเลิกหรือรอให้รายการหมดอายุก่อน');
  }
  await connection.execute(
    `UPDATE markets SET status = 'inactive', deleted_at = CURRENT_TIMESTAMP
     WHERE organization_id = :organizationId AND id = :marketId AND deleted_at IS NULL`, scope,
  );
  return { id: scope.marketId, deleted: true };
}

module.exports = { updateMarketBasics, softDeleteMarket };
