const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');
const { query } = require('../config/db');

// Payment logs accept metadata only. Never pass request bodies or provider errors here.
const directory = path.resolve(__dirname, '../../logs');
let paymentLogger;
function fileLogger() {
  if (!paymentLogger) {
    fs.mkdirSync(directory, { recursive: true, mode: 0o700 });
    paymentLogger = pino(pino.destination({ dest: path.join(directory, 'payments.log'), sync: true, mode: 0o600 }));
  }
  return paymentLogger;
}

async function activity(action, { organizationId = null, attemptId = null, eventId = null, code = null, status = 200, durationMs = null } = {}, conn) {
  const metadata = { action, organizationId, attemptId, eventId, code, status, durationMs };
  fileLogger().info(metadata, 'Payment activity');
  const sql = `INSERT INTO event_logs
    (organization_id, actor_type, channel, action, entity_type, entity_id, method, path, status_code, success, request_json, response_json)
    VALUES (:organizationId, 'payment', 'payment', :action, 'payment_attempt', :attemptId,
      'POST', '/payments/reservepay', :status, :success, :metadata, :response)`;
  const params = { ...metadata, success: status < 400 ? 1 : 0, metadata: JSON.stringify({ eventId }), response: JSON.stringify({ code, durationMs }) };
  if (conn) return conn.execute(sql, params);
  return query(sql, params);
}

module.exports = { activity };
