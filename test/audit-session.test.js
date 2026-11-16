const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const jwt = require('jsonwebtoken');
for (const [key, value] of Object.entries({NODE_ENV: 'production', DB_PASSWORD: 'test', JWT_SECRET: 'session-test-'.repeat(5), FIELD_ENCRYPTION_KEY: 'a'.repeat(64), FIELD_HASH_SECRET: 'b'.repeat(32)})) process.env[key] = value;
function stub(path, exports) {const id = require.resolve(path); require.cache[id] = {id, filename: id, loaded: true, exports};}
let active = true;
let marketIds = [9];
let accountReads = 0;
stub('../src/config/db', {query: async (sql, params) => {
  assert.equal(Number(params.organizationId), 7);
  if (sql.includes('admin_market_assignments')) {assert.match(sql, /organization_id = :organizationId/); return marketIds.map(id => ({market_id: id}));}
  assert.match(sql, /au.role = 'audit' AND au.status = 'active'/);
  accountReads++;
  return active ? [{id: 3, organization_id: 7, name_enc: null, organization_code: 'ORG', organization_name: 'Market'}] : [];
}});
function token(payload = {}, expiresIn = 3600) {return jwt.sign({sub: 3, userType: 'audit', role: 'audit', organizationId: 7, marketIds: [1], ...payload}, process.env.JWT_SECRET, {issuer: 'jonglock-backend', expiresIn});}
stub('../src/modules/auth/auth.service', {loginAudit: async () => ({token: token(), user: {id: 3, role: 'audit'}})});
const app = express(); app.use(express.json()); app.use('/api/mobile/audit', require('../src/modules/audit/audit.routes')); app.use(require('../src/middlewares/error-handler').errorHandler);
async function run(work) {const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));try {await work(`http://127.0.0.1:${server.address().port}/api/mobile/audit/auth`);} finally {await new Promise(resolve => server.close(resolve));}}
test('remembered audit login issues host-only HttpOnly Secure Lax cookie with expiry and no-store', () => run(async base => {
  const res = await fetch(base+'/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: 'audit', password: 'test', rememberMe: true})});
  assert.equal(res.status, 200);
  const cookie = res.headers.get('set-cookie');
  for (const value of ['HttpOnly', 'Secure', 'SameSite=Lax', 'Path=/api/mobile/audit/auth', 'Max-Age=']) assert.ok(cookie.includes(value), value);
  assert.doesNotMatch(cookie, /Domain=/i); assert.equal(res.headers.get('cache-control'), 'no-store');
}));
test('restore reads current account and market assignments, without extending original expiry', () => run(async base => {
  const original = token(); marketIds = [11];
  const res = await fetch(base+'/session', {headers: {Cookie: 'jonglock_audit_session='+original}});
  assert.equal(res.status, 200);
  const data = (await res.json()).data;
  assert.deepEqual(data.user.marketIds, [11]);
  assert.deepEqual(jwt.verify(data.token, process.env.JWT_SECRET).marketIds, [11]);
  assert.ok(jwt.decode(data.token).exp <= jwt.decode(original).exp);
  assert.equal(res.headers.get('cache-control'), 'no-store');
}));
test('expired, forged and wrong-role cookies are rejected and removed before any account access', () => run(async base => {
  const reads = accountReads;
  for (const invalid of [token({}, -1), 'tampered', token({userType: 'admin', role: 'admin'})]) {
    const res = await fetch(base+'/session', {headers: {Cookie: 'jonglock_audit_session='+invalid}});
    assert.equal(res.status, 401); assert.match(res.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  }
  assert.equal(accountReads, reads);
}));
test('disabled account cannot resume and explicit logout or nonremembered login clears cookie', () => run(async base => {
  active = false;
  const denied = await fetch(base+'/session', {headers: {Cookie: 'jonglock_audit_session='+token()}});
  assert.equal(denied.status, 401); active = true;
  const logout = await fetch(base+'/logout', {method: 'POST'});
  assert.equal(logout.status, 200); assert.match(logout.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
  const login = await fetch(base+'/login', {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({username: 'audit', password: 'test', rememberMe: false})});
  assert.match(login.headers.get('set-cookie'), /Expires=Thu, 01 Jan 1970/);
}));
test('application logs redact both request cookies and Set-Cookie headers', () => {
  const {spawnSync} = require('node:child_process');
  const output = spawnSync(process.execPath, ['-e', `const {logger}=require('./src/config/logger');logger.info({req:{headers:{cookie:'PRIVATE_SESSION_SENTINEL'}},res:{headers:{'set-cookie':['PRIVATE_SESSION_SENTINEL']}}});`], {cwd: require('node:path').resolve(__dirname, '..'), encoding: 'utf8'});
  assert.equal(output.status, 0); assert.doesNotMatch(output.stdout, /PRIVATE_SESSION_SENTINEL/); assert.match(output.stdout, /redacted/);
});
