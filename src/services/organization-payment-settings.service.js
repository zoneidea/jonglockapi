const { randomUUID } = require('node:crypto');
const { query, transaction } = require('../config/db');
const { encryptField, decryptField, blindIndex } = require('../utils/crypto');
const { AppError } = require('../utils/errors');
const gateway = require('./reservepay.service');
const { activity } = require('./payment-activity.service');

const fields = 'mode, sync_state, details_enc, recipient_details_enc, contact_id, bank_account_id, generation, source_market_id, migration_conflict, last_error_code';
const decode = (row) => row?.details_enc ? JSON.parse(decryptField(row.details_enc)) : {};
async function getSettings(organizationId) {
  const rows = await query(`SELECT ${fields} FROM organization_payment_settings WHERE organization_id = :organizationId`, { organizationId });
  if (!rows.length) {
    await new (require('./organization-payment-settings-initializer').OrganizationPaymentSettingsInitializer)()
      .initializeOrganization({ execute: async (sql, params) => [await query(sql, params)] }, organizationId);
    return getSettings(organizationId);
  }
  const row = rows[0];
  const candidates = row.migration_conflict ? await migrationCandidates(organizationId) : [];
  return { scope: 'organization', migrationConflict: Boolean(row.migration_conflict), candidates, mode: row?.mode || 'manual', syncState: row?.sync_state || 'inactive',
    details: decode(row), recipientDetails: row?.recipient_details_enc ? JSON.parse(decryptField(row.recipient_details_enc)) : {}, contactId: row?.contact_id || null, bankAccountId: row?.bank_account_id || null,
    errorCode: row?.last_error_code || null };
}
async function assertGatewayAllowed(conn, organizationId) {
  const [rows] = await conn.execute(`SELECT mode, sync_state FROM organization_payment_settings
    WHERE organization_id = :organizationId FOR UPDATE`, { organizationId });
  if (!rows.length || (rows[0].mode === 'manual' || ['syncing', 'error'].includes(rows[0].sync_state)
    || (rows[0].mode === 'gateway' && rows[0].sync_state !== 'ready'))) {
    throw new AppError(409, 'องค์กรยังไม่พร้อมรับชำระผ่าน Payment Gateway', 'ORGANIZATION_GATEWAY_DISABLED');
  }
}
async function claim(organizationId, { allowConflict = false } = {}) {
  const settings = await getSettings(organizationId);
  if (settings.migrationConflict && !allowConflict) throw new AppError(409, 'กรุณาเลือกการตั้งค่ารายตลาดเดิมที่จะใช้ร่วมกันทั้งองค์กรก่อน', 'PAYMENT_SETTINGS_MIGRATION_REQUIRED');
  const token = randomUUID();
  await transaction(async (conn) => {
    await conn.execute(`INSERT IGNORE INTO organization_payment_settings (organization_id) VALUES (:organizationId)`, { organizationId });
    const [result] = await conn.execute(`UPDATE organization_payment_settings SET lease_token = :token,
      lease_until = DATE_ADD(NOW(), INTERVAL 120 SECOND), sync_state = 'syncing'
      WHERE organization_id = :organizationId AND (lease_until IS NULL OR lease_until < NOW())`, { organizationId, token });
    if (!result.affectedRows) throw new AppError(409, 'กำลังบันทึกการตั้งค่า กรุณาลองใหม่สักครู่', 'SETTINGS_BUSY');
    // Legacy booking/debt statuses do not prove that a gateway payment is in flight.
    // Keep unresolved attempts protected, including unknown/review and older merchants.
    const [active] = await conn.execute(`SELECT id FROM payment_attempts
      WHERE organization_id = :organizationId AND provider = 'reservepay'
        AND state IN ('creating','pending','unknown','review') LIMIT 1`, { organizationId });
    if (active.length) throw new AppError(409, 'มีรายการรอผลชำระเงิน กรุณารอให้สิ้นสุดก่อนเปลี่ยนช่องทางหรือบัญชีรับเงิน', 'PAYMENT_IN_PROGRESS');
  });
  const rows = await query(`SELECT ${fields} FROM organization_payment_settings WHERE organization_id = :organizationId`, { organizationId });
  return { ...rows[0], token };
}
async function checkpoint(scope, values) {
  const result = await query(`UPDATE organization_payment_settings SET details_enc = :details, contact_id = :contactId,
    bank_account_id = :bankAccountId WHERE organization_id = :organizationId AND lease_token = :token`, { ...scope, ...values });
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
async function saveSettings(organizationId, body) {
  const row = await claim(organizationId);
  const scope = { organizationId, token: row.token };
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
      await query(`UPDATE organization_payment_settings SET recipient_details_enc = :encrypted
        WHERE organization_id = :organizationId AND lease_token = :token`, { ...scope, encrypted });
      const result = await syncRecipient(gateway.callMerchantApi, {
        externalId: row.source_market_id ? `jl-market-${organizationId}-${row.source_market_id}-${row.generation}` : `jl-org-${organizationId}-${row.generation}`, contactId, bankAccountId,
        previous: decode(row), details: { ...details, saveContact: async (contact) => {
          contactId = contact;
          // Keep the last completed settings until registration succeeds; retries reuse the saved contact.
          await checkpoint(scope, { details: row.details_enc, contactId, bankAccountId });
        } },
      });
      contactId = result.contactId; bankAccountId = result.bankAccountId;
    }
    await checkpoint(scope, { details: encrypted, contactId, bankAccountId });
    await query(`UPDATE organization_payment_settings SET mode = :mode, sync_state = :state,
      last_error_code = NULL, lease_token = NULL, lease_until = NULL
      WHERE organization_id = :organizationId AND lease_token = :token`,
    { ...scope, mode: body.mode, state: body.mode === 'gateway' ? 'ready' : 'inactive' });
    await activity('organization_payment_settings_saved', { organizationId, code: body.mode });
    return getSettings(organizationId);
  } catch (error) { await releaseError(scope, error); throw error; }
}
async function releaseError(scope, error) {
  await query(`UPDATE organization_payment_settings SET sync_state = 'error', lease_token = NULL, lease_until = NULL,
    last_error_code = :code WHERE organization_id = :organizationId AND lease_token = :token`,
  { ...scope, code: error.providerCode || error.code || 'SYNC_FAILED' });
  await activity('organization_payment_settings_failed', { organizationId: scope.organizationId, code: error.providerCode || error.code || 'SYNC_FAILED', status: 502 });
}
async function disableGateway(organizationId) {
  const row = await claim(organizationId);
  const scope = { organizationId, token: row.token };
  try {
    if (row.contact_id) {
      try {
        const removed = await gateway.callMerchantApi('remove-contact', { contact_id: row.contact_id });
        if (removed !== true) throw new AppError(502, 'ยังยืนยันการยกเลิกกับ ReservePay ไม่ได้ กรุณาลองใหม่', 'PROVIDER_INVALID_RESPONSE');
      }
      catch (error) { if (error.providerCode !== 'NOT_FOUND') throw error; }
    }
    await query(`UPDATE organization_payment_settings SET mode = 'manual', sync_state = 'inactive', contact_id = NULL,
      bank_account_id = NULL, details_enc = NULL, generation = generation + 1, source_market_id = NULL, last_error_code = NULL,
      lease_token = NULL, lease_until = NULL WHERE organization_id = :organizationId AND lease_token = :token`, scope);
    await activity('organization_gateway_disabled', { organizationId });
    return getSettings(organizationId);
  } catch (error) { await releaseError(scope, error); throw error; }
}
async function paymentOptions(organizationId) {
  const rows = await query(`SELECT mode, details_enc, migration_conflict, sync_state FROM organization_payment_settings
    WHERE organization_id = :organizationId`, { organizationId });
  const row = rows[0];
  return { scope: 'organization', mode: row?.migration_conflict || (row?.mode === 'gateway' && row.sync_state !== 'ready') ? 'unavailable' : row?.mode || 'manual', details: row?.mode === 'manual' && !row.migration_conflict ? decode(row) : {} };
}
async function assertManualAllowed(conn, organizationId) {
  const [rows] = await conn.execute(`SELECT mode, migration_conflict, sync_state FROM organization_payment_settings WHERE organization_id = :organizationId FOR UPDATE`, { organizationId });
  if (rows[0]?.mode === 'gateway' || rows[0]?.migration_conflict || rows[0]?.sync_state === 'syncing') throw new AppError(409, 'องค์กรรับชำระผ่าน Payment Gateway เท่านั้น', 'ORGANIZATION_MANUAL_PAYMENT_DISABLED');
}
async function migrationCandidates(organizationId) {
  const rows = await query(`SELECT s.*, m.name AS market_name FROM market_payment_settings s
    JOIN markets m ON m.organization_id = s.organization_id AND m.id = s.market_id
    WHERE s.organization_id = :organizationId AND
      (s.mode <> 'legacy' OR s.contact_id IS NOT NULL OR s.details_enc IS NOT NULL OR s.recipient_details_enc IS NOT NULL)
    ORDER BY s.market_id`, { organizationId });
  return rows.map(row => {
    const details = decode(row);
    const recipient = row.recipient_details_enc ? JSON.parse(decryptField(row.recipient_details_enc)) : {};
    return { marketId: row.market_id, marketName: row.market_name, mode: row.mode,
      accountLast4: String((row.mode === 'gateway' ? recipient : details).accountNumber || '').slice(-4) };
  });
}
async function adoptMarketSettings(organizationId, marketId) {
  const row = await claim(organizationId, { allowConflict: true });
  const scope = { organizationId, token: row.token };
  try {
    if (!row.migration_conflict) throw new AppError(409, 'การตั้งค่าองค์กรถูกกำหนดไว้แล้ว กรุณาโหลดข้อมูลใหม่', 'SETTINGS_ALREADY_MIGRATED');
    const candidates = await query(`SELECT * FROM market_payment_settings WHERE organization_id = :organizationId
      AND market_id = :marketId`, { organizationId, marketId });
    const candidate = candidates[0];
    if (!candidate) throw new AppError(404, 'ไม่พบการตั้งค่าตลาดในองค์กรนี้', 'SETTINGS_NOT_FOUND');
    await query(`UPDATE organization_payment_settings SET mode = :mode, sync_state = :state,
      details_enc = :details, recipient_details_enc = :recipient, contact_id = :contactId,
      bank_account_id = :bankId, generation = :generation, source_market_id = :marketId,
      migration_conflict = 0, lease_token = NULL, lease_until = NULL, last_error_code = NULL
      WHERE organization_id = :organizationId AND lease_token = :token`,
    { ...scope, marketId, mode: candidate.mode, state: candidate.sync_state === 'syncing' ? 'error' : candidate.sync_state,
      details: candidate.details_enc, recipient: candidate.recipient_details_enc,
      contactId: candidate.contact_id, bankId: candidate.bank_account_id, generation: candidate.generation });
    await activity('organization_payment_settings_adopted', { organizationId });
    return getSettings(organizationId);
  } catch (error) { await releaseError(scope, error); throw error; }
}
module.exports = { adoptMarketSettings, paymentOptions, assertManualAllowed, getSettings, saveSettings, disableGateway, assertGatewayAllowed, syncRecipient };
