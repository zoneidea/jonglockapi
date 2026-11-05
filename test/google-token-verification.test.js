const test = require('node:test');
const assert = require('node:assert/strict');
const { generateKeyPairSync } = require('node:crypto');
const jwt = require('jsonwebtoken');
const { OAuth2Client } = require('google-auth-library');
const keys = generateKeyPairSync('rsa', { modulusLength: 2048 });
const original = OAuth2Client.prototype.getFederatedSignonCertsAsync;
// Only the public-key download is replaced. Signature, issuer, audience and expiry use the real library.
OAuth2Client.prototype.getFederatedSignonCertsAsync = async () => ({certs: {qa: keys.publicKey.export({type: 'spki', format: 'pem'})}});
function stub(file, exports) { const id = require.resolve(file); require.cache[id] = {id, filename: id, loaded: true, exports}; }
stub('../src/config/env', {GOOGLE_WEB_CLIENT_ID: 'qa-audience'});
stub('../src/config/db', {query: async (_sql, params) => params.organizationId === 7 ? [{id: 9}] : []});
stub('../src/utils/crypto', {blindIndex: value => value});
stub('../src/middlewares/auth', {signToken: claims => claims});
const {exchangeCustomerIdentity} = require('../src/modules/auth/google-customer.service');
function signed({audience = 'qa-audience', issuer = 'https://accounts.google.com', expiresIn = 3600, key = keys.privateKey} = {}) {
  return jwt.sign({sub: 'google-user', email: 'buyer@gmail.com', email_verified: true}, key, {algorithm: 'RS256', keyid: 'qa', audience, issuer, expiresIn});
}
test('real Google verifier rejects forged, wrong audience, wrong issuer and expired ID tokens', async () => {
  try {
    const accepted = await exchangeCustomerIdentity({googleIdToken: signed(), organizationId: 7});
    assert.equal(accepted.token.sub, 9);assert.equal(accepted.token.organizationId, 7);
    for (const token of [signed({audience: 'evil-app'}), signed({issuer: 'https://evil.example'}), signed({expiresIn: -3600}), signed({key: generateKeyPairSync('rsa', {modulusLength: 2048}).privateKey})]) {
      await assert.rejects(() => exchangeCustomerIdentity({googleIdToken: token, organizationId: 7}), {code: 'INVALID_IDENTITY_TOKEN'});
    }
    await assert.rejects(() => exchangeCustomerIdentity({googleIdToken: signed(), organizationId: 8}), {code: 'CUSTOMER_NOT_FOUND'});
  } finally {OAuth2Client.prototype.getFederatedSignonCertsAsync = original;}
});
