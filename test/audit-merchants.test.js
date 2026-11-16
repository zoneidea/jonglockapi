const test = require('node:test');
const assert = require('node:assert/strict');
for (const [key, value] of Object.entries({DB_PASSWORD: 'test', JWT_SECRET: 'test-secret-'.repeat(4), FIELD_ENCRYPTION_KEY: 'a'.repeat(64), FIELD_HASH_SECRET: 'b'.repeat(32)})) process.env[key] ||= value;
const {encryptField, decryptField} = require('../src/utils/crypto');
const auth = {organizationId: 7, marketIds: [2]};
const dbId = require.resolve('../src/config/db');
require.cache[dbId] = {id: dbId, filename: dbId, loaded: true, exports: {query: async (sql, params) => {
  assert.equal(params.organizationId, 7); assert.equal(params.marketId, 2);
  assert.match(sql, /organization_id = :organizationId/);
  assert.match(sql, /market_id = :marketId/);
  if (sql.includes('FROM audit_merchants')) return [{id: 12, public_id: 'MER-12', name_enc: encryptField('ร้านเดิม'), mobile_user_id: 3}];
  return [{id: 3, public_id: 'CUS-3', first_name_enc: encryptField('ร้านเดิม')}, {id: 4, public_id: 'CUS-4', first_name_enc: encryptField('ร้านผลไม้')}];
}}};
const service = require('../src/services/audit-merchant.service');
test('suggestions scope to assigned market and do not duplicate linked customers', async () => {
  const result = await service.suggestions(auth, 2, 'ร้าน');
  assert.equal(result.items.length, 2);
  assert.equal(result.items[0].merchantId, 12);
  assert.equal(result.items[1].customerId, 4);
  await assert.rejects(service.suggestions(auth, 99, 'ร้าน'), e => e.status === 403 || e.statusCode === 403);
});
test('new merchant gets a public ID and encrypted name without creating a login account', async () => {
  let writes = 0;
  const merchant = await service.resolveMerchant({execute: async (sql, params) => {
    assert.match(sql, /INSERT INTO audit_merchants/);
    assert.doesNotMatch(sql, /INSERT INTO mobile_users/);
    assert.notEqual(params.name, 'ร้านใหม่');
    assert.equal(decryptField(params.name), 'ร้านใหม่');
    assert.match(params.publicId, /^MER-[a-f0-9-]{36}$/);
    assert.equal(params.customerId, null); writes++;
    return [{insertId: 15}];
  }}, auth, 2, {customerReference: ' ร้านใหม่ '});
  assert.equal(merchant.id, 15); assert.equal(merchant.name, 'ร้านใหม่'); assert.equal(writes, 1);
});
test('a selected merchant from another market is rejected without writes', async () => {
  await assert.rejects(service.resolveMerchant({execute: async (sql, params) => {
    assert.match(sql, /d.market_id = :marketId/); assert.match(sql, /d.organization_id = :organizationId/);
    assert.equal(params.marketId, 2); return [[]];
  }}, auth, 2, {merchantId: 999, customerReference: 'ignored'}), e => e.statusCode === 404 || e.status === 404);
});
