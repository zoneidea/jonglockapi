const test = require('node:test');
const assert = require('node:assert/strict');
function stub(path, exports) { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; }
stub('../src/config/env', { RESERVEPAY_API_KEY: 'test-only', RESERVEPAY_MERCHANT_ID: 'test-only', RESERVEPAY_API_URL: 'https://provider.invalid' });
stub('../src/services/payment-activity.service', { activity: async () => {} });
const { initiatePaymentFlow } = require('../src/services/reservepay.service');
const { publicAttempt } = require('../src/utils/reservepay');
test('amount minimum becomes numeric metadata without retaining raw provider details', async () => {
  const originalFetch = global.fetch;
  global.fetch = async () => ({ ok: false, status: 400, json: async () => ['INVALID_ARGUMENTS', 'private provider message', [
    { argument: 'amount', type: 'invalid_amount', message: 'Amount 3.00 is below minimum 20.00' },
    { argument: 'customer_email', message: 'private@example.test' },
  ]] });
  try {
    await assert.rejects(() => initiatePaymentFlow({}), (error) => {
      assert.equal(error.amountConstraintCode, 'AMOUNT_BELOW_MINIMUM:2000');
      assert.ok(!JSON.stringify(error).includes('private'));
      return true;
    });
    const attempt = publicAttempt({ last_error_code: 'AMOUNT_BELOW_MINIMUM:2000', amount_minor: '300' });
    assert.equal(attempt.failureCode, 'AMOUNT_BELOW_MINIMUM');
    assert.equal(attempt.minimumAmount, '2000');
    assert.equal(publicAttempt({ last_error_code: 'INVALID_ARGUMENTS' }).minimumAmount, undefined);
  } finally { global.fetch = originalFetch; }
});
