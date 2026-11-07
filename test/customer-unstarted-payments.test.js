const test = require('node:test');
const assert = require('node:assert/strict');
const { clearUnstartedPayments } = require('../src/services/customer-unstarted-payments.service');

function connection({ payments = [], paidItem = false, document = false } = {}) {
  const writes = [];
  return { writes, execute: async (sql, params) => {
    assert.equal(params.organizationId, 7);
    assert.equal(params.userId, 9);
    if (sql.startsWith('SELECT id FROM bookings')) {
      assert.match(sql, /mobile_user_id = :userId/);
      assert.match(sql, /paid_at IS NULL/);
      assert.match(sql, /FOR UPDATE/);
      return [[{id:11}]];
    }
    assert.equal(params.bookingId, 11);
    if (sql.startsWith('SELECT status')) return [payments];
    if (sql.startsWith('SELECT id FROM booking_items')) return [paidItem ? [{id:2}] : []];
    if (sql.startsWith('SELECT id FROM accounting_documents')) return [document ? [{id:3}] : []];
    assert.match(sql, /organization_id = :organizationId/);
    writes.push(sql);
    return [{affectedRows:1}];
  }};
}
const scope = {organizationId:7, userId:9};
test('removes unstarted payment rows, cancels the cart booking and releases its booth locks', async () => {
  for (const payments of [[], [{status:'created',provider:'manual'}], [{status:'waiting',provider:'ksher'}]]) {
    const conn=connection({payments}); await clearUnstartedPayments(conn,scope);
    assert.equal(conn.writes.length,4);
    assert.match(conn.writes[0],/DELETE FROM payments/);
    assert.match(conn.writes[0],/payment_attempt_id IS NULL AND provider <> 'reservepay'/);
    assert.match(conn.writes[1],/cart_visible = 0/);
    assert.match(conn.writes[3],/DELETE FROM booth_date_locks/);
  }
});
test('retains gateway history, money received, transfer evidence, fines and accounting documents', async () => {
  const protectedPayments = [
    {provider:'reservepay',status:'failed'}, {payment_attempt_id:1,status:'created'},
    {provider_reference:'provider-id',status:'waiting'}, {status:'paid'}, {status:'refunded'},
    {paid_at:'2026-11-07',status:'created'}, {proof_uploaded_at:'2026-11-07',status:'waiting'},
    {proof_image_url:'/uploads/proof.png',status:'waiting'}, {audit_check_id:2,status:'created'},
  ];
  for (const payment of protectedPayments) {
    const conn=connection({payments:[payment]}); await clearUnstartedPayments(conn,scope);
    assert.deepEqual(conn.writes,[]);
  }
  for (const options of [{paidItem:true},{document:true}]) {
    const conn=connection(options); await clearUnstartedPayments(conn,scope);
    assert.deepEqual(conn.writes,[]);
  }
});
