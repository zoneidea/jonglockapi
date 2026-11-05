const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const { createHmac } = require('node:crypto');

function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
const env = { RESERVEPAY_WEBHOOK_KEY: Buffer.from('webhook-test-key').toString('base64'), RESERVEPAY_MERCHANT_ID: 'test-merchant', RESERVEPAY_CHECKOUT_ENABLED: false };
stub('../src/config/env', env);
const inbox = new Map();
let storageFailure = false;
stub('../src/config/db', { query: async (_sql, params) => {
  if (storageFailure) throw new Error('storage unavailable');
  if (!inbox.has(params.eventId)) inbox.set(params.eventId, JSON.parse(params.payload));
  return { affectedRows: 1 };
} });
stub('../src/services/payment-activity.service', { activity: async () => {} });
stub('../src/middlewares/auth', { authenticate(req, res, next) {
  if (!req.headers.authorization) return res.sendStatus(401);
  req.auth = { sub: 1, organizationId: 7, userType: req.headers.authorization };
  return next();
} });
let initiated = 0;
stub('../src/services/reservepay-checkout.service', {
  requireCustomer: async (auth) => { if (auth.userType !== 'customer') throw Object.assign(new Error('denied'), { statusCode: 403 }); },
  initiate: async () => { initiated += 1; return { attemptId: 'a', paymentId: null, status: 'unknown' }; },
});
stub('../src/services/reservepay.service', { getPlatformPaymentMethods: async () => ({ methods: [] }) });
stub('../src/services/reservepay-store.service', {
  ownedAttempt: async (auth, id) => {
    if (id !== 'owned') throw Object.assign(new Error('not found'), { statusCode: 404 });
    return { id: 1, organization_id: auth.organizationId, public_id: id, state: 'pending', amount_minor: '100', currency: 'THB' };
  }, bookingIds: async () => [101],
});
stub('../src/services/reservepay-settlement.service', { reconcile: async (attempt) => attempt });
const mobile = require('../src/modules/payments/reservepay-mobile.routes');
const webhook = require('../src/modules/payments/reservepay-webhook.routes');
const discovery = require('../src/modules/payments/reservepay.routes');

test('JWT routes reject anonymous/audit access and malformed or unowned payment requests', async () => {
  const app = express();
  // Mirror production ordering: webhook receives unparsed bytes.
  app.use('/webhook', webhook);
  app.use(express.json());
  app.use('/mobile', mobile);
  app.use('/public', discovery);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ code: error.code }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((r) => server.once('listening', r));
  const base = `http://127.0.0.1:${server.address().port}`;
  const post = (path, body, actor, key) => fetch(base + path, {
    method: 'POST', headers: { 'content-type': 'application/json', ...(actor ? { authorization: actor } : {}), ...(key ? { 'idempotency-key': key } : {}) },
    body: JSON.stringify(body),
  });
  try {
    assert.equal((await post('/mobile/initiate', {}, null)).status, 401);
    assert.equal((await post('/mobile/initiate', {}, 'audit')).status, 403);
    const valid = { bookingIds: [101], paymentSessionId: 'session', amount: '100' };
    for (const invalid of [{ ...valid, bookingIds: [101, 101] }, { ...valid, amount: '1.1' }, { ...valid, organizationId: 8 }]) {
      assert.equal((await post('/mobile/initiate', invalid, 'customer', 'key')).status, 400);
    }
    assert.equal((await post('/mobile/initiate', valid, 'customer')).status, 400);
    for (const bookingIds of [[101, 101], [Number.MAX_SAFE_INTEGER + 1], []]) {
      assert.equal((await post('/mobile/active', { bookingIds }, 'customer')).status, 400);
    }
    assert.equal(initiated, 0);
    assert.equal((await post('/mobile/status', { attemptId: 'foreign' }, 'customer')).status, 404);
    assert.equal((await post('/mobile/status', { paymentId: 'arbitrary' }, 'customer')).status, 400);
    assert.equal((await post('/mobile/status', { attemptId: 'owned' }, 'customer')).status, 200);
    assert.equal((await post('/mobile/initiate', valid, 'customer', 'key')).status, 202);
    for (const path of ['/public/initiate', '/public/status']) assert.equal((await post(path, valid)).status, 410);

    const event = { event_id: 'evt_one', event: 'payment_completed', payment_id: 'payment', external_id: 'JL-test', status: 'SUCCESSFUL', delivered_at: 1700000000, customer_email: 'must-not-be-stored@example.test' };
    const send = (value, signature) => fetch(base + '/webhook', { method: 'POST', headers: { 'content-type': 'application/json', ...(signature ? { 'Reservepay-Signature': signature } : {}) }, body: value });
    const sign = (raw) => `hmac_sha256=${createHmac('sha256', Buffer.from(env.RESERVEPAY_WEBHOOK_KEY, 'base64')).update(raw).digest('hex')}`;
    const raw = JSON.stringify(event);
    assert.equal((await send(raw)).status, 401);
    assert.equal(inbox.size, 0);
    assert.equal((await send(raw, sign(raw))).status, 200);
    const retry = JSON.stringify({ ...event, delivered_at: 1700000060 });
    assert.equal((await send(retry, sign(retry))).status, 200);
    assert.equal(inbox.size, 1);
    assert.equal(inbox.get('evt_one').customer_email, undefined);
    const failed = JSON.stringify({ ...event, event_id: 'evt_failed', status: 'FAILED' });
    assert.equal((await send(failed, sign(failed))).status, 200);
    assert.equal(inbox.get('evt_failed').status, 'FAILED');
    const invalid = JSON.stringify({ ...event, status: 'PENDING' });
    assert.equal((await send(invalid, sign(invalid))).status, 400);
    assert.equal((await send(raw + ' ', sign(raw))).status, 401);
    assert.equal((await send('{', sign('{'))).status, 400);
    storageFailure = true;
    assert.equal((await send(raw, sign(raw))).status, 503);
    storageFailure = false;
    assert.equal((await send('x'.repeat(65537), sign('x'.repeat(65537)))).status, 413);
  } finally { await new Promise((r) => server.close(r)); }
});
