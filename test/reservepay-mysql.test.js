const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const mysql = require('mysql2/promise');
const { randomUUID } = require('node:crypto');

// Explicit opt-in, local disposable database only. Never loads the project's .env.
const connectionUrl = process.env.RESERVEPAY_TEST_MYSQL_URL;
test('MySQL migrations, tenant FKs, concurrent checkout, duplicate event and atomic settlement', { skip: !connectionUrl }, async () => {
  const url = new URL(connectionUrl);
  assert.ok(['localhost', '127.0.0.1', '[::1]'].includes(url.hostname), 'Integration database must be local');
  const database = `reservepay_test_${randomUUID().replace(/-/g, '')}`;
  const config = { host: url.hostname, port: Number(url.port || 3306), user: decodeURIComponent(url.username), password: decodeURIComponent(url.password), namedPlaceholders: true, timezone: '+07:00' };
  const admin = await mysql.createConnection(config);
  let pool;
  const stub = (modulePath, exports) => {
    const id = require.resolve(modulePath);
    require.cache[id] = { id, filename: id, loaded: true, exports };
  };
  try {
    await admin.query(`CREATE DATABASE ${database} CHARACTER SET utf8mb4 COLLATE utf8mb4_unicode_ci`);
    pool = mysql.createPool({ ...config, database, connectionLimit: 5 });
    // Minimal pre-expansion schema: exercises actual MySQL DDL, row locks and rollback.
    const base = [
      'CREATE TABLE organizations (id BIGINT UNSIGNED PRIMARY KEY)',
      'CREATE TABLE markets (id BIGINT UNSIGNED PRIMARY KEY, organization_id BIGINT UNSIGNED)',
      `CREATE TABLE mobile_notifications (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, organization_id BIGINT UNSIGNED, mobile_user_id BIGINT UNSIGNED, title VARCHAR(255), body TEXT, data_json JSON)`,
      'CREATE TABLE mobile_users (id BIGINT UNSIGNED PRIMARY KEY, organization_id BIGINT UNSIGNED, status VARCHAR(20), email_enc TEXT, first_name_enc TEXT, last_name_enc TEXT)',
      `CREATE TABLE bookings (id BIGINT UNSIGNED PRIMARY KEY, organization_id BIGINT UNSIGNED, mobile_user_id BIGINT UNSIGNED,
        status VARCHAR(40), total_amount DECIMAL(12,2), expires_at DATETIME, paid_at DATETIME, cart_visible TINYINT)`,
      `CREATE TABLE booking_items (id BIGINT UNSIGNED PRIMARY KEY, organization_id BIGINT UNSIGNED, booking_id BIGINT UNSIGNED,
        booth_id BIGINT UNSIGNED, booking_date DATE, status VARCHAR(40))`,
      `CREATE TABLE booth_date_locks (id BIGINT UNSIGNED PRIMARY KEY, organization_id BIGINT UNSIGNED, booking_id BIGINT UNSIGNED,
        booking_item_id BIGINT UNSIGNED, booth_id BIGINT UNSIGNED, booking_date DATE, status VARCHAR(40), expires_at DATETIME)`,
      `CREATE TABLE payments (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, organization_id BIGINT UNSIGNED NOT NULL,
        public_id VARCHAR(40) NOT NULL UNIQUE, booking_id BIGINT UNSIGNED, provider ENUM('ksher','manual','mock') NOT NULL DEFAULT 'ksher',
        provider_reference VARCHAR(255), status VARCHAR(40), amount DECIMAL(12,2), paid_at DATETIME)`,
      `CREATE TABLE payment_callbacks (id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY, organization_id BIGINT UNSIGNED,
        provider VARCHAR(80), payload_json JSON, received_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP)`,
    ];
    for (const sql of base) await pool.query(sql);
    for (const file of ['051_reservepay_attempts.sql', '052_reservepay_payment_mapping.sql', '053_reservepay_callback_inbox.sql', '054_reservepay_payment_channel.sql', '055_market_payment_settings.sql', '056_organization_payment_settings.sql']) {
      const sql = fs.readFileSync(path.join(__dirname, '../migrations', file), 'utf8');
      for (const statement of sql.split(/;\s*$/m).map((s) => s.trim()).filter(Boolean)) await pool.query(statement);
    }
    await pool.query('INSERT INTO organizations VALUES (7),(8)');
    await pool.query("INSERT INTO organization_payment_settings (organization_id,mode,sync_state) VALUES (7,'gateway','ready'),(8,'manual','inactive')");
    await pool.query("INSERT INTO mobile_users VALUES (9,7,'active',NULL,NULL,NULL)");
    await pool.query("INSERT INTO bookings VALUES (101,7,9,'pending_payment',100,NOW() + INTERVAL 10 MINUTE,NULL,1),(102,7,9,'pending_payment',250,NOW() + INTERVAL 10 MINUTE,NULL,1)");
    await pool.query("INSERT INTO booking_items VALUES (1,7,101,1,'2026-11-04','pending_payment'),(2,7,102,2,'2026-11-04','pending_payment')");
    await pool.query("INSERT INTO booth_date_locks VALUES (1,7,101,1,1,'2026-11-04','held',NOW() + INTERVAL 10 MINUTE),(2,7,102,2,2,'2026-11-04','held',NOW() + INTERVAL 10 MINUTE)");
    const query = async (sql, p) => (await pool.execute(sql, p))[0];
    const transaction = async (fn) => {
      const conn = await pool.getConnection();
      try { await conn.beginTransaction(); const result = await fn(conn); await conn.commit(); return result; }
      catch (error) { await conn.rollback(); throw error; }
      finally { conn.release(); }
    };
    stub('../src/config/db', { query, transaction });
    stub('../src/config/env', { RESERVEPAY_MERCHANT_ID: 'merchant', RESERVEPAY_WEBHOOK_KEY: 'test', CRON_SECRET: 'test', RESERVEPAY_CHECKOUT_ENABLED: true });
    stub('../src/services/payment-activity.service', { activity: async () => {} });
    stub('../src/services/reservepay.service', { isConfigured: () => true });
    stub('../src/utils/crypto', { decryptField: () => null });
    const { prepare } = require('../src/services/reservepay-checkout.service');
    const { applyPayment } = require('../src/services/reservepay-settlement.service');
    const auth = { sub: 9, organizationId: 7, userType: 'customer' };
    const body = { bookingIds: [101, 102], paymentSessionId: 'session', amount: '35000' };
    // Same key and overlapping booking locks serialize to one attempt.
    const same = await Promise.all([prepare(auth, body, 'same-key'), prepare(auth, body, 'same-key')]);
    assert.equal(same[0].attempt.id, same[1].attempt.id);
    assert.equal(same.filter((r) => r.created).length, 1);
    await assert.rejects(() => prepare(auth, { ...body, paymentSessionId: 'other' }, 'other-key'), { code: 'BOOKING_NOT_PAYABLE' });
    const attempt = same[0].attempt;
    const [allocations] = await pool.query('SELECT * FROM payments ORDER BY id');
    assert.deepEqual(allocations.map((p) => p.amount), ['100.00', '250.00']);
    await assert.rejects(() => query("INSERT INTO payments (organization_id,public_id,booking_id,payment_attempt_id,provider,status,amount) VALUES (8,'foreign',103,:id,'reservepay','created',1)", { id: attempt.id }), { code: 'ER_NO_REFERENCED_ROW_2' });
    const eventSql = "INSERT INTO payment_callbacks (provider,merchant_id,event_id,payload_json,processing_status) VALUES ('reservepay','merchant','evt_duplicate','{}','pending') ON DUPLICATE KEY UPDATE event_id=event_id";
    await pool.query(eventSql); await pool.query(eventSql);
    assert.equal((await query('SELECT COUNT(*) AS count FROM payment_callbacks', {}))[0].count, 1);
    const verified = { payment_id: 'provider', external_id: attempt.external_id, amount: 35000, currency: 'THB', status: 'SUCCESSFUL', payment_method: 'PROMPTPAY', payment_method_display_name: 'PromptPay QR' };
    await applyPayment(attempt, verified, attempt.lease_token);
    assert.equal((await query('SELECT payment_method FROM payment_attempts', {}))[0].payment_method, 'PROMPTPAY');
    assert.ok((await query('SELECT status FROM bookings', {})).every((b) => b.status === 'paid'));
    assert.ok((await query('SELECT status FROM payments', {})).every((p) => p.status === 'paid'));
    assert.ok((await query('SELECT status FROM booth_date_locks', {})).every((p) => p.status === 'paid'));
    await applyPayment(attempt, { ...verified, status: 'FAILED' }, attempt.lease_token);
    assert.ok((await query('SELECT status FROM bookings', {})).every((b) => b.status === 'paid'));
  } finally {
    if (pool) await pool.end();
    await admin.query(`DROP DATABASE IF EXISTS ${database}`);
    await admin.end();
  }
});
