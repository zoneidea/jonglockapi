const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { logger } = require('../config/logger');
const { encryptField, blindIndex } = require('../utils/crypto');
const { isStrongPassword, PASSWORD_POLICY_MESSAGE } = require('../utils/password-policy');

async function main() {
  const orgCode = process.env.SEED_ORG_CODE || 'ORG001';
  const orgName = process.env.SEED_ORG_NAME || 'Default Organization';
  const username = process.env.SEED_ADMIN_USERNAME;
  const password = process.env.SEED_ADMIN_PASSWORD;
  const name = process.env.SEED_ADMIN_NAME || 'Supervisor';
  const email = process.env.SEED_ADMIN_EMAIL || '';
  const phone = process.env.SEED_ADMIN_PHONE || '';

  if (!username || !password) {
    throw new Error('SEED_ADMIN_USERNAME and SEED_ADMIN_PASSWORD are required');
  }
  if (!isStrongPassword(password)) {
    throw new Error(PASSWORD_POLICY_MESSAGE);
  }

  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    await connection.execute(
      `INSERT INTO organizations (code, name, status)
       VALUES (:code, :name, 'active')
       ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'active'`,
      { code: orgCode, name: orgName },
    );

    const [orgRows] = await connection.execute(`SELECT id FROM organizations WHERE code = :code LIMIT 1`, { code: orgCode });
    const organizationId = orgRows[0].id;

    await connection.execute(
      `INSERT INTO admin_users (
        organization_id, username_hash, password_hash, role,
        name_enc, email_enc, email_hash, phone_enc, phone_hash, status
      ) VALUES (
        :organizationId, :usernameHash, :passwordHash, 'supervisor',
        :nameEnc, :emailEnc, :emailHash, :phoneEnc, :phoneHash, 'active'
      )
      ON DUPLICATE KEY UPDATE
        password_hash = VALUES(password_hash),
        role = 'supervisor',
        name_enc = VALUES(name_enc),
        email_enc = VALUES(email_enc),
        email_hash = VALUES(email_hash),
        phone_enc = VALUES(phone_enc),
        phone_hash = VALUES(phone_hash),
        status = 'active'`,
      {
        organizationId,
        usernameHash: blindIndex(username),
        passwordHash: await bcrypt.hash(password, 12),
        nameEnc: encryptField(name),
        emailEnc: encryptField(email),
        emailHash: blindIndex(email),
        phoneEnc: encryptField(phone),
        phoneHash: blindIndex(phone),
      },
    );

    await connection.commit();
    logger.info({ organizationId, username }, 'Supervisor seed completed');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Supervisor seed failed');
  process.exit(1);
});
