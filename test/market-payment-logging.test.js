const test = require('node:test');
const assert = require('node:assert/strict');
const dbId = require.resolve('../src/config/db');
require.cache[dbId] = { id: dbId, filename: dbId, loaded: true, exports: {} };
const { sanitize } = require('../src/middlewares/event-logger');
test('payment settings and bank details never appear in request/response audit logs', () => {
  const safe = sanitize({body:{settings:'{"accountNumber":"1234567890"}', details:{accountNumber:'1234567890'}},data:{recipientDetails:{accountName:'Private Name'},paymentMethod:{bankAccountNo:'1234567890',bankAccountName:'Private Name',promptpayId:'0999999999'}}});
  const encoded = JSON.stringify(safe);
  for (const value of ['1234567890','Private Name','0999999999']) assert.ok(!encoded.includes(value));
  assert.equal(safe.body.settings, '[REDACTED]');
});
