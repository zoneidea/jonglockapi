const test = require('node:test');
const assert = require('node:assert/strict');
const { cardForm } = require('../src/modules/payments/reservepay-card-form');
test('card fields are provider hosted with nonce CSP and expose only single-use tokens', () => {
  const page = cardForm({ merchantId: 'merchant', installationId: '</script>injection' });
  assert.match(page.html, /https:\/\/sdk.reservepay.com\/js\/v1\/reservepay.js/);
  assert.match(page.html, /customCardFields.create/); assert.match(page.html, /usage:'SINGLE'/);
  assert.ok(!page.html.includes('</script>injection')); assert.match(page.csp, /script-src 'nonce-/);
  assert.ok(!page.csp.includes("script-src 'unsafe-inline'"));
});
