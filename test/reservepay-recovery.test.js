const test = require('node:test');
const assert = require('node:assert/strict');
function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const updates = [];
let attempts;
let updated;
let claimable;
let reconciliations;
stub('../src/config/env', { RESERVEPAY_MERCHANT_ID: 'merchant' });
stub('../src/config/db', { query: async (sql, p) => {
  if (sql.includes('SELECT * FROM payment_attempts')) return attempts;
  if (sql.includes('retry_count = retry_count + 1')) return { affectedRows: claimable ? 1 : 0 };
  updates.push(p);
  return { affectedRows: 1 };
} });
stub('../src/services/payment-activity.service', { activity: async () => {} });
stub('../src/services/reservepay-settlement.service', { reconcile: async () => { reconciliations += 1; return updated; } });
const { processCallback } = require('../src/services/reservepay-recovery.service');
const callback = { id: 1, event_id: 'evt_test', retry_count: 0, payload_json: { event_id: 'evt_test', payment_id: 'provider', external_id: 'JL-test', status: 'SUCCESSFUL' } };
function reset() {
  updates.length = 0;
  claimable = true; reconciliations = 0;
  attempts = [{ id: 9, organization_id: 7, public_id: 'RPA9', external_id: 'JL-test', provider_reference: null }];
  updated = { state: 'paid', lease_until: null };
}

test('callback arriving before payment ID is bound resolves tenant by persisted external ID', async () => {
  reset();
  await processCallback(callback);
  assert.equal(reconciliations, 1);
  assert.equal(updates[0].organizationId, 7);
  assert.equal(updates[0].attemptId, 9);
  assert.equal(updates[0].status, 'processed');
});

test('a live initiate lease leaves callback pending for durable retry', async () => {
  reset(); updated = { state: 'creating', lease_until: new Date() };
  await processCallback(callback);
  assert.equal(updates[0].status, 'pending');
  assert.equal(updates[0].attemptId, undefined);
});

test('reference mismatch never reconciles or assigns a tenant; repeated unresolved events require review', async () => {
  reset(); attempts[0].provider_reference = 'different-payment';
  await processCallback(callback);
  assert.equal(reconciliations, 0);
  assert.equal(updates[0].status, 'pending');
  reset(); attempts = [];
  await processCallback({ ...callback, retry_count: 9 });
  assert.equal(updates[0].status, 'review');
});

test('a callback already claimed or processed by another worker is untouched', async () => {
  reset(); claimable = false;
  await processCallback(callback);
  assert.equal(reconciliations, 0);
  assert.equal(updates.length, 0);
});
