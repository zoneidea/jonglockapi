const bcrypt = require('bcryptjs');
const { conflict } = require('./errors');

async function assertAdminCredentialPairAvailable({
  query,
  usernameHash,
  password,
  excludeAdminUserId = null,
}) {
  const rows = await query(
    `SELECT id, password_hash
     FROM admin_users
     WHERE username_hash = :usernameHash
       AND (:excludeAdminUserId IS NULL OR id <> :excludeAdminUserId)
     ORDER BY id`,
    { usernameHash, excludeAdminUserId },
  );

  for (const row of rows) {
    if (await bcrypt.compare(password, row.password_hash)) {
      throw conflict('ไม่สามารถใช้ Username และ Password นี้ได้');
    }
  }
}

module.exports = { assertAdminCredentialPairAvailable };
