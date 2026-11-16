const fs = require('node:fs');
const path = require('node:path');
const pino = require('pino');
const { query } = require('../config/db');
let file;
function collectionLog(req, res, next) {
  const started = Date.now();
  res.on('finish', () => {
    if (!file) {
      const folder = path.resolve(__dirname, '../../logs');
      fs.mkdirSync(folder, { recursive: true, mode: 0o700 });
      file = pino(pino.destination({ dest: path.join(folder, 'audit-collections.log'), sync: true, mode: 0o600 }));
    }
    const meta = { organizationId: req.auth.organizationId, actor: req.auth.sub, role: req.auth.role,
      method: req.method, route: String(req.route?.path || '/audit-collections'), status: res.statusCode, durationMs: Date.now() - started };
    file.info(meta, 'Audit collection request and response');
    query(`INSERT INTO event_logs (organization_id, actor_type, actor_id, actor_role, channel, action, method, path,
      status_code, success, request_json, response_json) VALUES (:organizationId, :actorType, :actor, :role,
      'audit_collection', 'audit.collection', :method, :route, :status, :success, :request, :response)`, {
      ...meta, actorType: req.auth.role === 'audit' ? 'audit' : 'management', success: res.statusCode < 400 ? 1 : 0,
      request: JSON.stringify({ method: meta.method, route: meta.route }), response: JSON.stringify({ status: meta.status, durationMs: meta.durationMs }),
    }).catch(() => file.error({ status: 500 }, 'Audit collection log persistence failed'));
  });
  next();
}
module.exports = { collectionLog };
