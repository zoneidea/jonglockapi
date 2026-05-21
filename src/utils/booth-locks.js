const { conflict } = require('./errors');

function lockStatusForBookingStatus(status) {
  if (status === 'paid') return 'paid';
  if (status === 'payment_processing') return 'processing';
  return 'held';
}

function isDuplicateKeyError(error) {
  return error?.code === 'ER_DUP_ENTRY' || error?.errno === 1062;
}

async function insertBoothDateLock(conn, {
  organizationId,
  marketId,
  floorPlanId,
  boothId,
  bookingId,
  bookingItemId = null,
  bookingDate,
  status = 'held',
  expiresAt = null,
}) {
  try {
    const [result] = await conn.execute(
      `INSERT INTO booth_date_locks (
        organization_id, market_id, floor_plan_id, booth_id, booking_id, booking_item_id,
        booking_date, status, expires_at
      ) VALUES (
        :organizationId, :marketId, :floorPlanId, :boothId, :bookingId, :bookingItemId,
        :bookingDate, :status, :expiresAt
      )`,
      {
        organizationId,
        marketId,
        floorPlanId,
        boothId,
        bookingId,
        bookingItemId,
        bookingDate,
        status,
        expiresAt,
      },
    );
    return result.insertId;
  } catch (error) {
    if (isDuplicateKeyError(error)) {
      throw conflict(`Booth ${boothId} has already been booked on ${bookingDate}`);
    }
    throw error;
  }
}

async function attachBookingItemToLock(conn, { organizationId, bookingId, boothId, bookingDate, bookingItemId }) {
  await conn.execute(
    `UPDATE booth_date_locks
     SET booking_item_id = :bookingItemId
     WHERE organization_id = :organizationId
       AND booking_id = :bookingId
       AND booth_id = :boothId
       AND booking_date = :bookingDate`,
    { organizationId, bookingId, boothId, bookingDate, bookingItemId },
  );
}

async function updateBookingLocksStatus(conn, { organizationId, bookingId, status }) {
  await conn.execute(
    `UPDATE booth_date_locks
     SET status = :status
     WHERE organization_id = :organizationId AND booking_id = :bookingId`,
    { organizationId, bookingId, status: lockStatusForBookingStatus(status) },
  );
}

async function releaseBookingLocks(conn, { organizationId, bookingId }) {
  await conn.execute(
    `DELETE FROM booth_date_locks
     WHERE organization_id = :organizationId AND booking_id = :bookingId`,
    { organizationId, bookingId },
  );
}

async function moveBookingItemLock(conn, {
  organizationId,
  marketId,
  floorPlanId,
  bookingId,
  bookingItemId,
  oldBoothId,
  oldBookingDate,
  newBoothId,
  newBookingDate,
  status = 'paid',
}) {
  await conn.execute(
    `DELETE FROM booth_date_locks
     WHERE organization_id = :organizationId
       AND booking_item_id = :bookingItemId
       AND booth_id = :oldBoothId
       AND booking_date = :oldBookingDate`,
    { organizationId, bookingItemId, oldBoothId, oldBookingDate },
  );

  await insertBoothDateLock(conn, {
    organizationId,
    marketId,
    floorPlanId,
    boothId: newBoothId,
    bookingId,
    bookingItemId,
    bookingDate: newBookingDate,
    status: lockStatusForBookingStatus(status),
  });
}

module.exports = {
  attachBookingItemToLock,
  insertBoothDateLock,
  lockStatusForBookingStatus,
  moveBookingItemLock,
  releaseBookingLocks,
  updateBookingLocksStatus,
};

