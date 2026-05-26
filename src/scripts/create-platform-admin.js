const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { logger } = require('../config/logger');
const { encryptField, blindIndex } = require('../utils/crypto');
const { isStrongPassword, PASSWORD_POLICY_MESSAGE } = require('../utils/password-policy');

async function main() {
  const username = process.env.PLATFORM_ADMIN_USERNAME;
  const password = process.env.PLATFORM_ADMIN_PASSWORD;
  const name = process.env.PLATFORM_ADMIN_NAME || 'Platform Superadmin';
  const email = process.env.PLATFORM_ADMIN_EMAIL || '';
  const role = process.env.PLATFORM_ADMIN_ROLE || 'platform_superadmin';

  if (!username || !password) {
    throw new Error('PLATFORM_ADMIN_USERNAME and PLATFORM_ADMIN_PASSWORD are required');
  }
  if (!isStrongPassword(password)) {
    throw new Error(PASSWORD_POLICY_MESSAGE);
  }

  const passwordHash = await bcrypt.hash(password, 12);
  const connection = await pool.getConnection();

  try {
    await connection.beginTransaction();
    await connection.execute(
      `INSERT INTO platform_users (
        username_hash, password_hash, role, name_enc, email_enc, email_hash, status
      ) VALUES (
        :usernameHash, :passwordHash, :role, :nameEnc, :emailEnc, :emailHash, 'active'
      )
      ON DUPLICATE KEY UPDATE
        password_hash = VALUES(password_hash),
        role = VALUES(role),
        name_enc = VALUES(name_enc),
        email_enc = VALUES(email_enc),
        email_hash = VALUES(email_hash),
        status = 'active'`,
      {
        usernameHash: blindIndex(username),
        passwordHash,
        role,
        nameEnc: encryptField(name),
        emailEnc: encryptField(email),
        emailHash: blindIndex(email),
      },
    );

    await connection.commit();
    logger.info({ username, role }, 'Platform admin seed completed');
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Platform admin seed failed');
  process.exit(1);
});
