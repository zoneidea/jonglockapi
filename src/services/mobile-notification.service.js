const { query, transaction } = require('../config/db');
const { logger } = require('../config/logger');
const { getFirebaseMessaging, getFirebaseInitReason } = require('./firebase-admin.service');

function stringData(data) {
  return Object.entries(data || {}).reduce((result, [key, value]) => {
    if (value !== undefined && value !== null) result[key] = String(value);
    return result;
  }, {});
}

async function sendMobilePushNotification(notificationId) {
  const messaging = getFirebaseMessaging();
  if (!messaging) {
    logger.warn({ notificationId, reason: getFirebaseInitReason() }, 'FCM push skipped');
    return { sent: 0, failed: 0, skipped: true };
  }

  const rows = await query(
    `SELECT mn.id, mn.organization_id, mn.mobile_user_id, mn.title, mn.body, mn.data_json,
            mdt.id AS token_id, mdt.fcm_token
     FROM mobile_notifications mn
     JOIN mobile_device_tokens mdt
       ON mdt.organization_id = mn.organization_id
      AND mdt.mobile_user_id = mn.mobile_user_id
      AND mdt.status = 'active'
     WHERE mn.id = :notificationId
     ORDER BY mdt.last_seen_at DESC, mdt.id DESC
     LIMIT 20`,
    { notificationId },
  );

  if (!rows.length) {
    await query(
      `UPDATE mobile_notifications
       SET channel = 'push',
           status = 'failed'
       WHERE id = :notificationId
         AND status IN ('unread', 'failed')`,
      { notificationId },
    );
    return { sent: 0, failed: 0, skipped: false };
  }

  const notification = rows[0];
  const tokens = rows.map((row) => row.fcm_token);
  const payload = {
    tokens,
    notification: {
      title: notification.title,
      body: notification.body,
    },
    data: stringData({
      notificationId: notification.id,
      organizationId: notification.organization_id,
      mobileUserId: notification.mobile_user_id,
      ...(typeof notification.data_json === 'string'
        ? JSON.parse(notification.data_json || '{}')
        : notification.data_json || {}),
    }),
    android: {
      priority: 'high',
      notification: {
        channelId: 'jonglock-default',
        sound: 'default',
      },
    },
    apns: {
      payload: {
        aps: {
          sound: 'default',
        },
      },
    },
  };

  const response = await messaging.sendEachForMulticast(payload);
  const invalidTokenIds = [];
  response.responses.forEach((item, index) => {
    const code = item.error?.code || '';
    if (
      code === 'messaging/registration-token-not-registered'
      || code === 'messaging/invalid-registration-token'
    ) {
      invalidTokenIds.push(rows[index].token_id);
    }
  });

  await transaction(async (conn) => {
    if (invalidTokenIds.length) {
      const placeholders = invalidTokenIds.map((_, index) => `:id${index}`).join(', ');
      const params = invalidTokenIds.reduce((values, id, index) => ({ ...values, [`id${index}`]: id }), {});
      await conn.execute(
        `UPDATE mobile_device_tokens
         SET status = 'inactive'
         WHERE id IN (${placeholders})`,
        params,
      );
    }
    await conn.execute(
      `UPDATE mobile_notifications
       SET channel = 'push',
           status = :status
       WHERE id = :notificationId`,
      {
        notificationId,
        status: response.successCount > 0 ? 'sent' : 'failed',
      },
    );
  });

  return { sent: response.successCount, failed: response.failureCount, skipped: false };
}

module.exports = {
  sendMobilePushNotification,
};
