const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { minorUnits, requestHash, verifySignature, unixDate } = require('../src/utils/reservepay');

test('money uses exact integer satang including amounts beyond 32 bits', () => {
  assert.equal(minorUnits('0.29') + minorUnits('0.01'), 30n);
  assert.equal(minorUnits('9999999999.99'), 999999999999n);
  assert.equal(minorUnits('1.5'), 150n);
  for (const input of ['1.001', '-1', 'NaN', '', null]) assert.throws(() => minorUnits(input));
});

test('idempotency fingerprint ignores booking order but binds session and amount', () => {
  const input = { bookingIds: [102, 101], paymentSessionId: 'session', amount: '35000' };
  assert.equal(requestHash(input), requestHash({ ...input, bookingIds: [101, 102] }));
  assert.notEqual(requestHash(input), requestHash({ ...input, amount: '35001' }));
  assert.notEqual(requestHash(input), requestHash({ ...input, paymentSessionId: 'other' }));
});

test('signature verifies exact raw bytes with base64 decoded key and rejects malformed signatures', () => {
  const raw = Buffer.from('{ "event_id": "evt_a" }');
  const secret = Buffer.from('a-test-key-that-is-not-a-merchant-key');
  const key = secret.toString('base64');
  const header = `hmac_sha256=${createHmac('sha256', secret).update(raw).digest('hex')}`;
  assert.equal(verifySignature(raw, header, key), true);
  assert.equal(verifySignature(Buffer.from(JSON.stringify(JSON.parse(raw))), header, key), false);
  for (const value of ['', header.replace('hmac_', ''), 'hmac_sha256=ff', 'hmac_sha256=' + 'z'.repeat(64)]) {
    assert.equal(verifySignature(raw, value, key), false);
  }
  assert.equal(verifySignature(raw, header, Buffer.from('wrong').toString('base64')), false);
  assert.equal(verifySignature(raw, header, ''), false);
  assert.equal(verifySignature(JSON.parse(raw), header, key), false);
});

test('provider Unix timestamps are interpreted as seconds', () => {
  assert.equal(unixDate(1700000000).toISOString(), '2023-11-14T22:13:20.000Z');
  assert.equal(unixDate(null), null);
  assert.equal(unixDate('1700000000'), null);
});
