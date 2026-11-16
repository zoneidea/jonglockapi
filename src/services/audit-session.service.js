const jwt = require('jsonwebtoken');
const env = require('../config/env');
const {query} = require('../config/db');
const {decryptField} = require('../utils/crypto');
const {unauthorized} = require('../utils/errors');
const name = 'jonglock_audit_session';
const options = {httpOnly: true, secure: env.NODE_ENV === 'production', sameSite: 'lax', path: `${env.API_PREFIX}/mobile/audit/auth`};
function clear(res) {res.clearCookie(name, options);}
function remember(res, token) {
  const payload = jwt.decode(token);
  const maxAge = Math.max(0, (Number(payload?.exp || 0) * 1000) - Date.now());
  if (!maxAge) return clear(res);
  res.cookie(name, token, {...options, maxAge});
}
function read(req) {
  const values = String(req.headers.cookie || '').split(';').map(value => value.trim());
  const value = values.find(value => value.startsWith(`${name}=`));
  if (!value) throw unauthorized('ไม่มีเซสชันที่บันทึกไว้');
  try {return decodeURIComponent(value.slice(name.length + 1));} catch {throw unauthorized('เซสชันไม่ถูกต้อง');}
}
async function restore(req) {
  let payload;
  try {payload = jwt.verify(read(req), env.JWT_SECRET, {issuer: 'jonglock-backend'});} catch {throw unauthorized('เซสชันหมดอายุ กรุณาเข้าสู่ระบบอีกครั้ง');}
  if (payload.userType !== 'audit' || payload.role !== 'audit' || !Number.isFinite(payload.exp)) throw unauthorized('ไม่พบสิทธิ์เจ้าหน้าที่');
  const rows = await query(`SELECT au.id, au.organization_id, au.role, au.name_enc,
    o.code AS organization_code, o.name AS organization_name FROM admin_users au
    JOIN organizations o ON o.id = au.organization_id
    WHERE au.id = :id AND au.organization_id = :organizationId AND au.role = 'audit' AND au.status = 'active' LIMIT 1`,
  {id: payload.sub, organizationId: payload.organizationId});
  const user = rows[0];
  if (!user) throw unauthorized('บัญชีไม่มีสิทธิ์ใช้งานแล้ว');
  const assignments = await query(`SELECT market_id FROM admin_market_assignments WHERE admin_user_id = :id
    AND organization_id = :organizationId AND status = 'active'`, {id: user.id, organizationId: user.organization_id});
  const marketIds = assignments.map(row => Number(row.market_id));
  const remaining = payload.exp - Math.floor(Date.now() / 1000);
  if (remaining <= 0) throw unauthorized('เซสชันหมดอายุ');
  const token = jwt.sign({sub: user.id, userType: 'audit', role: 'audit', organizationId: user.organization_id, marketIds, exp: payload.exp}, env.JWT_SECRET, {issuer: 'jonglock-backend'});
  return {token, user: {id: user.id, role: 'audit', name: decryptField(user.name_enc), organizationId: user.organization_id,
    organizationCode: user.organization_code, organizationName: user.organization_name, marketIds}};
}
module.exports = {remember, clear, restore};
