const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { logger } = require('../config/logger');
const { encryptField, blindIndex, decryptField } = require('../utils/crypto');
const { calculateVatBreakdown } = require('../utils/vat');

const DEFAULT_ADMIN_PASSWORD = 'Admin@123456';
const DEFAULT_VENDOR_PASSWORD = 'Vendor@123456';

async function one(connection, sql, params) {
  const [rows] = await connection.execute(sql, params);
  return rows[0] || null;
}

async function exec(connection, sql, params) {
  const [result] = await connection.execute(sql, params);
  return result;
}

async function upsertOrganization(connection) {
  await exec(
    connection,
    `INSERT INTO organizations (code, name, status)
     VALUES ('ORG001', 'Zone Idea Demo Organization', 'active')
     ON DUPLICATE KEY UPDATE name = VALUES(name), status = 'active'`,
    {},
  );

  return one(connection, `SELECT id FROM organizations WHERE code = 'ORG001' LIMIT 1`, {});
}

async function updateOrganizationSettings(connection, organizationId) {
  await exec(
    connection,
    `UPDATE organizations
     SET vat_enabled = 1,
         vat_rate = 7.00,
         registered_name = 'Zone Idea Demo Organization Co., Ltd.',
         registered_tax_id = '0105559000001',
         registered_address = '1 Demo Tower',
         registered_subdistrict = 'จตุจักร',
         registered_district = 'จตุจักร',
         registered_province = 'กรุงเทพมหานคร',
         registered_postcode = '10900'
     WHERE id = :organizationId`,
    { organizationId },
  );
}

async function upsertAdmin(connection, organizationId, { username, role, name, email, phone }) {
  await exec(
    connection,
    `INSERT INTO admin_users (
      organization_id, username_hash, password_hash, role,
      name_enc, email_enc, email_hash, phone_enc, phone_hash, status
    ) VALUES (
      :organizationId, :usernameHash, :passwordHash, :role,
      :nameEnc, :emailEnc, :emailHash, :phoneEnc, :phoneHash, 'active'
    )
    ON DUPLICATE KEY UPDATE
      password_hash = VALUES(password_hash),
      role = VALUES(role),
      name_enc = VALUES(name_enc),
      email_enc = VALUES(email_enc),
      email_hash = VALUES(email_hash),
      phone_enc = VALUES(phone_enc),
      phone_hash = VALUES(phone_hash),
      status = 'active'`,
    {
      organizationId,
      usernameHash: blindIndex(username),
      passwordHash: await bcrypt.hash(DEFAULT_ADMIN_PASSWORD, 12),
      role,
      nameEnc: encryptField(name),
      emailEnc: encryptField(email),
      emailHash: blindIndex(email),
      phoneEnc: encryptField(phone),
      phoneHash: blindIndex(phone),
    },
  );

  return one(
    connection,
    `SELECT id FROM admin_users
     WHERE organization_id = :organizationId AND username_hash = :usernameHash
     LIMIT 1`,
    { organizationId, usernameHash: blindIndex(username) },
  );
}

async function upsertMarket(connection, organizationId) {
  await exec(
    connection,
    `INSERT INTO markets (organization_id, code, name, description, open_date, close_date, status)
     VALUES (
      :organizationId, 'MKT001', 'Jonglock Demo Market',
      'ตลาดตัวอย่างสำหรับทดสอบระบบจองพื้นที่',
      '2026-01-01', '2026-12-31', 'active'
     )
     ON DUPLICATE KEY UPDATE
      name = VALUES(name),
      description = VALUES(description),
      open_date = VALUES(open_date),
      close_date = VALUES(close_date),
      status = 'active'`,
    { organizationId },
  );

  return one(
    connection,
    `SELECT id FROM markets WHERE organization_id = :organizationId AND code = 'MKT001' LIMIT 1`,
    { organizationId },
  );
}

async function assignMarket(connection, organizationId, adminUserId, marketId) {
  await exec(
    connection,
    `INSERT INTO admin_market_assignments (organization_id, admin_user_id, market_id, status)
     VALUES (:organizationId, :adminUserId, :marketId, 'active')
     ON DUPLICATE KEY UPDATE status = 'active'`,
    { organizationId, adminUserId, marketId },
  );
}

async function findOrCreateByName(connection, table, organizationId, marketId, name, extra = {}) {
  const existing = await one(
    connection,
    `SELECT id FROM ${table}
     WHERE organization_id = :organizationId
       AND (:marketId IS NULL OR market_id = :marketId)
       AND name = :name
     LIMIT 1`,
    { organizationId, marketId, name },
  );
  if (existing) return existing;

  const columns = ['organization_id', 'market_id', 'name', ...Object.keys(extra)];
  const params = {
    organizationId,
    marketId,
    name,
    ...extra,
  };
  const placeholders = [':organizationId', ':marketId', ':name', ...Object.keys(extra).map((key) => `:${key}`)];
  const result = await exec(
    connection,
    `INSERT INTO ${table} (${columns.join(', ')}) VALUES (${placeholders.join(', ')})`,
    params,
  );
  return { id: result.insertId };
}

async function upsertTenantType(connection, organizationId, name) {
  const existing = await one(
    connection,
    `SELECT id
     FROM tenant_types
     WHERE name = :name
     ORDER BY id
     LIMIT 1`,
    { name },
  );

  if (existing) {
    await exec(
      connection,
      `UPDATE tenant_types
       SET status = 'active'
       WHERE id = :id`,
      { id: existing.id },
    );
    return existing;
  }

  await exec(
    connection,
    `INSERT INTO tenant_types (organization_id, name, status)
     VALUES (NULL, :name, 'active')
     `,
    { name },
  );

  return one(
    connection,
    `SELECT id FROM tenant_types
     WHERE name = :name
     LIMIT 1`,
    { name },
  );
}

async function upsertMobileUser(connection, organizationId, profile = {}) {
  const username = profile.username || 'vendor001';
  const publicId = profile.publicId || 'MB-DEMO-001';
  const firstName = profile.firstName || 'สมชาย';
  const lastName = profile.lastName || 'ค้าขาย';
  const phone = profile.phone || '0800000000';
  const email = profile.email || 'vendor001@example.com';
  const idCard = profile.idCard || '1100000000000';
  const address = profile.address || 'Bangkok';
  await exec(
    connection,
    `INSERT INTO mobile_users (
      organization_id, public_id, username_enc, username_hash, password_hash,
      first_name_enc, last_name_enc, phone_enc, phone_hash,
      email_enc, email_hash, id_card_enc, id_card_hash, address_enc,
      accepted_consent_at, status
    ) VALUES (
      :organizationId, :publicId, :usernameEnc, :usernameHash, :passwordHash,
      :firstNameEnc, :lastNameEnc, :phoneEnc, :phoneHash,
      :emailEnc, :emailHash, :idCardEnc, :idCardHash, :addressEnc,
      NOW(), 'active'
    )
    ON DUPLICATE KEY UPDATE
      username_enc = VALUES(username_enc),
      password_hash = VALUES(password_hash),
      first_name_enc = VALUES(first_name_enc),
      last_name_enc = VALUES(last_name_enc),
      phone_enc = VALUES(phone_enc),
      phone_hash = VALUES(phone_hash),
      email_enc = VALUES(email_enc),
      email_hash = VALUES(email_hash),
      id_card_enc = VALUES(id_card_enc),
      id_card_hash = VALUES(id_card_hash),
      address_enc = VALUES(address_enc),
      accepted_consent_at = VALUES(accepted_consent_at),
      status = 'active'`,
    {
      organizationId,
      publicId,
      usernameEnc: encryptField(username),
      usernameHash: blindIndex(username),
      passwordHash: await bcrypt.hash(DEFAULT_VENDOR_PASSWORD, 12),
      firstNameEnc: encryptField(firstName),
      lastNameEnc: encryptField(lastName),
      phoneEnc: encryptField(phone),
      phoneHash: blindIndex(phone),
      emailEnc: encryptField(email),
      emailHash: blindIndex(email),
      idCardEnc: encryptField(idCard),
      idCardHash: blindIndex(idCard),
      addressEnc: encryptField(address),
    },
  );

  return one(
    connection,
    `SELECT id FROM mobile_users
     WHERE organization_id = :organizationId AND username_hash = :usernameHash
     LIMIT 1`,
    { organizationId, usernameHash: blindIndex(username) },
  );
}

async function upsertBooth(connection, organizationId, marketId, floorPlanId, categoryId, code, name, price, sortOrder) {
  await exec(
    connection,
    `INSERT INTO booths (
      organization_id, market_id, floor_plan_id, category_id, code, name, price,
      x, y, width, height, sort_order, status
    ) VALUES (
      :organizationId, :marketId, :floorPlanId, :categoryId, :code, :name, :price,
      :x, :y, 120, 90, :sortOrder, 'active'
    )
    ON DUPLICATE KEY UPDATE
      floor_plan_id = VALUES(floor_plan_id),
      category_id = VALUES(category_id),
      name = VALUES(name),
      price = VALUES(price),
      x = VALUES(x),
      y = VALUES(y),
      sort_order = VALUES(sort_order),
      status = 'active'`,
    {
      organizationId,
      marketId,
      floorPlanId,
      categoryId,
      code,
      name,
      price,
      x: ((sortOrder - 1) % 5) * 140,
      y: Math.floor((sortOrder - 1) / 5) * 110,
      sortOrder,
    },
  );

  return one(
    connection,
    `SELECT id FROM booths
     WHERE organization_id = :organizationId AND market_id = :marketId AND code = :code
     LIMIT 1`,
    { organizationId, marketId, code },
  );
}

async function findOrCreateProduct(connection, organizationId, marketId, categoryId, groupId, name) {
  const existing = await one(
    connection,
    `SELECT id FROM products
     WHERE organization_id = :organizationId AND market_id = :marketId AND name = :name
     LIMIT 1`,
    { organizationId, marketId, name },
  );
  if (existing) return existing;

  const result = await exec(
    connection,
    `INSERT INTO products (organization_id, market_id, category_id, group_id, name, status)
     VALUES (:organizationId, :marketId, :categoryId, :groupId, :name, 'active')`,
    { organizationId, marketId, categoryId, groupId, name },
  );
  return { id: result.insertId };
}

async function upsertDemoBooking(connection, organizationId, marketId, mobileUserId, boothId, productId, options = {}) {
  const publicId = options.publicId || 'BK-DEMO-PAID-001';
  const bookingDate = options.bookingDate || '2026-05-14';
  const bookingStatus = options.bookingStatus || 'paid';
  const itemStatus = options.itemStatus || bookingStatus;
  const subtotalAmount = Number(options.subtotalAmount ?? options.amount ?? 500);
  const discountAmount = Number(options.discountAmount || 0);
  const totals = calculateVatBreakdown(subtotalAmount, discountAmount, { vat_enabled: 1, vat_rate: 7 });
  const paidAt = bookingStatus === 'paid' ? (options.paidAt || new Date()) : null;
  await exec(
    connection,
    `INSERT INTO bookings (
      organization_id, public_id, market_id, mobile_user_id, source, status,
      subtotal_amount, discount_amount, vat_amount, total_amount, paid_at, comment
    ) VALUES (
      :organizationId, :publicId, :marketId, :mobileUserId, 'mobile', :bookingStatus,
      :subtotalAmount, :discountAmount, :vatAmount, :totalAmount, :paidAt, :comment
    )
    ON DUPLICATE KEY UPDATE
      market_id = VALUES(market_id),
      mobile_user_id = VALUES(mobile_user_id),
      status = VALUES(status),
      subtotal_amount = VALUES(subtotal_amount),
      discount_amount = VALUES(discount_amount),
      vat_amount = VALUES(vat_amount),
      total_amount = VALUES(total_amount),
      paid_at = VALUES(paid_at),
      comment = VALUES(comment)`,
    {
      organizationId,
      publicId,
      marketId,
      mobileUserId,
      bookingStatus,
      subtotalAmount: totals.subtotalAmount,
      discountAmount: totals.discountAmount,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
      paidAt,
      comment: options.comment || null,
    },
  );

  const booking = await one(connection, `SELECT id FROM bookings WHERE public_id = :publicId LIMIT 1`, { publicId });
  let item = await one(
    connection,
    `SELECT id FROM booking_items
     WHERE organization_id = :organizationId AND booking_id = :bookingId AND booth_id = :boothId
     LIMIT 1`,
    { organizationId, bookingId: booking.id, boothId },
  );

  if (!item) {
    const result = await exec(
      connection,
      `INSERT INTO booking_items (organization_id, booking_id, booth_id, booking_date, unit_price, status, audit_status)
       VALUES (:organizationId, :bookingId, :boothId, :bookingDate, :unitPrice, :itemStatus, 'pending')`,
      { organizationId, bookingId: booking.id, boothId, bookingDate, unitPrice: totals.subtotalAmount, itemStatus },
    );
    item = { id: result.insertId };
  } else {
    await exec(
      connection,
      `UPDATE booking_items
       SET booking_date = :bookingDate,
           unit_price = :unitPrice,
           status = :itemStatus
       WHERE id = :bookingItemId AND organization_id = :organizationId`,
      { organizationId, bookingItemId: item.id, bookingDate, unitPrice: totals.subtotalAmount, itemStatus },
    );
  }

  const booth = await one(
    connection,
    `SELECT floor_plan_id
     FROM booths
     WHERE id = :boothId AND organization_id = :organizationId AND market_id = :marketId
     LIMIT 1`,
    { organizationId, marketId, boothId },
  );
  if (booth) {
    await exec(
      connection,
      `INSERT INTO booth_date_locks (
        organization_id, market_id, floor_plan_id, booth_id, booking_id, booking_item_id,
        booking_date, status, expires_at
      ) VALUES (
        :organizationId, :marketId, :floorPlanId, :boothId, :bookingId, :bookingItemId,
        :bookingDate, :lockStatus, :expiresAt
      )
      ON DUPLICATE KEY UPDATE
        booking_id = VALUES(booking_id),
        booking_item_id = VALUES(booking_item_id),
        status = VALUES(status),
        expires_at = VALUES(expires_at)`,
      {
        organizationId,
        marketId,
        floorPlanId: booth.floor_plan_id,
        boothId,
        bookingId: booking.id,
        bookingItemId: item.id,
        bookingDate,
        lockStatus: bookingStatus === 'paid' ? 'paid' : bookingStatus === 'payment_processing' ? 'processing' : 'held',
        expiresAt: options.expiresAt || null,
      },
    );
  }

  await exec(
    connection,
    `DELETE bp
     FROM booking_products bp
     JOIN booking_items bi ON bi.id = bp.booking_item_id
     WHERE bi.organization_id = :organizationId
       AND bi.booking_id = :bookingId
       AND bi.id <> :bookingItemId`,
    { organizationId, bookingId: booking.id, bookingItemId: item.id },
  );
  await exec(
    connection,
    `DELETE FROM booking_items
     WHERE organization_id = :organizationId
       AND booking_id = :bookingId
       AND id <> :bookingItemId`,
    { organizationId, bookingId: booking.id, bookingItemId: item.id },
  );

  const linkedProduct = await one(
    connection,
    `SELECT id FROM booking_products
     WHERE organization_id = :organizationId AND booking_item_id = :bookingItemId AND product_id = :productId
     LIMIT 1`,
    { organizationId, bookingItemId: item.id, productId },
  );
  if (!linkedProduct) {
    await exec(
      connection,
      `INSERT INTO booking_products (organization_id, booking_item_id, product_id)
       VALUES (:organizationId, :bookingItemId, :productId)`,
      { organizationId, bookingItemId: item.id, productId },
    );
  }

  if (bookingStatus === 'paid') {
    const paymentPublicId = options.paymentPublicId || 'PAY-DEMO-001';
    const providerReference = options.providerReference || `MOCK-${publicId}`;
    await exec(
      connection,
      `INSERT INTO payments (organization_id, public_id, booking_id, provider, provider_reference, status, amount, paid_at)
       VALUES (:organizationId, :paymentPublicId, :bookingId, 'mock', :providerReference, 'paid', :amount, :paidAt)
       ON DUPLICATE KEY UPDATE
         status = 'paid',
         amount = VALUES(amount),
         provider_reference = VALUES(provider_reference),
         paid_at = VALUES(paid_at)`,
      {
        organizationId,
        paymentPublicId,
        bookingId: booking.id,
        providerReference,
        amount: totals.totalAmount,
        paidAt,
      },
    );
  }

  return { bookingId: booking.id, bookingItemId: item.id };
}

function addSeedDays(date, days) {
  const nextDate = new Date(`${date}T00:00:00`);
  nextDate.setDate(nextDate.getDate() + days);
  return nextDate.toISOString().slice(0, 10);
}

function clampSeedDate(date, endDate) {
  return endDate && date > endDate ? endDate : date;
}

function buildScenarioDates(offsets, startDate, endDate) {
  const uniqueDates = new Set(offsets.map((offset) => clampSeedDate(addSeedDays(startDate, offset), endDate)));
  return Array.from(uniqueDates).filter((date) => !endDate || date <= endDate);
}

async function seedMobileAvailabilityBookings(connection, organizationId, marketId, booths, mobileUsers, products, options = {}) {
  const startDate = options.startDate && options.startDate > '2026-05-21' ? options.startDate : '2026-05-21';
  const endDate = options.endDate || '';
  const publicIdPrefix = options.publicIdPrefix || 'BK-MOBILE-AVAIL';
  const paymentIdPrefix = options.paymentIdPrefix || 'PAY-MOBILE-AVAIL';
  const bookingScenarios = [
    { boothIndex: 0, offsets: [0, 1, 2, 3], status: 'paid' },
    { boothIndex: 1, offsets: [0, 2, 4], status: 'payment_processing' },
    { boothIndex: 2, offsets: [1, 3, 5], status: 'pending_payment' },
    { boothIndex: 3, offsets: [6, 7, 8], status: 'paid' },
    { boothIndex: 4, offsets: [0, 7, 14], status: 'payment_processing' },
    { boothIndex: 5, offsets: [9, 10, 11], status: 'pending_payment' },
    { boothIndex: 6, offsets: [12, 13, 14], status: 'paid' },
    { boothIndex: 7, offsets: [1, 8, 15], status: 'payment_processing' },
    { boothIndex: 8, offsets: [16, 17, 18], status: 'pending_payment' },
    { boothIndex: 9, offsets: [0, 1, 2], status: 'paid' },
  ].map((scenario) => ({
    ...scenario,
    dates: buildScenarioDates(scenario.offsets, startDate, endDate),
  })).filter((scenario) => scenario.dates.length > 0);

  let sequence = 1;
  for (const scenario of bookingScenarios) {
    const booth = booths[scenario.boothIndex % booths.length];
    for (const bookingDate of scenario.dates) {
      const selectedUser = mobileUsers[sequence % mobileUsers.length];
      const selectedProduct = products[sequence % products.length];
      const normalizedDate = bookingDate.replace(/-/g, '');
      const publicId = `${publicIdPrefix}-${String(scenario.boothIndex + 1).padStart(2, '0')}-${normalizedDate}`;
      const isPaid = scenario.status === 'paid';
      await upsertDemoBooking(
        connection,
        organizationId,
        marketId,
        selectedUser.id,
        booth.id,
        selectedProduct.id,
        {
          publicId,
          paymentPublicId: isPaid ? `${paymentIdPrefix}-${String(scenario.boothIndex + 1).padStart(2, '0')}-${normalizedDate}` : undefined,
          providerReference: `MOCK-${publicId}`,
          bookingDate,
          bookingStatus: scenario.status,
          itemStatus: scenario.status,
          subtotalAmount: booth.price || 500,
          paidAt: isPaid ? `${bookingDate} 10:15:00` : null,
          comment: 'ข้อมูลจำลองสำหรับทดสอบสถานะบูธบนแอปมือถือ',
        },
      );
      sequence += 1;
    }
  }

  return bookingScenarios.reduce((total, scenario) => total + scenario.dates.length, 0);
}

async function upsertPaymentCallback(connection, organizationId, provider, payload, receivedAt) {
  await exec(
    connection,
    `INSERT INTO payment_callbacks (organization_id, provider, payload_json, received_at)
     VALUES (:organizationId, :provider, :payloadJson, :receivedAt)`,
    {
      organizationId,
      provider,
      payloadJson: JSON.stringify(payload),
      receivedAt,
    },
  );
}

async function nextAccountingSequence(connection, organizationId, documentType, issueDate) {
  const periodYm = String(issueDate).replace(/-/g, '').slice(0, 6);
  await exec(
    connection,
    `INSERT INTO accounting_document_sequences (organization_id, document_type, period_ym, sequence_no)
     VALUES (:organizationId, :documentType, :periodYm, 1)
     ON DUPLICATE KEY UPDATE sequence_no = sequence_no + 1`,
    { organizationId, documentType, periodYm },
  );
  const sequence = await one(
    connection,
    `SELECT sequence_no
     FROM accounting_document_sequences
     WHERE organization_id = :organizationId
       AND document_type = :documentType
       AND period_ym = :periodYm
     LIMIT 1`,
    { organizationId, documentType, periodYm },
  );
  const prefix = { receipt: 'RC', tax_invoice: 'TAX', credit_note: 'CN' }[documentType];
  return `${prefix}${periodYm}${String(sequence.sequence_no).padStart(5, '0')}`;
}

async function issueAccountingDocument(connection, organizationId, paymentId, issuedByAdminId, documentType, options = {}) {
  const payment = await one(
    connection,
    `SELECT p.id, p.booking_id, p.amount, p.paid_at, b.public_id AS booking_public_id,
            b.subtotal_amount, b.discount_amount, b.vat_amount, b.total_amount,
            mu.first_name_enc, mu.last_name_enc
     FROM payments p
     JOIN bookings b ON b.id = p.booking_id
     JOIN mobile_users mu ON mu.id = b.mobile_user_id
     WHERE p.id = :paymentId AND p.organization_id = :organizationId
     LIMIT 1`,
    { organizationId, paymentId },
  );
  if (!payment) return null;

  const existing = await one(
    connection,
    `SELECT id, document_no
     FROM accounting_documents
     WHERE organization_id = :organizationId
       AND payment_id = :paymentId
       AND document_type = :documentType
       AND document_status = :documentStatus
     LIMIT 1`,
    {
      organizationId,
      paymentId,
      documentType,
      documentStatus: options.documentStatus || 'issued',
    },
  );
  if (existing) return existing;

  const issueDate = options.issueDate || String(payment.paid_at || new Date()).slice(0, 10);
  const documentNo = await nextAccountingSequence(connection, organizationId, documentType, issueDate);
  await exec(
    connection,
    `INSERT INTO accounting_documents (
      organization_id, document_type, document_no, document_status, payment_id, booking_id, source_document_id,
      issue_date, subtotal_amount, discount_amount, vat_amount, withholding_tax_amount, total_amount,
      customer_name, organization_snapshot_json, customer_snapshot_json, line_items_json, issued_by_admin_id,
      cancelled_by_admin_id, cancelled_at, cancel_reason
    ) VALUES (
      :organizationId, :documentType, :documentNo, :documentStatus, :paymentId, :bookingId, :sourceDocumentId,
      :issueDate, :subtotalAmount, :discountAmount, :vatAmount, 0, :totalAmount,
      :customerName, :organizationSnapshotJson, :customerSnapshotJson, :lineItemsJson, :issuedByAdminId,
      :cancelledByAdminId, :cancelledAt, :cancelReason
    )`,
    {
      organizationId,
      documentType,
      documentNo,
      documentStatus: options.documentStatus || 'issued',
      paymentId: payment.id,
      bookingId: payment.booking_id,
      sourceDocumentId: options.sourceDocumentId || null,
      issueDate,
      subtotalAmount: options.subtotalAmount ?? payment.subtotal_amount,
      discountAmount: options.discountAmount ?? payment.discount_amount,
      vatAmount: options.vatAmount ?? payment.vat_amount,
      totalAmount: options.totalAmount ?? payment.total_amount,
      customerName: options.customerName || [decryptField(payment.first_name_enc), decryptField(payment.last_name_enc)].filter(Boolean).join(' ').trim() || 'ลูกค้าทดสอบ',
      organizationSnapshotJson: JSON.stringify({
        name: 'Zone Idea Demo Organization Co., Ltd.',
        vatEnabled: true,
        vatRate: 7,
      }),
      customerSnapshotJson: JSON.stringify({ bookingPublicId: payment.booking_public_id }),
      lineItemsJson: JSON.stringify([{ description: 'ค่าจอง Booth', amount: options.subtotalAmount ?? payment.subtotal_amount }]),
      issuedByAdminId,
      cancelledByAdminId: options.cancelledByAdminId || null,
      cancelledAt: options.cancelledAt || null,
      cancelReason: options.cancelReason || null,
    },
  );

  return one(
    connection,
    `SELECT id, document_no
     FROM accounting_documents
     WHERE organization_id = :organizationId AND payment_id = :paymentId AND document_no = :documentNo
     LIMIT 1`,
    { organizationId, paymentId, documentNo },
  );
}

async function upsertAuditCheck(connection, organizationId, marketId, bookingItemId, checkedByAdminId, options = {}) {
  const result = options.result || 'pass';
  const fineAmount = Number(options.fineAmount || 0);
  const accessoriesFineAmount = Number(options.accessoriesFineAmount || 0);
  const damageFineAmount = Number(options.damageFineAmount || 0);
  const totalFineAmount = fineAmount + accessoriesFineAmount + damageFineAmount;
  const finePaymentStatus = totalFineAmount > 0 ? (options.finePaymentStatus || 'pending') : 'none';
  const checkedAt = options.checkedAt || new Date();

  const existing = await one(
    connection,
    `SELECT id
     FROM audit_checks
     WHERE organization_id = :organizationId
       AND market_id = :marketId
       AND booking_item_id = :bookingItemId
     ORDER BY id DESC
     LIMIT 1`,
    { organizationId, marketId, bookingItemId },
  );

  if (existing) {
    await exec(
      connection,
      `UPDATE audit_checks
       SET checked_by_admin_id = :checkedByAdminId,
           result = :result,
           note = :note,
           fine_amount = :fineAmount,
           accessories_fine_amount = :accessoriesFineAmount,
           damage_fine_amount = :damageFineAmount,
           total_fine_amount = :totalFineAmount,
           fine_payment_status = :finePaymentStatus,
           checked_at = :checkedAt
       WHERE id = :id`,
      {
        id: existing.id,
        checkedByAdminId,
        result,
        note: options.note || '',
        fineAmount,
        accessoriesFineAmount,
        damageFineAmount,
        totalFineAmount,
        finePaymentStatus,
        checkedAt,
      },
    );
  } else {
    await exec(
      connection,
      `INSERT INTO audit_checks (
         organization_id, market_id, booking_item_id, checked_by_admin_id,
         result, note, fine_amount, accessories_fine_amount, damage_fine_amount,
         total_fine_amount, fine_payment_status, checked_at
       ) VALUES (
         :organizationId, :marketId, :bookingItemId, :checkedByAdminId,
         :result, :note, :fineAmount, :accessoriesFineAmount, :damageFineAmount,
         :totalFineAmount, :finePaymentStatus, :checkedAt
       )`,
      {
        organizationId,
        marketId,
        bookingItemId,
        checkedByAdminId,
        result,
        note: options.note || '',
        fineAmount,
        accessoriesFineAmount,
        damageFineAmount,
        totalFineAmount,
        finePaymentStatus,
        checkedAt,
      },
    );
  }

  await exec(
    connection,
    `UPDATE booking_items
     SET audit_status = :auditStatus
     WHERE id = :bookingItemId AND organization_id = :organizationId`,
    { organizationId, bookingItemId, auditStatus: result },
  );
}

async function main() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const organization = await upsertOrganization(connection);
    const organizationId = organization.id;
    await updateOrganizationSettings(connection, organizationId);

    const supervisor = await upsertAdmin(connection, organizationId, {
      username: 'admin',
      role: 'supervisor',
      name: 'System Supervisor',
      email: 'admin@example.com',
      phone: '0800000001',
    });
    const marketAdmin = await upsertAdmin(connection, organizationId, {
      username: 'marketadmin',
      role: 'admin',
      name: 'Market Admin',
      email: 'marketadmin@example.com',
      phone: '0800000002',
    });
    const accounting = await upsertAdmin(connection, organizationId, {
      username: 'accounting',
      role: 'accounting',
      name: 'Accounting Officer',
      email: 'accounting@example.com',
      phone: '0800000003',
    });
    const audit = await upsertAdmin(connection, organizationId, {
      username: 'audit',
      role: 'audit',
      name: 'Audit Officer',
      email: 'audit@example.com',
      phone: '0800000004',
    });

    const market = await upsertMarket(connection, organizationId);
    await assignMarket(connection, organizationId, marketAdmin.id, market.id);
    await assignMarket(connection, organizationId, audit.id, market.id);

    await upsertTenantType(connection, organizationId, 'บุคคลธรรมดา');
    await upsertTenantType(connection, organizationId, 'นิติบุคคล');

    const foodCategory = await findOrCreateByName(connection, 'product_categories', organizationId, market.id, 'อาหาร');
    const nonFoodCategory = await findOrCreateByName(connection, 'product_categories', organizationId, market.id, 'ไม่ใช่อาหาร');

    const foodGroup = await findOrCreateByName(connection, 'product_groups', organizationId, market.id, 'อาหารพร้อมทาน', {
      category_id: foodCategory.id,
    });
    const nonFoodGroup = await findOrCreateByName(connection, 'product_groups', organizationId, market.id, 'สินค้าและบริการทั่วไป', {
      category_id: nonFoodCategory.id,
    });

    const floorPlan = await findOrCreateByName(connection, 'floor_plans', organizationId, market.id, 'Demo Floor Plan 2026', {
      plan_image_url: null,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      status: 'active',
    });

    const booths = [];
    for (let index = 1; index <= 10; index += 1) {
      const categoryId = index <= 4 ? foodCategory.id : nonFoodCategory.id;
      booths.push(
        await upsertBooth(
          connection,
          organizationId,
          market.id,
          floorPlan.id,
          categoryId,
          `A${String(index).padStart(2, '0')}`,
          `Booth A${String(index).padStart(2, '0')}`,
          index <= 5 ? 500 : 650,
          index,
        ),
      );
    }

    const product = await findOrCreateProduct(connection, organizationId, market.id, foodCategory.id, foodGroup.id, 'อาหารไทย');
    await findOrCreateProduct(connection, organizationId, market.id, foodCategory.id, foodGroup.id, 'กาแฟ');
    await findOrCreateProduct(connection, organizationId, market.id, nonFoodCategory.id, nonFoodGroup.id, 'เสื้อผ้า');

    await findOrCreateByName(connection, 'accessories', organizationId, market.id, 'โต๊ะพับ', {
      price: 100,
      stock_quantity: 30,
      status: 'active',
    });
    await findOrCreateByName(connection, 'accessories', organizationId, market.id, 'เก้าอี้', {
      price: 30,
      stock_quantity: 100,
      status: 'active',
    });

    await exec(
      connection,
      `INSERT INTO coupons (
        organization_id, market_id, code, name, discount_type, discount_value,
        usage_limit, starts_at, ends_at, created_by_admin_id, status
      ) VALUES (
        :organizationId, :marketId, 'DEMO100', 'ส่วนลดทดลอง 100 บาท',
        'amount', 100, 100, '2026-01-01 00:00:00', '2026-12-31 23:59:59',
        :createdByAdminId, 'active'
      )
      ON DUPLICATE KEY UPDATE
        name = VALUES(name),
        discount_value = VALUES(discount_value),
        status = 'active'`,
      { organizationId, marketId: market.id, createdByAdminId: supervisor.id },
    );

    const mobileUser = await upsertMobileUser(connection, organizationId);
    const productCoffee = await findOrCreateProduct(connection, organizationId, market.id, foodCategory.id, foodGroup.id, 'กาแฟ');
    const productDessert = await findOrCreateProduct(connection, organizationId, market.id, foodCategory.id, foodGroup.id, 'น้ำสุขภาพ');
    const productClothes = await findOrCreateProduct(connection, organizationId, market.id, nonFoodCategory.id, nonFoodGroup.id, 'เสื้อผ้า');
    const productSnack = await findOrCreateProduct(connection, organizationId, market.id, foodCategory.id, foodGroup.id, 'ขนมไทย');

    const demoBooking = await upsertDemoBooking(connection, organizationId, market.id, mobileUser.id, booths[0].id, product.id, {
      publicId: 'BK-DEMO-PAID-001',
      paymentPublicId: 'PAY-DEMO-001',
      bookingDate: '2026-05-01',
      bookingStatus: 'paid',
      itemStatus: 'paid',
      subtotalAmount: 500,
      paidAt: '2026-05-01 09:30:00',
    });
    await upsertDemoBooking(connection, organizationId, market.id, mobileUser.id, booths[1].id, product.id, {
      publicId: 'BK-DEMO-PENDING-001',
      bookingDate: '2026-05-14',
      bookingStatus: 'pending_payment',
      itemStatus: 'pending_payment',
      amount: 500,
    });
    await upsertDemoBooking(connection, organizationId, market.id, mobileUser.id, booths[2].id, product.id, {
      publicId: 'BK-DEMO-PROCESS-001',
      bookingDate: '2026-05-14',
      bookingStatus: 'payment_processing',
      itemStatus: 'payment_processing',
      amount: 500,
    });

    const customerProfiles = [
      ['vendor002', 'MB-DEMO-002', 'รุ่งนภา', 'ธำรงผลิต', '0956465653', 'vendor002@example.com'],
      ['vendor003', 'MB-DEMO-003', 'ฐิติญากรณ์', 'คล้ายสุบรรณ', '0625811765', 'vendor003@example.com'],
      ['vendor004', 'MB-DEMO-004', 'สุนิสา', 'พาณิชย์ดี', '0814001001', 'vendor004@example.com'],
      ['vendor005', 'MB-DEMO-005', 'ชุติมา', 'ทองมาก', '0814001002', 'vendor005@example.com'],
      ['vendor006', 'MB-DEMO-006', 'ประภัสสร', 'แซ่ลิ้ม', '0814001003', 'vendor006@example.com'],
      ['vendor007', 'MB-DEMO-007', 'กิตติศักดิ์', 'แสนคำ', '0814001004', 'vendor007@example.com'],
      ['vendor008', 'MB-DEMO-008', 'พิมพ์ชนก', 'ทวีโชค', '0814001005', 'vendor008@example.com'],
      ['vendor009', 'MB-DEMO-009', 'ศิริพร', 'เพชรดี', '0814001006', 'vendor009@example.com'],
      ['vendor010', 'MB-DEMO-010', 'กมลชนก', 'ทรัพย์สม', '0814001007', 'vendor010@example.com'],
      ['vendor011', 'MB-DEMO-011', 'ณัฐพล', 'เจริญกิจ', '0814001008', 'vendor011@example.com'],
      ['vendor012', 'MB-DEMO-012', 'วรรณภา', 'เพิ่มพูน', '0814001009', 'vendor012@example.com'],
      ['vendor013', 'MB-DEMO-013', 'มณฑา', 'อรุณรุ่ง', '0814001010', 'vendor013@example.com'],
    ];

    const mobileUsers = [mobileUser];
    for (const [username, publicId, firstName, lastName, phone, email] of customerProfiles) {
      const user = await upsertMobileUser(connection, organizationId, {
        username,
        publicId,
        firstName,
        lastName,
        phone,
        email,
        idCard: `110000000${phone.slice(-4)}`,
        address: 'Bangkok',
      });
      mobileUsers.push(user);
    }

    const paidBookingDates = [
      '2026-05-01', '2026-05-02', '2026-05-03', '2026-05-04', '2026-05-05', '2026-05-06',
      '2026-05-07', '2026-05-08', '2026-05-09', '2026-05-10', '2026-05-11', '2026-05-12',
      '2026-05-13', '2026-05-14', '2026-05-15', '2026-05-16', '2026-05-17', '2026-05-18',
    ];
    const products = [product, productCoffee, productDessert, productClothes, productSnack];
    const seededMobileAvailabilityBookings = await seedMobileAvailabilityBookings(
      connection,
      organizationId,
      market.id,
      booths,
      mobileUsers,
      products,
      {
        publicIdPrefix: 'BK-MOBILE-AVAIL',
        paymentIdPrefix: 'PAY-MOBILE-AVAIL',
        startDate: '2026-05-21',
        endDate: '2026-12-31',
      },
    );
    const activeFloorPlans = await connection.execute(
      `SELECT fp.id, DATE_FORMAT(fp.start_date, '%Y-%m-%d') AS start_date,
              DATE_FORMAT(fp.end_date, '%Y-%m-%d') AS end_date
       FROM floor_plans fp
       WHERE fp.organization_id = :organizationId
         AND fp.market_id = :marketId
         AND fp.status = 'active'
         AND fp.id <> :floorPlanId
       ORDER BY fp.id`,
      { organizationId, marketId: market.id, floorPlanId: floorPlan.id },
    );
    let seededExtraFloorPlanAvailabilityBookings = 0;
    for (const activeFloorPlan of activeFloorPlans[0]) {
      const [floorPlanBooths] = await connection.execute(
        `SELECT id, price
         FROM booths
         WHERE organization_id = :organizationId
           AND market_id = :marketId
           AND floor_plan_id = :floorPlanId
           AND status = 'active'
         ORDER BY sort_order ASC, code ASC, name ASC`,
        { organizationId, marketId: market.id, floorPlanId: activeFloorPlan.id },
      );
      if (!floorPlanBooths.length) continue;

      seededExtraFloorPlanAvailabilityBookings += await seedMobileAvailabilityBookings(
        connection,
        organizationId,
        market.id,
        floorPlanBooths,
        mobileUsers,
        products,
        {
          publicIdPrefix: `BK-MOBILE-FP${activeFloorPlan.id}`,
          paymentIdPrefix: `PAY-MOBILE-FP${activeFloorPlan.id}`,
          startDate: activeFloorPlan.start_date || '2026-05-21',
          endDate: activeFloorPlan.end_date || '',
        },
      );
    }
    const failedIndexes = new Set([1, 4, 7, 10, 13, 16, 19, 22, 25, 28, 31, 34]);
    const warningIndexes = new Set([5, 11, 17, 23, 29]);
    const seededBookings = [];

    for (let index = 0; index < 36; index += 1) {
      const bookingDate = paidBookingDates[index % paidBookingDates.length];
      const booth = booths[index % booths.length];
      const selectedProduct = products[index % products.length];
      const selectedUser = mobileUsers[index % mobileUsers.length];
      const publicId = `BK-DEMO-${String(index + 2).padStart(4, '0')}`;
      const paymentPublicId = `PAY-DEMO-${String(index + 2).padStart(4, '0')}`;
      const subtotalAmount = Number(index % 2 === 0 ? 900 + (index % 4) * 100 : 1000 + (index % 5) * 100);
      const discountAmount = index % 6 === 0 ? 100 : 0;
      const booking = await upsertDemoBooking(
        connection,
        organizationId,
        market.id,
        selectedUser.id,
        booth.id,
        selectedProduct.id,
        {
          publicId,
          paymentPublicId,
          providerReference: `MOCK-${publicId}`,
          bookingDate,
          bookingStatus: 'paid',
          itemStatus: 'paid',
          subtotalAmount,
          discountAmount,
          paidAt: `${bookingDate} 09:30:00`,
        },
      );
      seededBookings.push({
        ...booking,
        bookingDate,
        boothId: booth.id,
        publicId,
        paymentPublicId,
        subtotalAmount,
        discountAmount,
      });
    }

    await upsertAuditCheck(connection, organizationId, market.id, demoBooking.bookingItemId, audit.id, {
      result: 'pass',
      note: 'ข้อมูลทดสอบผ่านการตรวจ',
      checkedAt: '2026-05-14 10:00:00',
    });

    for (let index = 0; index < seededBookings.length; index += 1) {
      const seededBooking = seededBookings[index];
      if (failedIndexes.has(index)) {
        await upsertAuditCheck(connection, organizationId, market.id, seededBooking.bookingItemId, audit.id, {
          result: 'failed',
          note: 'ขายผิดประเภทสินค้าและตั้งวางอุปกรณ์ผิดตำแหน่ง',
          fineAmount: 200 + (index % 3) * 100,
          accessoriesFineAmount: index % 2 === 0 ? 100 : 0,
          damageFineAmount: index % 4 === 0 ? 50 : 0,
          finePaymentStatus: index % 3 === 0 ? 'paid' : 'pending',
          checkedAt: `${seededBooking.bookingDate} 18:30:00`,
        });
      } else if (warningIndexes.has(index)) {
        await upsertAuditCheck(connection, organizationId, market.id, seededBooking.bookingItemId, audit.id, {
          result: 'warning',
          note: 'มีการตักเตือนเรื่องการจัดวางสินค้า',
          checkedAt: `${seededBooking.bookingDate} 18:00:00`,
        });
      } else {
        await upsertAuditCheck(connection, organizationId, market.id, seededBooking.bookingItemId, audit.id, {
          result: 'pass',
          note: 'ผ่านการประเมิน',
          checkedAt: `${seededBooking.bookingDate} 17:30:00`,
        });
      }
    }

    const issuedDocuments = [];
    for (let index = 0; index < seededBookings.length; index += 1) {
      const seededBooking = seededBookings[index];
      const payment = await one(
        connection,
        `SELECT id, paid_at, amount
         FROM payments
         WHERE organization_id = :organizationId AND public_id = :publicId
         LIMIT 1`,
        { organizationId, publicId: seededBooking.paymentPublicId },
      );
      if (!payment) continue;

      await upsertPaymentCallback(connection, organizationId, 'mock', {
        paymentPublicId: seededBooking.paymentPublicId,
        bookingPublicId: seededBooking.publicId,
        status: 'paid',
        amount: payment.amount,
      }, payment.paid_at || `${seededBooking.bookingDate} 09:45:00`);

      if (index < 20) {
        const documentType = index < 4 ? 'receipt' : 'tax_invoice';
        const document = await issueAccountingDocument(connection, organizationId, payment.id, accounting.id, documentType, {
          issueDate: seededBooking.bookingDate,
        });
        if (document) issuedDocuments.push({ ...document, paymentId: payment.id, bookingDate: seededBooking.bookingDate });
      }
    }

    const cancelledTarget = issuedDocuments.find((item) => String(item.document_no || '').startsWith('RC'));
    if (cancelledTarget) {
      await exec(
        connection,
        `UPDATE accounting_documents
         SET document_status = 'cancelled',
             cancelled_by_admin_id = :cancelledByAdminId,
             cancelled_at = :cancelledAt,
             cancel_reason = :cancelReason
         WHERE id = :documentId`,
        {
          documentId: cancelledTarget.id,
          cancelledByAdminId: accounting.id,
          cancelledAt: `${cancelledTarget.bookingDate} 15:00:00`,
          cancelReason: 'ยกเลิกรายการทดสอบเอกสาร',
        },
      );
    }

    const creditSource = issuedDocuments.find((item) => String(item.document_no || '').startsWith('TAX'));
    if (creditSource) {
      const sourceDoc = await one(
        connection,
        `SELECT id, payment_id, subtotal_amount, discount_amount, vat_amount, total_amount, customer_name
         FROM accounting_documents
         WHERE id = :documentId
         LIMIT 1`,
        { documentId: creditSource.id },
      );
      if (sourceDoc) {
        await issueAccountingDocument(connection, organizationId, sourceDoc.payment_id, accounting.id, 'credit_note', {
          issueDate: '2026-05-19',
          sourceDocumentId: sourceDoc.id,
          subtotalAmount: sourceDoc.subtotal_amount,
          discountAmount: sourceDoc.discount_amount,
          vatAmount: sourceDoc.vat_amount,
          totalAmount: sourceDoc.total_amount,
          customerName: sourceDoc.customer_name,
          cancelReason: 'ออกใบลดหนี้สำหรับข้อมูลทดสอบ',
        });
        await exec(
          connection,
          `UPDATE payments
           SET status = 'refunded'
           WHERE id = :paymentId AND organization_id = :organizationId`,
          { organizationId, paymentId: sourceDoc.payment_id },
        );
      }
    }

    await connection.commit();

    logger.info(
      {
        organizationId,
        marketId: market.id,
        supervisorId: supervisor.id,
        marketAdminId: marketAdmin.id,
        accountingId: accounting.id,
        auditId: audit.id,
        mobileUserId: mobileUser.id,
        bookingId: demoBooking.bookingId,
        bookingItemId: demoBooking.bookingItemId,
        seededCustomerCount: mobileUsers.length,
        seededMobileAvailabilityBookings,
        seededExtraFloorPlanAvailabilityBookings,
        seededPaidBookings: seededBookings.length + 1,
      },
      'Demo seed completed',
    );

    console.log('Demo seed completed');
    console.log(`organizationId=${organizationId}`);
    console.log(`marketId=${market.id}`);
    console.log(`mobileUserId=${mobileUser.id}`);
    console.log(`bookingId=${demoBooking.bookingId}`);
    console.log(`bookingItemId=${demoBooking.bookingItemId}`);
    console.log(`seededCustomerCount=${mobileUsers.length}`);
    console.log(`seededMobileAvailabilityBookings=${seededMobileAvailabilityBookings}`);
    console.log(`seededExtraFloorPlanAvailabilityBookings=${seededExtraFloorPlanAvailabilityBookings}`);
    console.log(`seededPaidBookings=${seededBookings.length + 1}`);
    console.log('management users: admin / marketadmin / accounting / audit');
    console.log(`management password: ${DEFAULT_ADMIN_PASSWORD}`);
    console.log('mobile user: vendor001');
    console.log(`mobile password: ${DEFAULT_VENDOR_PASSWORD}`);
  } catch (error) {
    await connection.rollback();
    throw error;
  } finally {
    connection.release();
    await pool.end();
  }
}

main().catch((error) => {
  logger.error({ error }, 'Demo seed failed');
  process.exit(1);
});
