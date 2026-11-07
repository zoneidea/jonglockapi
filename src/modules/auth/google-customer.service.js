const { OAuth2Client } = require('google-auth-library');
const env = require('../../config/env');
const { query } = require('../../config/db');
const { blindIndex } = require('../../utils/crypto');
const { signToken } = require('../../middlewares/auth');
const { AppError } = require('../../utils/errors');
const client = new OAuth2Client();

async function verifiedGoogleIdentity(googleIdToken) {
  if (!env.GOOGLE_WEB_CLIENT_ID) throw new AppError(503, 'Google sign-in is not configured', 'AUTH_NOT_CONFIGURED');
  let identity;
  try {
    const ticket = await client.verifyIdToken({ idToken: googleIdToken, audience: env.GOOGLE_WEB_CLIENT_ID });
    identity = ticket.getPayload();
  } catch (_error) { throw new AppError(401, 'Please sign in again', 'INVALID_IDENTITY_TOKEN'); }
  if (!identity?.sub || !identity.email || identity.email_verified !== true) {
    throw new AppError(403, 'A verified Google email is required', 'VERIFIED_EMAIL_REQUIRED');
  }
  return { ...identity, email: identity.email.trim().toLowerCase() };
}

// Email from storage identifies the account in the UI. Signed Google claims prove ownership.
async function exchangeCustomerIdentity({ googleIdToken, organizationId }) {
  const identity = await verifiedGoogleIdentity(googleIdToken);
  if (!identity.email.endsWith('@gmail.com') && !identity.hd) {
    throw new AppError(403, 'A verified Gmail or Workspace account is required', 'VERIFIED_EMAIL_REQUIRED');
  }
  const email = identity.email.trim().toLowerCase();
  const users = await query(`SELECT id FROM mobile_users
    WHERE organization_id = :organizationId AND email_hash = :emailHash AND status = 'active' LIMIT 2`,
  { organizationId, emailHash: blindIndex(email) });
  if (users.length !== 1) throw new AppError(403, 'Customer account not found in this organization', 'CUSTOMER_NOT_FOUND');
  return {
    token: signToken({ sub: users[0].id, userType: 'customer', role: 'customer', organizationId, marketIds: [] }, { expiresIn: '15m' }),
    expiresIn: 900, user: { id: users[0].id, organizationId, email },
  };
}
module.exports = { exchangeCustomerIdentity, verifiedGoogleIdentity };
