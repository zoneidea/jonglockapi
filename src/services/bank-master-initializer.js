const fs = require('node:fs');
const path = require('node:path');
const banks = require('../data/banks.th.json');

class BankMasterInitializer {
  async initialize(conn) {
    // Same schema as the migration; callable independently on a new host.
    await conn.query(fs.readFileSync(path.resolve(__dirname, '../../migrations/057_bank_master.sql'), 'utf8'));
    for (const [index, bank] of banks.entries()) {
      // Re-running migrations never overwrites an operator's name/status/order edits.
      await conn.execute(`INSERT IGNORE INTO master_banks
        (country_code, code, name_th, name_en, short_name, sort_order)
        VALUES ('TH', :code, :nameTh, :nameEn, :shortName, :sortOrder)`, { ...bank, sortOrder: index + 1 });
    }
  }
}
module.exports = { BankMasterInitializer };
