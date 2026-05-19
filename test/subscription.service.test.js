const test = require('node:test');
const assert = require('node:assert/strict');

const { canUseFeature, resolveFeatureFromPath } = require('../src/services/subscription.service');

test('allows every feature for active full-function subscriptions', () => {
  assert.equal(canUseFeature({ writeAllowed: true, fullFunction: true }, 'market_management'), true);
});

test('blocks feature use when subscription is not writeable', () => {
  assert.equal(canUseFeature({ writeAllowed: false, fullFunction: true }, 'market_management'), false);
});

test('allows enabled entitlements on limited subscriptions', () => {
  const subscription = {
    writeAllowed: true,
    fullFunction: false,
    entitlements: {
      reports: { enabled: true },
      accounting: { enabled: false },
    },
  };

  assert.equal(canUseFeature(subscription, 'reports'), true);
  assert.equal(canUseFeature(subscription, 'accounting'), false);
  assert.equal(canUseFeature(subscription, 'admin_management'), false);
});

test('resolves management API paths to subscription features', () => {
  assert.equal(resolveFeatureFromPath('/markets/1/booths'), 'booth_management');
  assert.equal(resolveFeatureFromPath('/accounting/documents'), 'accounting');
  assert.equal(resolveFeatureFromPath('/reports/payments'), 'reports');
  assert.equal(resolveFeatureFromPath('/unknown'), 'dashboard');
});
