const { query } = require('../config/db');
const { AppError } = require('../utils/errors');
const mapBank = row => ({ code: row.code, countryCode: row.country_code, nameTh: row.name_th,
  nameEn: row.name_en, shortName: row.short_name });
async function listActiveBanks() {
  const rows = await query(`SELECT country_code, code, name_th, name_en, short_name FROM master_banks
    WHERE country_code = 'TH' AND status = 'active' ORDER BY sort_order, code`);
  return rows.map(mapBank);
}
async function findActiveBank(code) {
  if (!/^\d{3}$/.test(String(code || ''))) throw new AppError(400, 'กรุณาเลือกธนาคารจากรายการ', 'INVALID_BANK_CODE');
  const rows = await query(`SELECT country_code, code, name_th, name_en, short_name FROM master_banks
    WHERE country_code = 'TH' AND code = :code AND status = 'active' LIMIT 1`, { code });
  if (!rows[0]) throw new AppError(400, 'ธนาคารที่เลือกไม่พร้อมใช้งาน กรุณาเลือกจากรายการใหม่', 'INVALID_BANK_CODE');
  return mapBank(rows[0]);
}
module.exports = { listActiveBanks, findActiveBank };
