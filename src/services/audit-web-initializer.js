const fs = require('node:fs');
const path = require('node:path');
class AuditWebInitializer {
  async initialize(conn) {
    const sql = fs.readFileSync(path.resolve(__dirname, '../../migrations/061_audit_web_merchants.sql'), 'utf8');
    await conn.query(sql.split(';')[0]);
    const [columns] = await conn.query("SELECT COLUMN_NAME FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'audit_collections'");
    const names = new Set(columns.map(row => row.COLUMN_NAME));
    if (!names.has('payment_method')) await conn.query("ALTER TABLE audit_collections ADD COLUMN payment_method ENUM('cash','promptpay') NOT NULL DEFAULT 'promptpay'");
    if (!names.has('merchant_id')) await conn.query('ALTER TABLE audit_collections ADD COLUMN merchant_id BIGINT UNSIGNED NULL, ADD CONSTRAINT fk_audit_collection_merchant FOREIGN KEY (merchant_id) REFERENCES audit_merchants(id)');
  }
}
module.exports = {AuditWebInitializer};
