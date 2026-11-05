const { encryptField } = require('../utils/crypto');
const { AppError } = require('../utils/errors');

// Re-runnable initialization, also used for organizations created after migration.
class OrganizationPaymentSettingsInitializer {
  async initializeOrganization(conn, organizationId) {
    const [rows] = await conn.execute(`SELECT id, payment_promptpay_id, payment_bank_name,
      payment_bank_account_name, payment_bank_account_no, payment_qrcode_image_url, payment_instructions
      FROM organizations WHERE id = :organizationId`, { organizationId });
    if (!rows[0]) throw new AppError(404, 'ไม่พบองค์กร', 'ORGANIZATION_NOT_FOUND');
    const org = rows[0];
    const details = { bankName: org.payment_bank_name || '', accountName: org.payment_bank_account_name || '',
      accountNumber: org.payment_bank_account_no || '', promptpayId: org.payment_promptpay_id || '',
      qrCodeImageUrl: org.payment_qrcode_image_url || '', instructions: org.payment_instructions || '' };
    await conn.execute(`INSERT IGNORE INTO organization_payment_settings (organization_id, mode, details_enc)
      VALUES (:organizationId, 'manual', :details)`, { organizationId, details: encryptField(JSON.stringify(details)) });
  }
  async initialize(conn) {
    const [rows] = await conn.execute(`SELECT o.id FROM organizations o
      LEFT JOIN organization_payment_settings ps ON ps.organization_id = o.id WHERE ps.organization_id IS NULL`);
    for (const org of rows) await this.initializeOrganization(conn, org.id);
  }
}
module.exports = { OrganizationPaymentSettingsInitializer };
