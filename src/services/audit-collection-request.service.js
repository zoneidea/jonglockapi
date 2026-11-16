const fs = require('node:fs');
const path = require('node:path');
const {transaction, query} = require('../config/db');
const {AppError, notFound} = require('../utils/errors');
const params = (auth, key) => ({organizationId: auth.organizationId, actor: auth.sub, key});
async function lock(conn, auth, key) {
  const args = params(auth, key);
  await conn.execute(`INSERT IGNORE INTO audit_collection_requests (organization_id, actor_id, request_key)
    VALUES (:organizationId, :actor, :key)`, args);
  const [rows] = await conn.execute(`SELECT * FROM audit_collection_requests WHERE organization_id = :organizationId
    AND actor_id = :actor AND request_key = :key FOR UPDATE`, args);
  return rows[0];
}
async function run(auth, key, hash, work) {
  return transaction(async conn => {
    const row = await lock(conn, auth, key);
    if (row.state === 'cancelled') throw new AppError(409, 'คำขอนี้ปิดแล้ว กรุณาเริ่มรายการใหม่', 'COLLECTION_REQUEST_CANCELLED');
    if (row.request_hash && row.request_hash !== hash) throw new AppError(409, 'คำขอนี้มีข้อมูลต่างจากรายการเดิม', 'COLLECTION_IDEMPOTENCY_CONFLICT');
    const receipt = await work(conn, row.state === 'completed' && row.collection_id ? Number(row.collection_id) : null);
    await conn.execute(`UPDATE audit_collection_requests SET state = 'completed', collection_id = :id, request_hash = :hash
      WHERE organization_id = :organizationId AND actor_id = :actor AND request_key = :key`, {...params(auth, key), id: receipt.id, hash});
    return receipt;
  });
}
async function cancel(auth, key) {
  const id = await transaction(async conn => {
    const row = await lock(conn, auth, key);
    if (row.collection_id) return Number(row.collection_id);
    const [old] = await conn.execute(`SELECT id FROM audit_collections WHERE organization_id = :organizationId
      AND created_by_admin_id = :actor AND idempotency_key = :key FOR UPDATE`, params(auth, key));
    if (old[0]) return Number(old[0].id);
    await conn.execute(`UPDATE audit_collection_requests SET state = 'cancelled'
      WHERE organization_id = :organizationId AND actor_id = :actor AND request_key = :key`, params(auth, key));
    return null;
  });
  return {cancelled: !id, collection: id ? await require('./audit-collection.service').get(auth, id) : null};
}
async function recover(auth, key) {
  const rows = await query(`SELECT state, collection_id FROM audit_collection_requests WHERE organization_id = :organizationId
    AND actor_id = :actor AND request_key = :key`, params(auth, key));
  if (rows[0]?.state === 'cancelled') throw new AppError(409, 'คำขอนี้ปิดแล้ว กรุณาเริ่มรายการใหม่', 'COLLECTION_REQUEST_CANCELLED');
  if (rows[0]?.collection_id) return require('./audit-collection.service').get(auth, Number(rows[0].collection_id));
  const old = await query(`SELECT id FROM audit_collections WHERE organization_id = :organizationId
    AND created_by_admin_id = :actor AND idempotency_key = :key`, params(auth, key));
  if (!old[0]) throw notFound('ยังไม่พบรายการ กรุณาตรวจสอบอีกครั้ง');
  return require('./audit-collection.service').get(auth, Number(old[0].id));
}
class AuditCollectionRequestInitializer {
  async initialize(conn) {await conn.query(fs.readFileSync(path.resolve(__dirname, '../../migrations/062_audit_collection_requests.sql'), 'utf8'));}
}
module.exports = {run, cancel, recover, AuditCollectionRequestInitializer};
