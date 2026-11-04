const test = require('node:test');
const assert = require('node:assert/strict');
const { assertNoGatewayPayment } = (() => {
  const id = require.resolve('../src/config/db');
  require.cache[id] = { id, filename: id, loaded: true, exports: { query() {} } };
  return require('../src/services/reservepay-store.service');
})();

test('legacy/manual writers reject active gateway allocations and preserve payment history on deletion', async () => {
  const conn = { execute: async (sql, p) => {
    assert.equal(p.organizationId, 7);
    assert.equal(p.bookingId, 101);
    assert.ok(!sql.includes('payment_attempt_id'), 'guard works with pre-expansion schema');
    return [[{ id: 1 }]];
  } };
  await assert.rejects(() => assertNoGatewayPayment(conn, 7, 101), { code: 'PAYMENT_IN_PROGRESS' });
  await assert.rejects(() => assertNoGatewayPayment(conn, 7, 101, { preserveHistory: true }), { code: 'PAYMENT_IN_PROGRESS' });
  await assertNoGatewayPayment({ execute: async () => [[]] }, 7, 101);
});
