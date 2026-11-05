const test = require('node:test');
const assert = require('node:assert/strict');
function stub(file, exports) { const id = require.resolve(file); require.cache[id] = { id, filename: id, loaded: true, exports }; }
let identity = { sub: 'verified', email: 'Buyer@gmail.com', email_verified: true };
let users = [{ id: 9 }];
let lookups = 0;
const env = {GOOGLE_WEB_CLIENT_ID: 'client'};
stub('../src/config/env', env);
let lastQuery;
stub('google-auth-library', { OAuth2Client: class {
  async verifyIdToken({idToken, audience}) {
    assert.equal(idToken, 'id-token'); assert.equal(audience, 'client');
    if (identity instanceof Error) throw identity;
    return {getPayload: () => identity};
  }
} });
stub('../src/config/db', { query: async (sql, params) => { lookups += 1; lastQuery = { sql, params }; return users; } });
stub('../src/utils/crypto', { blindIndex: (value) => `hash:${value}` });
stub('../src/middlewares/auth', { signToken: (claims, options) => ({ claims, options }) });
const { exchangeCustomerIdentity } = require('../src/modules/auth/google-customer.service');
const body = { googleIdToken: 'id-token', organizationId: 7 };

test('verified identity resolves an active customer only within the selected tenant', async () => {
  const result = await exchangeCustomerIdentity(body);
  assert.equal(result.token.claims.sub, 9); assert.equal(result.token.claims.organizationId, 7);
  assert.equal(result.token.claims.userType, 'customer'); assert.equal(result.token.options.expiresIn, '15m');
  assert.deepEqual(lastQuery.params, { organizationId: 7, emailHash: 'hash:buyer@gmail.com' });
  assert.match(lastQuery.sql, /organization_id = :organizationId/); assert.match(lastQuery.sql, /status = 'active'/);
});
test('unverified, invalid, missing and ambiguous identities fail closed', async () => {
  lookups = 0; identity = { sub: 'u', email: 'buyer@gmail.com', email_verified: false };
  await assert.rejects(() => exchangeCustomerIdentity(body), { code: 'VERIFIED_EMAIL_REQUIRED' }); assert.equal(lookups, 0);
  identity = new Error('invalid signature'); await assert.rejects(() => exchangeCustomerIdentity(body), { code: 'INVALID_IDENTITY_TOKEN' });
  identity = { sub: 'u', email: 'buyer@gmail.com', email_verified: true };
  for (const rows of [[], [{ id: 9 }, { id: 10 }]]) { users = rows; await assert.rejects(() => exchangeCustomerIdentity(body), { code: 'CUSTOMER_NOT_FOUND' }); }
  env.GOOGLE_WEB_CLIENT_ID = ''; await assert.rejects(() => exchangeCustomerIdentity(body), { code: 'AUTH_NOT_CONFIGURED' });
});
