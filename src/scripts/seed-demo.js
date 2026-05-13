const bcrypt = require('bcryptjs');
const { pool } = require('../config/db');
const { logger } = require('../config/logger');
const { encryptField, blindIndex } = require('../utils/crypto');

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
     WHERE organization_id = :organizationId AND name = :name
     ORDER BY id
     LIMIT 1`,
    { organizationId, name },
  );

  if (existing) {
    await exec(
      connection,
      `UPDATE tenant_types
       SET status = 'active'
       WHERE id = :id AND organization_id = :organizationId`,
      { organizationId, id: existing.id },
    );
    return existing;
  }

  await exec(
    connection,
    `INSERT INTO tenant_types (organization_id, name, status)
     VALUES (:organizationId, :name, 'active')
     `,
    { organizationId, name },
  );

  return one(
    connection,
    `SELECT id FROM tenant_types
     WHERE organization_id = :organizationId AND name = :name
     LIMIT 1`,
    { organizationId, name },
  );
}

async function upsertMobileUser(connection, organizationId) {
  const username = 'vendor001';
  await exec(
    connection,
    `INSERT INTO mobile_users (
      organization_id, public_id, username_enc, username_hash, password_hash,
      first_name_enc, last_name_enc, phone_enc, phone_hash,
      email_enc, email_hash, id_card_enc, id_card_hash, address_enc,
      accepted_consent_at, status
    ) VALUES (
      :organizationId, 'MB-DEMO-001', :usernameEnc, :usernameHash, :passwordHash,
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
      usernameEnc: encryptField(username),
      usernameHash: blindIndex(username),
      passwordHash: await bcrypt.hash(DEFAULT_VENDOR_PASSWORD, 12),
      firstNameEnc: encryptField('สมชาย'),
      lastNameEnc: encryptField('ค้าขาย'),
      phoneEnc: encryptField('0800000000'),
      phoneHash: blindIndex('0800000000'),
      emailEnc: encryptField('vendor001@example.com'),
      emailHash: blindIndex('vendor001@example.com'),
      idCardEnc: encryptField('1100000000000'),
      idCardHash: blindIndex('1100000000000'),
      addressEnc: encryptField('Bangkok'),
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
  const amount = options.amount || 500;
  const paidAt = bookingStatus === 'paid' ? new Date() : null;
  await exec(
    connection,
    `INSERT INTO bookings (
      organization_id, public_id, market_id, mobile_user_id, source, status,
      subtotal_amount, total_amount, paid_at
    ) VALUES (
      :organizationId, :publicId, :marketId, :mobileUserId, 'mobile', :bookingStatus,
      :amount, :amount, :paidAt
    )
    ON DUPLICATE KEY UPDATE
      market_id = VALUES(market_id),
      mobile_user_id = VALUES(mobile_user_id),
      status = VALUES(status),
      subtotal_amount = VALUES(subtotal_amount),
      total_amount = VALUES(total_amount),
      paid_at = VALUES(paid_at)`,
    { organizationId, publicId, marketId, mobileUserId, bookingStatus, amount, paidAt },
  );

  const booking = await one(connection, `SELECT id FROM bookings WHERE public_id = :publicId LIMIT 1`, { publicId });
  let item = await one(
    connection,
    `SELECT id FROM booking_items
     WHERE organization_id = :organizationId AND booking_id = :bookingId AND booth_id = :boothId AND booking_date = :bookingDate
     LIMIT 1`,
    { organizationId, bookingId: booking.id, boothId, bookingDate },
  );

  if (!item) {
    const result = await exec(
      connection,
      `INSERT INTO booking_items (organization_id, booking_id, booth_id, booking_date, unit_price, status, audit_status)
       VALUES (:organizationId, :bookingId, :boothId, :bookingDate, :amount, :itemStatus, 'pending')`,
      { organizationId, bookingId: booking.id, boothId, bookingDate, amount, itemStatus },
    );
    item = { id: result.insertId };
  } else {
    await exec(
      connection,
      `UPDATE booking_items
       SET unit_price = :amount, status = :itemStatus
       WHERE id = :bookingItemId AND organization_id = :organizationId`,
      { organizationId, bookingItemId: item.id, amount, itemStatus },
    );
  }

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
       VALUES (:organizationId, :paymentPublicId, :bookingId, 'mock', :providerReference, 'paid', :amount, NOW())
       ON DUPLICATE KEY UPDATE status = 'paid', amount = VALUES(amount), paid_at = COALESCE(paid_at, NOW())`,
      { organizationId, paymentPublicId, bookingId: booking.id, providerReference, amount },
    );
  }

  return { bookingId: booking.id, bookingItemId: item.id };
}

async function main() {
  const connection = await pool.getConnection();
  try {
    await connection.beginTransaction();

    const organization = await upsertOrganization(connection);
    const organizationId = organization.id;

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
    const drinkCategory = await findOrCreateByName(connection, 'product_categories', organizationId, market.id, 'เครื่องดื่ม');
    const fashionCategory = await findOrCreateByName(connection, 'product_categories', organizationId, market.id, 'แฟชั่น');

    const foodGroup = await findOrCreateByName(connection, 'product_groups', organizationId, market.id, 'อาหารพร้อมทาน', {
      category_id: foodCategory.id,
    });
    const drinkGroup = await findOrCreateByName(connection, 'product_groups', organizationId, market.id, 'กาแฟและชา', {
      category_id: drinkCategory.id,
    });

    const floorPlan = await findOrCreateByName(connection, 'floor_plans', organizationId, market.id, 'Demo Floor Plan 2026', {
      plan_image_url: null,
      start_date: '2026-01-01',
      end_date: '2026-12-31',
      status: 'active',
    });

    const booths = [];
    for (let index = 1; index <= 10; index += 1) {
      const categoryId = index <= 4 ? foodCategory.id : index <= 7 ? drinkCategory.id : fashionCategory.id;
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
    await findOrCreateProduct(connection, organizationId, market.id, drinkCategory.id, drinkGroup.id, 'กาแฟ');
    await findOrCreateProduct(connection, organizationId, market.id, fashionCategory.id, null, 'เสื้อผ้า');

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
    const demoBooking = await upsertDemoBooking(connection, organizationId, market.id, mobileUser.id, booths[0].id, product.id, {
      publicId: 'BK-DEMO-PAID-001',
      paymentPublicId: 'PAY-DEMO-001',
      bookingDate: '2026-05-14',
      bookingStatus: 'paid',
      itemStatus: 'paid',
      amount: 500,
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
      },
      'Demo seed completed',
    );

    console.log('Demo seed completed');
    console.log(`organizationId=${organizationId}`);
    console.log(`marketId=${market.id}`);
    console.log(`mobileUserId=${mobileUser.id}`);
    console.log(`bookingId=${demoBooking.bookingId}`);
    console.log(`bookingItemId=${demoBooking.bookingItemId}`);
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
