const fs = require('fs/promises');
const path = require('path');
const { pool } = require('../config/db');
const { logger } = require('../config/logger');

async function ensureMigrationsTable(connection) {
  await connection.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      id INT AUTO_INCREMENT PRIMARY KEY,
      filename VARCHAR(255) NOT NULL UNIQUE,
      applied_at TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci
  `);
}

function splitSql(sql) {
  return sql
    .split(/;\s*$/m)
    .map((statement) => statement.trim())
    .filter(Boolean);
}

async function migrate() {
  const migrationsDir = path.resolve(__dirname, '../../migrations');
  const files = (await fs.readdir(migrationsDir)).filter((file) => file.endsWith('.sql')).sort();
  const connection = await pool.getConnection();

  try {
    await ensureMigrationsTable(connection);
    const [appliedRows] = await connection.query(`SELECT filename FROM schema_migrations`);
    const applied = new Set(appliedRows.map((row) => row.filename));

    for (const file of files) {
      if (applied.has(file)) continue;

      logger.info({ file }, 'Applying migration');
      const sql = await fs.readFile(path.join(migrationsDir, file), 'utf8');
      await connection.beginTransaction();
      try {
        for (const statement of splitSql(sql)) {
          await connection.query(statement);
        }
        await connection.query(`INSERT INTO schema_migrations (filename) VALUES (?)`, [file]);
        await connection.commit();
      } catch (error) {
        await connection.rollback();
        throw error;
      }
    }

    logger.info('Migrations completed');
  } finally {
    connection.release();
    await pool.end();
  }
}

migrate().catch((error) => {
  logger.error({ error }, 'Migration failed');
  process.exit(1);
});
