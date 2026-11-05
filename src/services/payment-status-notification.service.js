const { query } = require('../config/db');
const { sendMobilePushNotification } = require('./mobile-notification.service');
const { activity } = require('./payment-activity.service');
const messages = {
  paid: ['ชำระเงินสำเร็จ', 'ระบบได้รับการชำระเงินแล้ว ตรวจสอบรายการจองได้ในแอปฯ'],
  failed: ['ชำระเงินไม่สำเร็จ', 'กรุณาเลือกช่องทางและลองชำระเงินใหม่'],
  expired: ['รายการชำระเงินหมดอายุ', 'กรุณาตรวจสอบรายการจองก่อนชำระเงินใหม่'],
  cancelled: ['รายการชำระเงินถูกยกเลิก', 'ตรวจสอบสถานะรายการจองได้ในแอปฯ'],
};
async function enqueue(conn, attempt, state) {
  if (!messages[state]) return null;
  const [existing] = await conn.execute(`SELECT notification_id FROM payment_status_notifications
    WHERE organization_id = :organizationId AND payment_attempt_id = :attemptId`,
  { organizationId: attempt.organization_id, attemptId: attempt.id });
  if (existing[0]) return existing[0].notification_id;
  const [title, body] = messages[state];
  const [result] = await conn.execute(`INSERT INTO mobile_notifications
    (organization_id, mobile_user_id, title, body, data_json) VALUES (:organizationId, :userId, :title, :body, :data)`,
  { organizationId: attempt.organization_id, userId: attempt.mobile_user_id, title, body,
    data: JSON.stringify({ type: 'payment_status', route: 'cart', attemptId: attempt.public_id, paymentStatus: state }) });
  await conn.execute(`INSERT INTO payment_status_notifications (organization_id, payment_attempt_id, notification_id)
    VALUES (:organizationId, :attemptId, :notificationId)`,
  { organizationId: attempt.organization_id, attemptId: attempt.id, notificationId: result.insertId });
  return result.insertId;
}
async function deliver(organizationId, attemptId) {
  const scope = { organizationId, attemptId };
  const claim = await query(`UPDATE payment_status_notifications SET lease_until = DATE_ADD(NOW(), INTERVAL 60 SECOND)
    WHERE organization_id = :organizationId AND payment_attempt_id = :attemptId AND delivered_at IS NULL
    AND (lease_until IS NULL OR lease_until < NOW())`, scope);
  if (!claim.affectedRows) return;
  try {
    const rows = await query(`SELECT notification_id FROM payment_status_notifications
      WHERE organization_id = :organizationId AND payment_attempt_id = :attemptId`, scope);
    const result = await sendMobilePushNotification(rows[0].notification_id);
    if (result.sent > 0) {
      await query(`UPDATE payment_status_notifications SET delivered_at = NOW(), lease_until = NULL
        WHERE organization_id = :organizationId AND payment_attempt_id = :attemptId`, scope);
    }
    await activity('reservepay_status_notification', { organizationId, code: result.sent > 0 ? 'SENT' : 'RETRY' });
  } catch (_error) {
    // Durable outbox stays retryable. A push failure must never roll back a payment.
    await activity('reservepay_status_notification', { organizationId, code: 'RETRY', status: 202 }).catch(() => {});
  }
}
async function flush(limit = 20) {
  const rows = await query(`SELECT organization_id, payment_attempt_id FROM payment_status_notifications
    WHERE delivered_at IS NULL AND (lease_until IS NULL OR lease_until < NOW()) ORDER BY notification_id LIMIT :limit`, { limit });
  for (const row of rows) await deliver(row.organization_id, row.payment_attempt_id);
}
module.exports = { enqueue, deliver, flush };
