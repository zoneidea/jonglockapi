const test = require('node:test');
const assert = require('node:assert/strict');
let row;
const auth = {organizationId: 4, sub: 9};
const conn = {async execute(sql, params) {
  assert.equal(params.organizationId, 4); assert.equal(params.actor, 9);
  if (sql.includes('INSERT IGNORE')) row ||= {state: 'open'};
  if (sql.includes('SELECT *')) return [[row]];
  if (sql.includes("state = 'completed'")) Object.assign(row, {state: 'completed', collection_id: params.id, request_hash: params.hash});
  if (sql.includes("state = 'cancelled'")) row.state = 'cancelled';
  if (sql.includes('SELECT id FROM audit_collections')) return [[]];
  return [{}];
}};
const dbId = require.resolve('../src/config/db');
require.cache[dbId] = {id: dbId, filename: dbId, loaded: true, exports: {transaction: work => work(conn), query: async () => row ? [row] : []}};
const fence = require('../src/services/audit-collection-request.service');
test('closing an absent request fences delayed creation before any money write', async () => {
  row = null;
  assert.deepEqual(await fence.cancel(auth, 'opaque-key'), {cancelled: true, collection: null});
  let writes = 0;
  await assert.rejects(fence.run(auth, 'opaque-key', 'hash', async () => {writes++;}), e => e.code === 'COLLECTION_REQUEST_CANCELLED');
  assert.equal(writes, 0);
});
test('request hash prevents changing payload even when an existing audit bill was reused', async () => {
  row = null;
  const receipt = {id: 22};
  assert.equal(await fence.run(auth, 'key', 'first', async () => receipt), receipt);
  assert.equal(row.collection_id, 22);
  await assert.rejects(fence.run(auth, 'key', 'changed', async () => {throw new Error('must not write');}), e => e.code === 'COLLECTION_IDEMPOTENCY_CONFLICT');
});
test('cancelled recovery is explicit instead of indefinitely reporting not found', async () => {
  row = {state: 'cancelled'};
  await assert.rejects(fence.recover(auth, 'key'), e => e.code === 'COLLECTION_REQUEST_CANCELLED');
});
