const test = require('node:test');
const assert = require('node:assert/strict');
function stub(path, exports) {
  const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports };
}
let notification; let pending = true; let leased = false; let sends = 0; let failPush = false;
const scope = { organizationId: 7, attemptId: 8 };
const attempt = { id: 8, organization_id: 7, mobile_user_id: 9, public_id: 'RPA8' };
stub('../src/config/db', { query: async (sql, p) => {
  assert.equal(p.organizationId, scope.organizationId); assert.equal(p.attemptId, scope.attemptId);
  if (sql.includes('SET lease_until')) { if (!pending || leased) return { affectedRows: 0 }; leased = true; return { affectedRows: 1 }; }
  if (sql.startsWith('SELECT notification_id')) return [{ notification_id: 101 }];
  if (sql.includes('SET delivered_at')) { pending = false; return { affectedRows: 1 }; }
  throw new Error(`Unexpected operation ${sql}`);
} });
stub('../src/services/mobile-notification.service', { sendMobilePushNotification: async id => {
  assert.equal(id, 101); sends += 1;
  if (failPush) throw new Error('FCM temporarily unavailable');
  return { sent: 1, failed: 0 };
} });
stub('../src/services/payment-activity.service', { activity: async () => {} });
const { enqueue, deliver } = require('../src/services/payment-status-notification.service');
const conn = { execute: async (sql, p) => {
  if (sql.startsWith('SELECT notification_id')) return [notification ? [{ notification_id: 101 }] : []];
  if (sql.startsWith('INSERT INTO mobile_notifications')) { notification = p; return [{ insertId: 101 }]; }
  if (sql.startsWith('INSERT INTO payment_status_notifications')) return [{ affectedRows: 1 }];
  throw new Error(`Unexpected operation ${sql}`);
} };
test('terminal payment creates one durable notification with only metadata, then dispatches once', async () => {
  assert.equal(await enqueue(conn, attempt, 'pending'), null);
  assert.equal(await enqueue(conn, attempt, 'paid'), 101);
  assert.equal(await enqueue(conn, attempt, 'paid'), 101);
  assert.deepEqual(JSON.parse(notification.data), { type: 'payment_status', route: 'cart', attemptId: 'RPA8', paymentStatus: 'paid' });
  await deliver(7, 8); await deliver(7, 8);
  assert.equal(sends, 1); assert.equal(pending, false);
});
test('push failure keeps the committed notification available for retry', async () => {
  pending = true; leased = false; failPush = true;
  await deliver(7, 8); assert.equal(pending, true);
  // Simulate the lease expiring before the recovery job retries.
  leased = false; failPush = false;
  await deliver(7, 8); assert.equal(pending, false);
});
