const {randomUUID} = require('node:crypto');
const {query} = require('../config/db');
const {encryptField, decryptField, blindIndex} = require('../utils/crypto');
const {forbidden, notFound, badRequest} = require('../utils/errors');
const normalize = value => String(value || '').normalize('NFKC').trim().replace(/\s+/g, ' ');
const customerName = row => [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim() || 'ผู้ค้า';
function access(auth, marketId) {if (!auth.marketIds?.includes(Number(marketId))) throw forbidden('Market is not assigned to this account');}
async function suggestions(auth, marketId, search) {
  access(auth, marketId);
  const needle = normalize(search).toLocaleLowerCase('th');
  if (!needle) return {items: []};
  const params = {organizationId: auth.organizationId, marketId};
  const [directory, customers] = await Promise.all([
    query(`SELECT d.id, d.public_id, d.name_enc, d.mobile_user_id FROM audit_merchants d
      LEFT JOIN mobile_users mu ON mu.id = d.mobile_user_id AND mu.organization_id = d.organization_id
      JOIN markets m ON m.id = d.market_id AND m.organization_id = d.organization_id
      WHERE d.organization_id = :organizationId AND d.market_id = :marketId AND m.status = 'active' AND m.deleted_at IS NULL
        AND (d.mobile_user_id IS NULL OR mu.status = 'active') ORDER BY d.id DESC LIMIT 500`, params),
    query(`SELECT mu.id, mu.public_id, mu.first_name_enc, mu.last_name_enc FROM mobile_users mu
      WHERE mu.organization_id = :organizationId AND mu.status = 'active'
        AND EXISTS (SELECT 1 FROM bookings b WHERE b.mobile_user_id = mu.id AND b.organization_id = :organizationId AND b.market_id = :marketId)
      ORDER BY mu.id DESC LIMIT 500`, params),
  ]);
  const linked = new Set(directory.map(row => Number(row.mobile_user_id)).filter(Boolean));
  const items = [...directory.map(row => ({source: 'merchant', merchantId: Number(row.id), publicId: row.public_id, name: decryptField(row.name_enc)})),
    ...customers.filter(row => !linked.has(Number(row.id))).map(row => ({source: 'customer', customerId: Number(row.id), publicId: row.public_id, name: customerName(row)}))];
  return {items: items.filter(item => normalize(item.name).toLocaleLowerCase('th').includes(needle)).slice(0, 20)};
}
async function resolveMerchant(conn, auth, marketId, draft) {
  access(auth, marketId);
  if (draft.merchantId && draft.customerId) throw badRequest('Choose one merchant identity');
  if (draft.merchantId) {
    const [rows] = await conn.execute(`SELECT d.id, d.public_id, d.name_enc FROM audit_merchants d
      LEFT JOIN mobile_users mu ON mu.id = d.mobile_user_id AND mu.organization_id = d.organization_id
      WHERE d.id = :merchantId AND d.organization_id = :organizationId AND d.market_id = :marketId
        AND (d.mobile_user_id IS NULL OR mu.status = 'active') FOR UPDATE`, {...draft, organizationId: auth.organizationId, marketId});
    if (!rows[0]) throw notFound('Merchant not found in this market');
    return {id: Number(rows[0].id), publicId: rows[0].public_id, name: decryptField(rows[0].name_enc)};
  }
  let name = normalize(draft.customerReference);
  if (draft.customerId) {
    const [rows] = await conn.execute(`SELECT mu.id, mu.first_name_enc, mu.last_name_enc FROM mobile_users mu
      WHERE mu.id = :customerId AND mu.organization_id = :organizationId AND mu.status = 'active'
        AND EXISTS (SELECT 1 FROM bookings b WHERE b.mobile_user_id = mu.id AND b.organization_id = :organizationId AND b.market_id = :marketId) FOR UPDATE`,
    {customerId: draft.customerId, organizationId: auth.organizationId, marketId});
    if (!rows[0]) throw notFound('Customer not found in this market');
    name = customerName(rows[0]);
    const [existing] = await conn.execute(`SELECT id, public_id, name_enc FROM audit_merchants WHERE organization_id = :organizationId
      AND market_id = :marketId AND mobile_user_id = :customerId FOR UPDATE`, {organizationId: auth.organizationId, marketId, customerId: draft.customerId});
    if (existing[0]) return {id: Number(existing[0].id), publicId: existing[0].public_id, name: decryptField(existing[0].name_enc)};
  }
  if (!name || name.length > 200) throw badRequest('กรุณาระบุชื่อผู้ค้า');
  const publicId = `MER-${randomUUID()}`;
  const [result] = await conn.execute(`INSERT INTO audit_merchants (organization_id, market_id, public_id, name_enc, name_hash, mobile_user_id)
    VALUES (:organizationId, :marketId, :publicId, :name, :hash, :customerId)`,
  {organizationId: auth.organizationId, marketId, publicId, name: encryptField(name), hash: blindIndex(name), customerId: draft.customerId || null});
  return {id: Number(result.insertId), publicId, name};
}
module.exports = {suggestions, resolveMerchant};
