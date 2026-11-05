const test = require('node:test');
const assert = require('node:assert/strict');

function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const env = { RESERVEPAY_MERCHANT_ID: 'merchant', RESERVEPAY_WEBHOOK_KEY: 'key', CRON_SECRET: 'secret', RESERVEPAY_CHECKOUT_ENABLED: true };
let attempt;
let allocations;
let bookings;
let gatewayCalls;
let gatewayFailure;
let transactions;
let invalidLock;
function reset() {
  attempt = null; allocations = []; gatewayCalls = 0; transactions = 0; gatewayFailure = false; invalidLock = false;
  env.RESERVEPAY_CHECKOUT_ENABLED = true;
  bookings = [101, 102].map((id, i) => ({ id, market_id: 31 + i, organization_id: 7, mobile_user_id: 9, status: 'pending_payment', total_amount: ['100.00', '250.00'][i], expires_at: new Date(Date.now() + 600000) }));
}
async function execute(sql, p) {
  const q = sql.replace(/\s+/g, ' ').trim();
  if (q.includes('FROM organization_payment_settings')) return [[{mode: 'gateway', sync_state: 'ready'}]];
  if (q.startsWith('SELECT * FROM bookings')) return [bookings.filter((b) => b.id === p.bookingId && b.organization_id === p.organizationId && b.mobile_user_id === p.userId)];
  if (q.startsWith('SELECT * FROM payment_attempts')) return [[...(attempt ? [attempt] : [])]];
  if (q.startsWith('SELECT id FROM payments')) return [[]];
  if (q.startsWith('INSERT INTO payment_attempts')) {
    attempt = { id: 1, organization_id: p.organizationId, mobile_user_id: p.userId, public_id: p.publicId, external_id: p.externalId,
      request_hash: p.hash, payment_session_id: p.sessionId, idempotency_key: p.key, amount_minor: p.amount, currency: 'THB', state: 'creating', lease_token: p.leaseToken };
    return [{ insertId: 1 }];
  }
  if (q.startsWith('INSERT INTO payments')) { allocations.push(p); return [{ insertId: allocations.length }]; }
  if (q.includes('FROM booking_items')) return [[{ id: p.bookingId, booth_id: p.bookingId, booking_date: '2026-11-04', status: 'pending_payment' }]];
  if (q.includes('FROM booth_date_locks')) return [[{ id: p.bookingId, booking_item_id: p.bookingId, booth_id: invalidLock ? 999 : p.bookingId, booking_date: '2026-11-04', status: 'held' }]];
  if (q.startsWith('UPDATE bookings')) { bookings.find((b) => b.id === p.bookingId).status = 'payment_processing'; return [{ affectedRows: 1 }]; }
  if (q.startsWith('UPDATE booking_items') || q.startsWith('UPDATE booth_date_locks') || q.startsWith('UPDATE payments')) return [{ affectedRows: 1 }];
  if (q.startsWith('UPDATE payment_attempts')) {
    Object.assign(attempt, { state: q.includes("state = 'unknown'") ? 'unknown' : 'pending', provider_reference: p.paymentId || null });
    return [{ affectedRows: 1 }];
  }
  throw new Error(`Unexpected test database operation: ${q}`);
}
stub('../src/config/env', env);
stub('../src/config/db', {
  query: async (sql, p) => {
    if (sql.includes('SELECT * FROM payment_attempts')) return attempt ? [attempt] : [];
    if (sql.includes('FROM mobile_users')) return [{ id: 9, email_enc: 'verified@example.test' }];
    return (await execute(sql, p))[0];
  },
  transaction: async (fn) => {
    transactions += 1;
    const snapshot = structuredClone({ attempt, allocations, bookings });
    try { return await fn({ execute }); } catch (error) {
      ({ attempt, allocations, bookings } = snapshot);
      throw error;
    }
  },
});
stub('../src/services/reservepay-store.service', {
  rows: async (conn, sql, p) => (await conn.execute(sql, p))[0],
  assertNoGatewayPayment: async () => {},
  getAttempt: async () => attempt,
  lockGroup: async () => ({ attempt, bookings, payments: allocations }),
});
stub('../src/utils/crypto', { decryptField: (v) => v || null });
stub('../src/services/payment-activity.service', { activity: async () => {} });
stub('../src/services/reservepay-settlement.service', { failInitialization: async () => { attempt.state = 'failed'; } });
stub('../src/services/reservepay.service', {
  isConfigured: () => true,
  initiatePaymentFlow: async (args) => {
    gatewayCalls += 1;
    assert.equal(args.customer_email, 'verified@example.test');
    assert.equal(args.return_url, 'jonglock://payment-return');
    assert.match(args.external_id, /^JL-[0-9a-f-]{36}$/);
    if (gatewayFailure) throw new Error('response was lost');
    return 'provider-payment';
  },
});
const { prepare, initiate, requireCustomer } = require('../src/services/reservepay-checkout.service');
const auth = { sub: 9, organizationId: 7, userType: 'customer' };
const input = { bookingIds: [102, 101], paymentSessionId: 'session', amount: '35000' };

test('preparation allocates one payment per booking and reuses the same durable attempt', async () => {
  reset();
  const first = await prepare(auth, input, 'key');
  assert.equal(first.created, true);
  assert.deepEqual(allocations.map((p) => p.amount), ['100.00', '250.00']);
  assert.ok(bookings.every((b) => b.status === 'payment_processing'));
  const duplicate = await prepare(auth, { ...input, bookingIds: [101, 102] }, 'key');
  assert.equal(duplicate.created, false);
  assert.equal(allocations.length, 2);
  await assert.rejects(() => prepare(auth, { ...input, amount: '35001' }, 'key'), { code: 'IDEMPOTENCY_CONFLICT' });
});

test('foreign ownership, organization, expired booking and wrong totals produce no durable writes', async () => {
  for (const change of ['owner', 'organization', 'expiry', 'amount']) {
    reset();
    if (change === 'owner') bookings[0].mobile_user_id = 99;
    if (change === 'organization') bookings[0].organization_id = 99;
    if (change === 'expiry') bookings[0].expires_at = new Date(0);
    const body = change === 'amount' ? { ...input, amount: '1' } : input;
    await assert.rejects(() => prepare(auth, body, 'key'));
    assert.equal(attempt, null);
    assert.equal(allocations.length, 0);
  }
});

test('disabled checkout rejects before a transaction or provider request', async () => {
  reset(); env.RESERVEPAY_CHECKOUT_ENABLED = false;
  await assert.rejects(() => initiate(auth, input, 'key'), { code: 'PAYMENT_CHECKOUT_DISABLED' });
  assert.equal(transactions, 0);
  assert.equal(gatewayCalls, 0);
  await assert.rejects(() => requireCustomer({ ...auth, userType: 'audit' }), { code: 'FORBIDDEN' });
});

test('lost provider response leaves an unknown durable attempt and retry cannot charge again', async () => {
  reset(); gatewayFailure = true;
  const first = await initiate(auth, input, 'key');
  assert.equal(first.status, 'unknown');
  const retry = await initiate(auth, input, 'key');
  assert.equal(retry.attemptId, first.attemptId);
  assert.equal(gatewayCalls, 1);
  assert.equal(allocations.length, 2);
});

test('successful initiation binds a single provider ID and repeat requests do not initiate again', async () => {
  reset();
  const first = await initiate(auth, input, 'key');
  assert.equal(first.paymentId, 'provider-payment');
  assert.equal(first.status, 'pending');
  assert.equal((await initiate(auth, input, 'key')).attemptId, first.attemptId);
  assert.equal(gatewayCalls, 1);
});

test('stale booth mapping rolls back preparation before any gateway call', async () => {
  reset(); invalidLock = true;
  await assert.rejects(() => initiate(auth, input, 'key'), { code: 'BOOKING_NOT_PAYABLE' });
  assert.equal(gatewayCalls, 0);
  assert.equal(attempt, null);
  assert.equal(allocations.length, 0);
});
