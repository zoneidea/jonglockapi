const { randomUUID } = require('node:crypto');
const { query, transaction } = require('../config/db');
const { encryptField, decryptField, blindIndex } = require('../utils/crypto');
const { AppError } = require('../utils/errors');
const gateway = require('./reservepay.service');
const { activity } = require('./payment-activity.service');

const fields = 'mode, sync_state, details_enc, recipient_details_enc, contact_id, bank_account_id, generation, last_error_code';
const decode = (row) => row?.details_enc ? JSON.parse(decryptField(row.details_enc)) : {};
async function getSettings(organizationId, marketId) {
  const markets = await query('SELECT id FROM markets WHERE organization_id = :organizationId AND id = :marketId AND deleted_at IS NULL', { organizationId, marketId });
  if (!markets.length) throw new AppError(404, 'ไม่พบตลาด', 'MARKET_NOT_FOUND');
  const rows = await query(`SELECT ${fields} FROM market_payment_settings WHERE organization_id = :organizationId AND market_id = :marketId`, { organizationId, marketId });
  const row = rows[0];
  return { mode: row?.mode || 'legacy', syncState: row?.sync_state || 'inactive',
    details: decode(row), recipientDetails: row?.recipient_details_enc ? JSON.parse(decryptField(row.recipient_details_enc)) : {}, contactId: row?.contact_id || null, bankAccountId: row?.bank_account_id || null,
    errorCode: row?.last_error_code || null };
}
async function assertGatewayAllowed(conn, organizationId, marketId) {
  const [rows] = await conn.execute(`SELECT mode, sync_state FROM market_payment_settings
    WHERE organization_id = :organizationId AND market_id = :marketId FOR UPDATE`, { organizationId, marketId });
  if (rows[0] && (rows[0].mode === 'manual' || ['syncing', 'error'].includes(rows[0].sync_state)
    || (rows[0].mode === 'gateway' && rows[0].sync_state !== 'ready'))) {
    throw new AppError(409, 'ตลาดยังไม่พร้อมรับชำระผ่าน Payment Gateway', 'MARKET_GATEWAY_DISABLED');
  }
}
async function claim(organizationId, marketId) {
  await getSettings(organizationId, marketId);
  const token = randomUUID();
  await transaction(async (conn) => {
    await conn.execute(`INSERT IGNORE INTO market_payment_settings (organization_id, market_id) VALUES (:organizationId, :marketId)`, { organizationId, marketId });
    const [result] = await conn.execute(`UPDATE market_payment_settings SET lease_token = :token,
      lease_until = DATE_ADD(NOW(), INTERVAL 120 SECOND), sync_state = 'syncing'
      WHERE organization_id = :organizationId AND market_id = :marketId AND (lease_until IS NULL OR lease_until < NOW())`, { organizationId, marketId, token });
    if (!result.affectedRows) throw new AppError(409, 'กำลังบันทึกการตั้งค่า กรุณาลองใหม่สักครู่', 'SETTINGS_BUSY');
    const [active] = await conn.execute(`SELECT id FROM bookings WHERE organization_id = :organizationId AND market_id = :marketId AND status = 'payment_processing' LIMIT 1`, { organizationId, marketId });
    if (active.length) throw new AppError(409, 'มีรายการรอผลชำระเงิน กรุณารอให้สิ้นสุดก่อนเปลี่ยนช่องทางหรือบัญชีรับเงิน', 'PAYMENT_IN_PROGRESS');
  });
  const rows = await query(`SELECT ${fields} FROM market_payment_settings WHERE organization_id = :organizationId AND market_id = :marketId`, { organizationId, marketId });
  return { ...rows[0], token };
}
async function checkpoint(scope, values) {
  const result = await query(`UPDATE market_payment_settings SET details_enc = :details, contact_id = :contactId,
    bank_account_id = :bankAccountId WHERE organization_id = :organizationId AND market_id = :marketId AND lease_token = :token`, { ...scope, ...values });
  if (!result.affectedRows) throw new AppError(409, 'การบันทึกหมดเวลา กรุณาลองใหม่', 'SETTINGS_LEASE_LOST');
}
async function syncRecipient(call, { externalId, contactId, bankAccountId, details, previous }) {
  let contact = contactId;
  if (!contact) {
    try { contact = (await call('retrieve-contact', { contact_id: externalId })).contact_id; }
    catch (error) {
      if (error.providerCode !== 'NOT_FOUND') throw error;
      try { contact = await call('add-contact', { external_id: externalId, contact_name: details.accountName,
        contact_email: details.email || undefined, contact_mobile: details.phone || undefined }); }
      catch (addError) {
        if (addError.providerCode !== 'CONFLICT') throw addError;
        contact = (await call('retrieve-contact', { contact_id: externalId })).contact_id;
      }
    }
  }
  if (typeof contact !== 'string' || !contact) throw new AppError(502, 'ข้อมูลผู้รับเงินจาก ReservePay ไม่ถูกต้อง', 'PROVIDER_INVALID_RESPONSE');
  // Checkpoint before the next remote operation so a timeout can safely resume.
  await details.saveContact(contact);
  const sameAccount = bankAccountId && previous?.bankCode === details.bankCode && previous?.accountNumber === details.accountNumber;
  let bank = bankAccountId;
  if (sameAccount) {
    if (previous.accountName !== details.accountName) throw new AppError(409, 'ยกเลิก Payment Gateway ก่อนลงทะเบียนบัญชีรับเงินใหม่', 'RECIPIENT_ALREADY_REGISTERED');
  } else {
    const externalBankId = `${externalId}-${blindIndex(`${details.bankCode}:${details.accountNumber}`).slice(0, 24)}`;
    try {
      const found = await call('find-bank-account', { bank_account_id: externalBankId });
      if (found.deleted_at || found.owner !== 'CONTACT') throw new AppError(409, 'กรุณาตรวจสอบบัญชีรับเงินกับ ReservePay', 'BANK_ACCOUNT_CONFLICT');
      bank = found.bank_account_id;
      if (!found.primary || found.bank_code !== details.bankCode || found.number !== details.accountNumber || found.name !== details.accountName) {
        throw new AppError(409, 'กรุณาตรวจสอบบัญชีหลักกับ ReservePay', 'BANK_ACCOUNT_CONFLICT');
      }
    } catch (error) {
      if (error.providerCode !== 'NOT_FOUND') throw error;
      bank = await call('link-bank-account', { contact_id: contact, bank_code: details.bankCode,
        number: details.accountNumber, name: details.accountName, country_code: 'TH', primary: true, external_id: externalBankId });
    }
  }
  if (typeof bank !== 'string' || !bank) throw new AppError(502, 'ข้อมูลบัญชีจาก ReservePay ไม่ถูกต้อง', 'PROVIDER_INVALID_RESPONSE');
  return { contactId: contact, bankAccountId: bank };
}
async function saveSettings(organizationId, marketId, body) {
  const row = await claim(organizationId, marketId);
  const scope = { organizationId, marketId, token: row.token };
  try {
    const saved = row.recipient_details_enc ? JSON.parse(decryptField(row.recipient_details_enc)) : decode(row);
    if (body.mode === 'gateway' && row.contact_id && ['bankCode', 'accountNumber', 'accountName', 'email', 'phone'].some(key => saved[key] !== body.details[key])) {
      throw new AppError(409, 'ยกเลิก Payment Gateway ก่อนลงทะเบียนบัญชีรับเงินใหม่', 'RECIPIENT_ALREADY_REGISTERED');
    }
    if (body.mode === 'manual' && row.contact_id) throw new AppError(409, 'กรุณากดยกเลิกใช้ Payment Gateway และยืนยันก่อน', 'GATEWAY_CANCELLATION_REQUIRED');
    const details = body.details;
    const encrypted = encryptField(JSON.stringify(details));
    let contactId = row.contact_id; let bankAccountId = row.bank_account_id;
    if (body.mode === 'gateway') {
      await query(`UPDATE market_payment_settings SET recipient_details_enc = :encrypted
        WHERE organization_id = :organizationId AND market_id = :marketId AND lease_token = :token`, { ...scope, encrypted });
      const result = await syncRecipient(gateway.callMerchantApi, {
        externalId: `jl-market-${organizationId}-${marketId}-${row.generation}`, contactId, bankAccountId,
        previous: decode(row), details: { ...details, saveContact: async (contact) => {
          contactId = contact;
          // Keep the last completed settings until registration succeeds; retries reuse the saved contact.
          await checkpoint(scope, { details: row.details_enc, contactId, bankAccountId });
        } },
      });
      contactId = result.contactId; bankAccountId = result.bankAccountId;
    }
    await checkpoint(scope, { details: encrypted, contactId, bankAccountId });
    await query(`UPDATE market_payment_settings SET mode = :mode, sync_state = :state,
      last_error_code = NULL, lease_token = NULL, lease_until = NULL
      WHERE organization_id = :organizationId AND market_id = :marketId AND lease_token = :token`,
    { ...scope, mode: body.mode, state: body.mode === 'gateway' ? 'ready' : 'inactive' });
    await activity('market_payment_settings_saved', { organizationId, code: body.mode });
    return getSettings(organizationId, marketId);
  } catch (error) { await releaseError(scope, error); throw error; }
}
async function releaseError(scope, error) {
  await query(`UPDATE market_payment_settings SET sync_state = 'error', lease_token = NULL, lease_until = NULL,
    last_error_code = :code WHERE organization_id = :organizationId AND market_id = :marketId AND lease_token = :token`,
  { ...scope, code: error.providerCode || error.code || 'SYNC_FAILED' });
  await activity('market_payment_settings_failed', { organizationId: scope.organizationId, code: error.providerCode || error.code || 'SYNC_FAILED', status: 502 });
}
async function disableGateway(organizationId, marketId) {
  const row = await claim(organizationId, marketId);
  const scope = { organizationId, marketId, token: row.token };
  try {
    if (row.contact_id) {
      try {
        const removed = await gateway.callMerchantApi('remove-contact', { contact_id: row.contact_id });
        if (removed !== true) throw new AppError(502, 'ยังยืนยันการยกเลิกกับ ReservePay ไม่ได้ กรุณาลองใหม่', 'PROVIDER_INVALID_RESPONSE');
      }
      catch (error) { if (error.providerCode !== 'NOT_FOUND') throw error; }
    }
    await query(`UPDATE market_payment_settings SET mode = 'manual', sync_state = 'inactive', contact_id = NULL,
      bank_account_id = NULL, details_enc = NULL, generation = generation + 1, last_error_code = NULL,
      lease_token = NULL, lease_until = NULL WHERE organization_id = :organizationId AND market_id = :marketId AND lease_token = :token`, scope);
    await activity('market_gateway_disabled', { organizationId });
    return getSettings(organizationId, marketId);
  } catch (error) { await releaseError(scope, error); throw error; }
}
async function paymentOptions(organizationId, marketId) {
  const rows = await query(`SELECT mode, details_enc FROM market_payment_settings
    WHERE organization_id = :organizationId AND market_id = :marketId`, { organizationId, marketId });
  const row = rows[0];
  return { mode: row?.mode || 'legacy', details: row?.mode === 'manual' ? decode(row) : {} };
}
async function assertManualAllowed(conn, organizationId, marketId) {
  const [rows] = await conn.execute(`SELECT mode FROM market_payment_settings WHERE organization_id = :organizationId AND market_id = :marketId FOR UPDATE`, { organizationId, marketId });
  if (rows[0]?.mode === 'gateway') throw new AppError(409, 'ตลาดรับชำระผ่าน Payment Gateway เท่านั้น', 'MARKET_MANUAL_PAYMENT_DISABLED');
}
module.exports = { paymentOptions, assertManualAllowed, getSettings, saveSettings, disableGateway, assertGatewayAllowed, syncRecipient };
