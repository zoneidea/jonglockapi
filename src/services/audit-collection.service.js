const { randomUUID, createHash } = require('node:crypto');
const generatePayload = require('promptpay-qr');
const { query, transaction } = require('../config/db');
const { encryptField, decryptField } = require('../utils/crypto');
const { AppError, badRequest, notFound, conflict, forbidden } = require('../utils/errors');
const { calculateVatBreakdown, getOrganizationVatSettings, isVatEnabled, vatRate } = require('../utils/vat');
const { assertManualAllowed } = require('./organization-payment-settings.service');

const columns = `c.id, c.organization_id, c.market_id, c.created_by_admin_id, c.audit_check_id, c.payment_id, c.payment_method, c.merchant_id,
  c.public_id, c.idempotency_key, c.request_hash, c.customer_reference_enc, c.note_enc, c.lines_json,
  c.subtotal_amount, c.vat_amount, c.total_amount, c.qr_payload_enc, c.qr_image_url_enc, c.status,
  c.proof_mime, c.proof_uploaded_at, c.paid_at, (c.proof_enc IS NOT NULL) AS has_proof`;
const execute = async (conn, sql, params) => (await conn.execute(sql, params))[0];
function assertAccess(auth, marketId) {
  if (!auth.marketIds?.includes(Number(marketId)) && !['supervisor', 'accounting'].includes(auth.role)) throw forbidden('Market is not assigned to this account');
}
async function market(conn, auth, marketId, self = false) {
  assertAccess(auth, marketId);
  const rows = await execute(conn, `SELECT id, name, collection_mode FROM markets WHERE id = :marketId
    AND organization_id = :organizationId AND status = 'active' AND deleted_at IS NULL FOR UPDATE`, { marketId, organizationId: auth.organizationId });
  if (!rows.length || (self && rows[0].collection_mode !== 'self')) throw notFound('Collection market not found');
  return rows[0];
}
async function paymentConfiguration(conn, organizationId) {
  const settings = await execute(conn, `SELECT mode, details_enc, migration_conflict, sync_state FROM organization_payment_settings
    WHERE organization_id = :organizationId`, { organizationId });
  const setting = settings[0];
  if (setting?.mode === 'gateway' || setting?.migration_conflict || ['syncing', 'error'].includes(setting?.sync_state)) return null;
  let details = setting?.mode === 'manual' && setting.details_enc ? JSON.parse(decryptField(setting.details_enc)) : null;
  if (!details) {
    const org = await execute(conn, `SELECT payment_promptpay_id, payment_qrcode_image_url FROM organizations WHERE id = :organizationId`, { organizationId });
    details = { promptpayId: org[0]?.payment_promptpay_id, qrCodeImageUrl: org[0]?.payment_qrcode_image_url };
  }
  const image = typeof details.qrCodeImageUrl === 'string' && details.qrCodeImageUrl.startsWith('https://') ? details.qrCodeImageUrl : null;
  const target = String(details.promptpayId || '').replace(/[\s-]/g, '');
  return {image, target: /^(0\d{9}|\d{13}|\d{15})$/.test(target) ? target : null};
}
async function qrSnapshot(conn, organizationId, amount) {
  await assertManualAllowed(conn, organizationId);
  const configuration = await paymentConfiguration(conn, organizationId);
  if (configuration?.image) return {qrPayload: null, qrImageUrl: configuration.image};
  if (configuration?.target) return {qrPayload: generatePayload(configuration.target, {amount}), qrImageUrl: null};
  throw new AppError(409, 'กรุณาตั้งค่า PromptPay หรือ QR รับเงินขององค์กรก่อน', 'COLLECTION_PAYMENT_NOT_CONFIGURED');
}
async function load(conn, auth, id, lock = false) {
  if (lock) {
    const debt = await execute(conn, `SELECT audit_check_id, market_id FROM audit_collections
      WHERE id = :id AND organization_id = :organizationId`, {id, organizationId: auth.organizationId});
    if (!debt[0]) throw notFound('Collection not found');
    assertAccess(auth, debt[0].market_id);
    if (debt[0].audit_check_id) await execute(conn, `SELECT id FROM audit_checks WHERE id = :id
      AND organization_id = :organizationId FOR UPDATE`, {id: debt[0].audit_check_id, organizationId: auth.organizationId});
  }
  const rows = await execute(conn, `SELECT ${columns}, ac.fine_payment_status,
    p.status AS payment_status, p.paid_at AS payment_paid_at, p.proof_image_url
    FROM audit_collections c
    LEFT JOIN audit_checks ac ON ac.id = c.audit_check_id AND ac.organization_id = c.organization_id
    LEFT JOIN payments p ON p.id = c.payment_id AND p.organization_id = c.organization_id
    WHERE c.id = :id AND c.organization_id = :organizationId ${lock ? 'FOR UPDATE' : ''}`, { id, organizationId: auth.organizationId });
  if (!rows[0]) throw notFound('Collection not found');
  assertAccess(auth, rows[0].market_id);
  return rows[0];
}
function serialize(row, management = false) {
  const paid = row.status === 'paid' || row.fine_payment_status === 'paid' || row.payment_status === 'paid';
  const cancelled = row.audit_check_id && ['none', 'cancelled'].includes(row.fine_payment_status);
  const status = paid ? 'paid' : cancelled ? 'cancelled' : row.payment_status === 'waiting' || row.fine_payment_status === 'waiting' ? 'processing' : row.status;
  return {
    id: Number(row.id), reference: row.public_id, marketId: Number(row.market_id),
    amount: Number(row.total_amount), vatAmount: Number(row.vat_amount), status,
    paymentMethod: row.payment_method || 'promptpay', merchantId: row.merchant_id ? Number(row.merchant_id) : null,
    qrType: row.payment_method === 'cash' ? null : row.qr_image_url_enc ? 'image' : row.qr_payload_enc ? 'promptpay' : null,
    qrPayload: status === 'pending' ? decryptField(row.qr_payload_enc) : undefined,
    qrImageUrl: status === 'pending' ? decryptField(row.qr_image_url_enc) : undefined,
    expiresAt: null, paidAt: row.paid_at || row.payment_paid_at || null,
    proofUploadedAt: row.proof_uploaded_at || null,
    ...(management ? { customerReference: decryptField(row.customer_reference_enc), note: decryptField(row.note_enc),
      lines: typeof row.lines_json === 'string' ? JSON.parse(row.lines_json) : row.lines_json } : {}),
  };
}
async function markets(auth) {
  const rows = await query(`SELECT id, name, collection_mode FROM markets WHERE organization_id = :organizationId
    AND status = 'active' AND deleted_at IS NULL ORDER BY name`, { organizationId: auth.organizationId });
  return { markets: rows.filter(row => auth.marketIds?.includes(Number(row.id))).map(row => ({ id: Number(row.id), name: row.name, collectionMode: row.collection_mode })) };
}
async function catalog(auth, marketId) {
  return transaction(async conn => {
    await market(conn, auth, marketId, true);
    const rows = await execute(conn, `SELECT id, name, price FROM accessories WHERE organization_id = :organizationId
      AND market_id = :marketId AND status = 'active' ORDER BY name`, { organizationId: auth.organizationId, marketId });
    const vat = await getOrganizationVatSettings(conn, auth.organizationId);
    const configuration = await paymentConfiguration(conn, auth.organizationId);
    return { paymentOptions: {paymentMethods: ['cash', ...(configuration?.image || configuration?.target ? ['promptpay'] : [])], qrType: configuration?.image ? 'image' : configuration?.target ? 'promptpay' : null}, marketId, items: rows.map(row => ({ id: Number(row.id), name: row.name, unit: 'หน่วย', price: Number(row.price) })),
      vat: { enabled: isVatEnabled(vat), rate: vatRate(vat) } };
  });
}
function assertCashAmount(expectedAmount, total) {
  if (!Number.isFinite(expectedAmount) || expectedAmount <= 0
    || Math.abs(expectedAmount * 100 - Math.round(expectedAmount * 100)) > 0.000001
    || Math.round(expectedAmount * 100) !== Math.round(Number(total) * 100)) {
    throw new AppError(409, 'ยอดเรียกเก็บเปลี่ยนแปลง กรุณาตรวจยอดและยืนยันเงินสดอีกครั้ง', 'COLLECTION_TOTAL_CHANGED');
  }
}
async function settleCash(conn, auth, id, expectedAmount) {
  const row = await load(conn, auth, id, true);
  if (serialize(row).status === 'paid') return serialize(row);
  if (serialize(row).status !== 'pending' || row.has_proof || row.payment_status === 'waiting'
    || (row.audit_check_id && row.fine_payment_status !== 'pending')) {
    throw new AppError(409, 'รายการนี้ไม่สามารถเปลี่ยนเป็นเงินสดได้', 'COLLECTION_NOT_PAYABLE');
  }
  assertCashAmount(expectedAmount, row.total_amount);
  const payment = await execute(conn, `INSERT INTO payments (organization_id, public_id, audit_check_id, provider, provider_reference,
    status, amount, paid_at, verified_by_admin_id, verified_at, raw_response_json)
    VALUES (:organizationId, :reference, :checkId, 'manual', 'CASH', 'paid', :amount, NOW(), :actor, NOW(), :metadata)`,
  {organizationId: auth.organizationId, reference: `ACP-${randomUUID()}`, checkId: row.audit_check_id || null,
    amount: row.total_amount, actor: auth.sub, metadata: JSON.stringify({paymentMethod: 'cash', collectedByAdminId: auth.sub})});
  if (row.audit_check_id) await execute(conn, `UPDATE audit_checks SET fine_payment_status = 'paid' WHERE id = :id AND organization_id = :organizationId`, {id: row.audit_check_id, organizationId: auth.organizationId});
  await execute(conn, `UPDATE audit_collections SET status = 'paid', payment_method = 'cash', payment_id = :paymentId,
    qr_payload_enc = NULL, qr_image_url_enc = NULL, reviewed_by_admin_id = :actor, paid_at = NOW()
    WHERE id = :id AND organization_id = :organizationId`,
  {id, paymentId: payment.insertId, actor: auth.sub, organizationId: auth.organizationId});
  return serialize(await load(conn, auth, id));
}
async function create(auth, input, key) {
  const paymentMethod = input.paymentMethod || input.draft?.paymentMethod || 'promptpay';
  if (!['cash', 'promptpay'].includes(paymentMethod)) throw badRequest('Invalid payment method');
  if (paymentMethod === 'cash' && input.expectedAmount === undefined) throw badRequest('กรุณายืนยันยอดเงินสดที่ได้รับก่อนบันทึก');
  const hash = createHash('sha256').update(JSON.stringify(input)).digest('hex');
  return require('./audit-collection-request.service').run(auth, key, hash, async (conn, completedId) => {
    if (completedId) return serialize(await load(conn, auth, completedId));
    const existing = await execute(conn, `SELECT id, request_hash FROM audit_collections
      WHERE organization_id = :organizationId AND created_by_admin_id = :actor AND idempotency_key = :key FOR UPDATE`, { organizationId: auth.organizationId, actor: auth.sub, key });
    if (existing.length) {
      if (existing[0].request_hash !== hash) throw conflict('Idempotency key was used for another request');
      return serialize(await load(conn, auth, existing[0].id));
    }
    let check;
    if (input.kind === 'audit') {
      const checks = await execute(conn, `SELECT id, market_id, fine_payment_status, total_fine_amount, vat_amount
        FROM audit_checks WHERE id = :id AND organization_id = :organizationId FOR UPDATE`, { id: input.auditCheckId, organizationId: auth.organizationId });
      check = checks[0];
      if (!check) throw notFound('Audit check not found');
    }
    const marketId = check ? Number(check.market_id) : input.draft.marketId;
    await market(conn, auth, marketId, !check);
    if (check) {
      const previous = await execute(conn, `SELECT id FROM audit_collections WHERE audit_check_id = :id
        AND organization_id = :organizationId FOR UPDATE`, { id: check.id, organizationId: auth.organizationId });
      if (previous.length) return paymentMethod === 'cash'
        ? settleCash(conn, auth, previous[0].id, input.expectedAmount)
        : serialize(await load(conn, auth, previous[0].id));
      if (paymentMethod === 'cash' && check.fine_payment_status === 'waiting') throw conflict('รายการนี้มีหลักฐานรอตรวจสอบแล้ว');
      if (!['pending', 'waiting'].includes(check.fine_payment_status)) throw new AppError(409, 'รายการนี้ชำระแล้วหรือไม่สามารถเรียกเก็บได้', 'COLLECTION_NOT_PAYABLE');
    }
    let lines = [];
    let total;
    if (check) {
      total = { totalAmount: Number(check.total_fine_amount), vatAmount: Number(check.vat_amount || 0), subtotalAmount: Number(check.total_fine_amount) - Number(check.vat_amount || 0) };
    } else {
      const ids = input.draft.lines.map(line => line.itemId);
      if (new Set(ids).size !== ids.length) throw badRequest('Duplicate catalog items');
      const available = await execute(conn, `SELECT id, name, price FROM accessories WHERE organization_id = :organizationId
        AND market_id = :marketId AND status = 'active' FOR UPDATE`, { organizationId: auth.organizationId, marketId });
      lines = input.draft.lines.map(line => {
        const item = available.find(row => Number(row.id) === line.itemId);
        if (!item) throw badRequest('Catalog item is not available');
        return { itemId: line.itemId, name: item.name, quantity: line.quantity, unitPrice: Number(item.price), lineTotal: Math.round(Number(item.price) * 100) * line.quantity / 100 };
      });
      total = calculateVatBreakdown(lines.reduce((sum, line) => sum + line.lineTotal, 0), 0, await getOrganizationVatSettings(conn, auth.organizationId));
    }
    if (!(total.totalAmount > 0) || total.totalAmount > 99999999.99) throw badRequest('Invalid collection total');
    if (paymentMethod === 'cash') assertCashAmount(input.expectedAmount, total.totalAmount);
    const qr = paymentMethod === 'cash' ? {qrPayload: null, qrImageUrl: null} : await qrSnapshot(conn, auth.organizationId, total.totalAmount);
    const merchant = input.draft && (input.draft.persistMerchant === true || input.draft.merchantId || input.draft.customerId)
      ? await require('./audit-merchant.service').resolveMerchant(conn, auth, marketId, input.draft) : null;
    let existingPaymentId = null;
    if (check?.fine_payment_status === 'waiting') {
      const awaiting = await execute(conn, `SELECT id FROM payments WHERE organization_id = :organizationId
        AND audit_check_id = :checkId AND provider = 'manual' AND status = 'waiting' ORDER BY id DESC LIMIT 1 FOR UPDATE`,
      {organizationId: auth.organizationId, checkId: check.id});
      existingPaymentId = awaiting[0]?.id || null;
    }
    const inserted = await execute(conn, `INSERT INTO audit_collections
      (organization_id, market_id, created_by_admin_id, audit_check_id, payment_id, payment_method, merchant_id, public_id, idempotency_key, request_hash,
       customer_reference_enc, note_enc, lines_json, subtotal_amount, vat_amount, total_amount, qr_payload_enc, qr_image_url_enc)
      VALUES (:organizationId, :marketId, :actor, :checkId, :paymentId, :paymentMethod, :merchantId, :reference, :key, :hash,
       :customer, :note, :lines, :subtotal, :vat, :total, :qrPayload, :qrImage)`, {
      organizationId: auth.organizationId, marketId, actor: auth.sub, checkId: check?.id || null, paymentId: existingPaymentId, reference: `AC-${randomUUID()}`,
      key, hash, paymentMethod, merchantId: merchant?.id || null, customer: encryptField(merchant?.name || input.draft?.customerReference), note: encryptField(input.draft?.note), lines: JSON.stringify(lines),
      subtotal: total.subtotalAmount, vat: total.vatAmount, total: total.totalAmount, qrPayload: encryptField(qr.qrPayload), qrImage: encryptField(qr.qrImageUrl),
    });
    if (paymentMethod === 'cash') return settleCash(conn, auth, inserted.insertId, input.expectedAmount);
    return serialize(await load(conn, auth, inserted.insertId));
  });
}
async function get(auth, id) { return transaction(async conn => serialize(await load(conn, auth, id))); }
async function history(auth) {
  const ids = (auth.marketIds || []).filter(id => Number.isSafeInteger(id) && id > 0);
  if (!ids.length) return { collections: [] };
  const params = {organizationId: auth.organizationId};
  const placeholders = ids.map((id, index) => {params[`market${index}`] = id; return `:market${index}`;}).join(',');
  const rows = await query(`SELECT ${columns}, ac.fine_payment_status, p.status AS payment_status, p.paid_at AS payment_paid_at
    FROM audit_collections c LEFT JOIN audit_checks ac ON ac.id = c.audit_check_id AND ac.organization_id = c.organization_id
    LEFT JOIN payments p ON p.id = c.payment_id AND p.organization_id = c.organization_id
    WHERE c.organization_id = :organizationId AND c.market_id IN (${placeholders}) ORDER BY c.id DESC LIMIT 300`, params);
  return {collections: rows.map(row => serialize(row))};
}
async function proof(auth, id, file) {
  if (!file) throw badRequest('กรุณาแนบหลักฐานชำระเงิน');
  const png = file.buffer.subarray(0, 8).equals(Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]));
  const jpeg = file.buffer[0] === 255 && file.buffer[1] === 216 && file.buffer[2] === 255;
  if (!png && !jpeg) throw badRequest('รองรับไฟล์ PNG หรือ JPEG เท่านั้น');
  return transaction(async conn => {
    const row = await load(conn, auth, id, true);
    if (serialize(row).status === 'paid') throw conflict('รายการนี้ชำระแล้ว');
    if (!['pending', 'failed'].includes(serialize(row).status)) throw conflict('รายการนี้อยู่ระหว่างตรวจสอบแล้ว');
    await execute(conn, `UPDATE audit_collections SET proof_enc = :proof, proof_mime = :mime, proof_uploaded_at = NOW(),
      status = 'processing' WHERE id = :id AND organization_id = :organizationId`, { proof: encryptField(file.buffer.toString('base64')), mime: png ? 'image/png' : 'image/jpeg', id, organizationId: auth.organizationId });
    if (row.audit_check_id) await execute(conn, `UPDATE audit_checks SET fine_payment_status = 'waiting'
      WHERE id = :id AND organization_id = :organizationId`, {id: row.audit_check_id, organizationId: auth.organizationId});
    return serialize(await load(conn, auth, id));
  });
}
async function review(auth, id, status) {
  return transaction(async conn => {
    const row = await load(conn, auth, id, true);
    if (row.audit_check_id) {
      const checks = await execute(conn, `SELECT fine_payment_status FROM audit_checks WHERE id = :id
        AND organization_id = :organizationId FOR UPDATE`, { id: row.audit_check_id, organizationId: auth.organizationId });
      if (!['pending', 'waiting'].includes(checks[0]?.fine_payment_status)) throw conflict('รายการนี้ชำระแล้วหรือถูกยกเลิก');
    }
    if (serialize(row).status === 'paid') throw conflict('รายการนี้ชำระแล้ว');
    if (row.status !== 'processing' || !row.has_proof) throw badRequest('รายการนี้ยังไม่มีหลักฐานให้ตรวจสอบ');
    let paymentId = row.payment_id;
    if (status === 'paid') {
      const payment = await execute(conn, `INSERT INTO payments (organization_id, public_id, audit_check_id, provider, status,
        amount, paid_at, verified_by_admin_id, verified_at) VALUES (:organizationId, :reference, :checkId, 'manual', 'paid',
        :amount, NOW(), :actor, NOW())`, { organizationId: auth.organizationId, reference: `ACP-${randomUUID()}`, checkId: row.audit_check_id, amount: row.total_amount, actor: auth.sub });
      paymentId = payment.insertId;
      if (row.audit_check_id) await execute(conn, `UPDATE audit_checks SET fine_payment_status = 'paid'
        WHERE id = :id AND organization_id = :organizationId`, { id: row.audit_check_id, organizationId: auth.organizationId });
    } else if (row.audit_check_id) {
      await execute(conn, `UPDATE audit_checks SET fine_payment_status = 'pending'
        WHERE id = :id AND organization_id = :organizationId`, {id: row.audit_check_id, organizationId: auth.organizationId});
    }
    await execute(conn, `UPDATE audit_collections SET status = :status, payment_id = :paymentId,
      reviewed_by_admin_id = :actor, paid_at = CASE WHEN :status = 'paid' THEN NOW() ELSE NULL END
      WHERE id = :id AND organization_id = :organizationId`, { status, paymentId, actor: auth.sub, id, organizationId: auth.organizationId });
    return serialize(await load(conn, auth, id), true);
  });
}
async function list(auth, marketId, status) {
  assertAccess(auth, marketId);
  const rows = await query(`SELECT ${columns}, ac.fine_payment_status, p.status AS payment_status, p.paid_at AS payment_paid_at
    FROM audit_collections c LEFT JOIN audit_checks ac ON ac.id = c.audit_check_id AND ac.organization_id = c.organization_id
    LEFT JOIN payments p ON p.id = c.payment_id AND p.organization_id = c.organization_id
    WHERE c.organization_id = :organizationId AND c.market_id = :marketId AND (:status IS NULL OR c.status = :status)
    ORDER BY c.id DESC LIMIT 300`, { organizationId: auth.organizationId, marketId, status });
  return rows.map(row => serialize(row, true));
}
async function proofImage(auth, id) {
  return transaction(async conn => {
    const row = await load(conn, auth, id);
    if (!row.has_proof) throw notFound('Proof not found');
    const images = await execute(conn, `SELECT proof_enc FROM audit_collections WHERE id = :id AND organization_id = :organizationId`, {id, organizationId: auth.organizationId});
    return { mime: row.proof_mime, bytes: Buffer.from(decryptField(images[0].proof_enc), 'base64') };
  });
}
module.exports = { markets, catalog, create, get, proof, review, list, history, proofImage, serialize };
