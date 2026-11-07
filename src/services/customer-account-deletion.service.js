const fs = require('node:fs/promises');
const path = require('node:path');
const { randomBytes, randomUUID } = require('node:crypto');
const { transaction } = require('../config/db');
const { blindIndex } = require('../utils/crypto');
const { AppError } = require('../utils/errors');
const { logger } = require('../config/logger');
const { getFirebaseAuth, getFirebaseFirestore } = require('./firebase-admin.service');

function profileFiles(profile) {
  let gallery = [];
  try { gallery = JSON.parse(profile.store_gallery_json || '[]'); } catch { /* no files */ }
  return [profile.avatar_url, profile.store_logo_url, ...(Array.isArray(gallery) ? gallery : [])]
    .filter(value => typeof value === 'string')
    .map(value => {
      if (!value.startsWith('/uploads/public-profiles/')) return null;
      try {
        const pathname = new URL(value, 'https://jonglock.invalid').pathname;
        const match = /^\/uploads\/public-profiles\/([a-zA-Z0-9_.-]+)$/.exec(pathname);
        return match && !['.', '..'].includes(match[1])
          ? path.resolve(__dirname, '../../uploads/public-profiles', match[1]) : null;
      } catch { return null; }
    }).filter(Boolean);
}

// Identity must already be verified server-side. Never accept an email-only deletion.
async function deleteCustomerAccount(identity) {
  const emailHash = blindIndex(identity.email);
  const firestore = getFirebaseFirestore();
  if (!firestore) throw new AppError(503, 'Account deletion is temporarily unavailable', 'ACCOUNT_DELETION_NOT_CONFIGURED');
  const result = await transaction(async conn => {
    const [profiles] = await conn.execute('SELECT * FROM public_user_profiles WHERE email_hash = :emailHash FOR UPDATE', { emailHash });
    const [users] = await conn.execute('SELECT id, organization_id FROM mobile_users WHERE email_hash = :emailHash ORDER BY organization_id, id FOR UPDATE', { emailHash });
    // Temporary locks contain the owner's email/name; remove them as well as SQL profile data.
    for (;;) {
      const snapshot = await firestore.collection('booth_temp_locks').where('ownerId', '==', identity.email).limit(400).get();
      if (snapshot.empty) break;
      const batch = firestore.batch();
      snapshot.docs.forEach(doc => batch.delete(doc.ref));
      await batch.commit();
    }
    const firebaseAuth = getFirebaseAuth();
    for (const profile of profiles) {
      if (profile.firebase_uid) {
        if (!firebaseAuth) throw new AppError(503, 'Account deletion is temporarily unavailable', 'ACCOUNT_DELETION_NOT_CONFIGURED');
        try { await firebaseAuth.deleteUser(profile.firebase_uid); }
        catch (error) { if (error.code !== 'auth/user-not-found') throw error; }
      }
      for (const filename of new Set(profileFiles(profile))) {
        const [shared] = await conn.execute(`SELECT id FROM public_user_profiles WHERE id <> :profileId
          AND (avatar_url LIKE :pattern OR store_logo_url LIKE :pattern OR store_gallery_json LIKE :pattern) LIMIT 1`,
        { profileId: profile.id, pattern: `%/${path.basename(filename)}%` });
        if (shared.length) continue;
        try { await fs.unlink(filename); } catch (error) { if (error.code !== 'ENOENT') throw error; }
      }
      await conn.execute('DELETE FROM mobile_device_tokens WHERE public_profile_id = :profileId', { profileId: profile.id });
    }
    for (const user of users) {
      const scope = { userId: user.id, organizationId: user.organization_id };
      await conn.execute('DELETE FROM mobile_device_tokens WHERE organization_id = :organizationId AND mobile_user_id = :userId', scope);
      await conn.execute('DELETE FROM mobile_notifications WHERE organization_id = :organizationId AND mobile_user_id = :userId', scope);
      await conn.execute('DELETE FROM notifications WHERE organization_id = :organizationId AND mobile_user_id = :userId', scope);
      // Keep relational IDs for booking/payment records, but remove identifying data and login credentials.
      await conn.execute(`UPDATE mobile_users SET status = 'deleted', username_hash = :usernameHash,
        password_hash = :passwordHash, username_enc = NULL, first_name_enc = NULL, last_name_enc = NULL,
        email_enc = NULL, email_hash = NULL, phone_enc = NULL, phone_hash = NULL,
        id_card_enc = NULL, id_card_hash = NULL, address_enc = NULL,
        accepted_consent_at = NULL, tenant_type_id = NULL
        WHERE organization_id = :organizationId AND id = :userId`,
      { ...scope, usernameHash: blindIndex(`deleted:${randomUUID()}`), passwordHash: randomBytes(48).toString('hex') });
    }
    await conn.execute('DELETE FROM public_user_profiles WHERE email_hash = :emailHash', { emailHash });
    return { deleted: true };
  });
  logger.info({ action: 'customer_account_deleted' }, 'Customer account deletion completed');
  return result;
}

module.exports = { deleteCustomerAccount };
