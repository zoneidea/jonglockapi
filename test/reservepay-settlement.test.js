const test = require('node:test');
const assert = require('node:assert/strict');

function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
let state;
let failOnPaymentUpdate;
let lookups = 0;
let lookupError;
const logs = [];
const payment = { payment_id: 'pay_test', external_id: 'JL-test', currency: 'THB', amount: 35000, status: 'SUCCESSFUL', captured_at: 1700000000 };
function reset() {
  failOnPaymentUpdate = false;
  lookupError = false;
  lookups = 0;
  logs.length = 0;
  state = {
    attempt: { id: 1, organization_id: 7, mobile_user_id: 9, public_id: 'RPA1', merchant_id: 'merchant', external_id: 'JL-test', provider_reference: null, amount_minor: '35000', currency: 'THB', state: 'pending', lease_token: 'lease', lease_until: null, retry_count: 0 },
    bookings: [101, 102].map((id, i) => ({ id, mobile_user_id: 9, status: 'payment_processing', total_amount: ['100.00', '250.00'][i] })),
    payments: [101, 102].map((id, i) => ({ id: i + 1, booking_id: id, provider: 'reservepay', amount: ['100.00', '250.00'][i], status: 'waiting' })),
    items: [101, 102].map((id, i) => ({ id: i + 1, booking_id: id, booth_id: i + 1, booking_date: '2026-11-04', status: 'payment_processing' })),
    locks: [101, 102].map((id, i) => ({ id: i + 1, booking_id: id, booking_item_id: i + 1, booth_id: i + 1, booking_date: '2026-11-04', status: 'processing' })),
  };
}

async function execute(sql, p) {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (q.startsWith('SELECT booking_id FROM payments')) return [state.payments.map(({ booking_id }) => ({ booking_id }))];
  if (q.startsWith('SELECT * FROM bookings')) return [state.bookings.filter((b) => b.id === p.bookingId)];
  if (q.startsWith('SELECT * FROM payment_attempts')) return [[{ ...state.attempt }]];
  if (q.startsWith('SELECT * FROM payments')) return [[...state.payments]];
  if (q.includes('FROM booking_items')) return [state.items.filter((i) => i.booking_id === p.bookingId)];
  if (q.includes('FROM booth_date_locks') && q.startsWith('SELECT')) return [state.locks.filter((i) => i.booking_id === p.bookingId)];
  if (q.startsWith('UPDATE payment_attempts')) {
    if (p.token && q.includes('retry_count = retry_count + 1')) {
      if (state.attempt.lease_until || !['creating', 'pending', 'unknown'].includes(state.attempt.state)) return [{ affectedRows: 0 }];
      Object.assign(state.attempt, { lease_token: p.token, lease_until: new Date(Date.now() + 60000), retry_count: state.attempt.retry_count + 1 });
    } else if (p.token && state.attempt.lease_token !== p.token) return [{ affectedRows: 0 }];
    else Object.assign(state.attempt, {
      state: p.state || 'review', provider_reference: p.paymentId || state.attempt.provider_reference,
      provider_status: p.providerStatus, lease_token: null, lease_until: null, last_error_code: p.code || (q.includes('LOOKUP_UNCERTAIN') ? 'LOOKUP_UNCERTAIN' : null),
    });
    return [{ affectedRows: 1 }];
  }
  if (q.startsWith('UPDATE payments')) {
    if (failOnPaymentUpdate) throw new Error('simulated database failure');
    state.payments.forEach((item) => Object.assign(item, { status: p.paymentState, paid_at: p.paidAt }));
    return [{ affectedRows: 2 }];
  }
  if (q.startsWith('UPDATE bookings')) {
    Object.assign(state.bookings.find((b) => b.id === p.bookingId), { status: p.bookingStatus, paid_at: p.paidAt });
    return [{ affectedRows: 1 }];
  }
  if (q.startsWith('UPDATE booking_items')) {
    state.items.filter((i) => i.booking_id === p.bookingId).forEach((i) => { i.status = p.bookingStatus; });
    return [{ affectedRows: 1 }];
  }
  if (q.startsWith('UPDATE booth_date_locks')) {
    state.locks.filter((l) => l.booking_id === p.bookingId).forEach((l) => { l.status = p.lockStatus; });
    return [{ affectedRows: 1 }];
  }
  if (q.startsWith('DELETE FROM booth_date_locks')) { state.locks = state.locks.filter((l) => l.booking_id !== p.bookingId); return [{ affectedRows: 1 }]; }
  throw new Error(`Unexpected test database operation: ${q}`);
}

stub('../src/config/env', { RESERVEPAY_MERCHANT_ID: 'merchant' });
stub('../src/config/db', {
  query: async (sql, p) => {
    if (sql.includes('SELECT * FROM payment_attempts')) return [{ ...state.attempt }];
    return (await execute(sql, p))[0];
  },
  transaction: async (fn) => {
    const snapshot = structuredClone(state);
    try { return await fn({ execute }); } catch (error) { state = snapshot; throw error; }
  },
});
stub('../src/services/payment-status-notification.service', { enqueue: async () => null, deliver: async () => {} });
stub('../src/services/payment-activity.service', { activity: async (action, metadata) => logs.push({ action, metadata }) });
stub('../src/services/reservepay.service', { isConfigured: () => true, findPayment: async () => {
  lookups += 1;
  if (lookupError) throw new Error('timeout');
  return payment;
} });
const { applyPayment, providerMatches, reconcile } = require('../src/services/reservepay-settlement.service');

test('one verified payment settles every booking/payment/item/lock atomically with allocated amounts', async () => {
  reset();
  await applyPayment({ ...state.attempt }, payment, 'lease');
  assert.equal(state.attempt.state, 'paid');
  assert.deepEqual(state.payments.map((p) => p.amount), ['100.00', '250.00']);
  for (const collection of [state.bookings, state.payments, state.items, state.locks]) assert.ok(collection.every((row) => row.status === 'paid'));
  assert.equal(state.bookings[0].paid_at.toISOString(), '2023-11-14T22:13:20.000Z');
  assert.equal(logs.at(-1).action, 'reservepay_settled');
  const settled = structuredClone(state);
  await applyPayment({ ...state.attempt }, { ...payment, status: 'FAILED' }, 'lease');
  assert.deepEqual(state, settled, 'duplicate/stale result cannot downgrade paid bookings');
});

test('failed event never becomes paid; expiry releases only this group', async () => {
  reset();
  await applyPayment({ ...state.attempt }, { ...payment, status: 'FAILED' }, 'lease');
  assert.equal(state.attempt.state, 'failed');
  assert.ok(state.payments.every((p) => p.status === 'failed'));
  assert.ok(state.bookings.every((b) => b.status === 'pending_payment'));
  assert.ok(state.locks.every((l) => l.status === 'held'));
  reset();
  await applyPayment({ ...state.attempt }, { ...payment, status: 'EXPIRED' }, 'lease');
  assert.equal(state.attempt.state, 'expired');
  assert.ok(state.bookings.every((b) => b.status === 'expired'));
  assert.equal(state.locks.length, 0);
});

test('amount, currency, identity or lock mismatches require review without fulfilling', async () => {
  for (const changed of [{ amount: 35001 }, { currency: 'USD' }, { external_id: 'other' }, { payment_id: '' }]) {
    reset();
    assert.equal(providerMatches(state.attempt, { ...payment, ...changed }), false);
    await applyPayment({ ...state.attempt }, { ...payment, ...changed }, 'lease');
    assert.equal(state.attempt.state, 'review');
    assert.ok(state.bookings.every((b) => b.status === 'payment_processing'));
  }
  reset();
  state.locks[0].booth_id = 999;
  await applyPayment({ ...state.attempt }, payment, 'lease');
  assert.equal(state.attempt.state, 'review');
  assert.ok(state.payments.every((p) => p.status === 'waiting'));
});

test('a transaction failure rolls back the entire group and keeps recovery lease retryable', async () => {
  reset();
  const before = structuredClone(state);
  failOnPaymentUpdate = true;
  await assert.rejects(() => applyPayment({ ...state.attempt }, payment, 'lease'), /simulated database failure/);
  assert.deepEqual(state, before);
});

test('lookup timeout preserves processing locks and never calls initiate; another live lease is respected', async () => {
  reset();
  lookupError = true;
  state.attempt.state = 'creating';
  const result = await reconcile({ ...state.attempt });
  assert.equal(result.state, 'unknown');
  assert.equal(lookups, 1);
  assert.ok(state.locks.every((l) => l.status === 'processing'));
  assert.ok(state.payments.every((p) => p.status === 'waiting'));
  state.attempt.lease_until = new Date(Date.now() + 60000);
  await reconcile({ ...state.attempt }, { force: true });
  assert.equal(lookups, 1);
});

test('an old worker cannot overwrite a newer lease', async () => {
  reset();
  state.attempt.lease_token = 'new-worker';
  await applyPayment({ ...state.attempt }, payment, 'old-worker');
  assert.equal(state.attempt.state, 'pending');
  assert.ok(state.locks.every((l) => l.status === 'processing'));
});
