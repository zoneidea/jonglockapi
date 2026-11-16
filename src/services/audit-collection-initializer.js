const fs = require('node:fs');
const path = require('node:path');

class AuditCollectionInitializer {
  async initialize(conn) {
    await conn.query(fs.readFileSync(path.resolve(__dirname, '../../migrations/060_audit_collections.sql'), 'utf8'));
  }
}
module.exports = { AuditCollectionInitializer };
