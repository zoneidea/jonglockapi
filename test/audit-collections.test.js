const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
for (const [key, value] of Object.entries({ DB_PASSWORD: 'test', JWT_SECRET: 'test-secret-'.repeat(4), FIELD_ENCRYPTION_KEY: 'a'.repeat(64), FIELD_HASH_SECRET: 'b'.repeat(32) })) process.env[key] ||= value;
function stub(path, exports) { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; }
const { encryptField, decryptField } = require('../src/utils/crypto');
const collections = [];
const checks = [{ id: 8, organization_id: 7, market_id: 1, fine_payment_status: 'pending', total_fine_amount: 107, vat_amount: 7 }];
const payments = [];
const statements = [];
let manual = true;
let paymentDetails = {promptpayId: '0812345678'};
const auth = { sub: 3, organizationId: 7, marketIds: [1, 2], role: 'audit', userType: 'audit' };
const management = { ...auth, sub: 9, role: 'accounting', userType: 'admin' };
async function sql(text, params = {}) {
  statements.push(text);
  if (/INSERT IGNORE INTO audit_collection_requests/.test(text)) return {affectedRows: 1};
  if (/SELECT \* FROM audit_collection_requests/.test(text)) return [{state: 'open', request_hash: null}];
  if (/UPDATE audit_collection_requests/.test(text)) return {affectedRows: 1};
  if (/FROM markets/.test(text)) return [{ id: params.marketId || 2, name: 'Market', collection_mode: params.marketId === 1 ? 'system' : 'self' }];
  if (/FROM accessories/.test(text)) return [{ id: 4, name: 'Service', price: '10.10' }];
  if (/SELECT vat_enabled/.test(text)) return [{ vat_enabled: 1, vat_rate: 7 }];
  if (/FROM organization_payment_settings/.test(text)) return [{ mode: 'manual', details_enc: encryptField(JSON.stringify(paymentDetails)) }];
  if (/SELECT id FROM payments/.test(text)) return [{id: 99}];
  if (/FROM audit_checks/.test(text) && !/audit_collections/.test(text)) return checks.filter(row => row.id === params.id && row.organization_id === params.organizationId);
  if (/SELECT audit_check_id, market_id FROM audit_collections/.test(text)) return collections.filter(row => row.id === params.id && row.organization_id === params.organizationId);
  if (/SELECT id, request_hash FROM audit_collections/.test(text)) return collections.filter(row => row.organization_id === params.organizationId && row.created_by_admin_id === params.actor && row.idempotency_key === params.key);
  if (/SELECT id FROM audit_collections/.test(text)) return collections.filter(row => row.audit_check_id === params.id && row.organization_id === params.organizationId);
  if (/INSERT INTO audit_collections/.test(text)) {
    const id = collections.length + 1;
    collections.push({ id, organization_id: params.organizationId, market_id: params.marketId, created_by_admin_id: params.actor, audit_check_id: params.checkId, payment_id: params.paymentId, payment_method: params.paymentMethod, merchant_id: params.merchantId, public_id: params.reference,
      idempotency_key: params.key, request_hash: params.hash, customer_reference_enc: params.customer, note_enc: params.note, lines_json: params.lines,
      subtotal_amount: params.subtotal, vat_amount: params.vat, total_amount: params.total, qr_payload_enc: params.qrPayload, qr_image_url_enc: params.qrImage, status: 'pending', paid_at: null });
    return { insertId: id };
  }
  if (/FROM audit_collections c/.test(text)) return collections.filter(row => row.id === params.id && row.organization_id === params.organizationId)
    .map(row => ({ ...row, has_proof: Boolean(row.proof_enc), fine_payment_status: checks.find(check => check.id === row.audit_check_id)?.fine_payment_status }));
  if (/UPDATE audit_collections SET proof_enc/.test(text)) {
    const row = collections.find(value => value.id === params.id); Object.assign(row, { proof_enc: params.proof, proof_mime: params.mime, proof_uploaded_at: '2026-11-09', status: 'processing' }); return { affectedRows: 1 };
  }
  if (/INSERT INTO payments/.test(text)) { const id = payments.length + 1; payments.push({ id, ...params }); return { insertId: id }; }
  if (/UPDATE audit_checks/.test(text)) { checks.find(row => row.id === params.id).fine_payment_status = text.includes("= 'waiting'") ? 'waiting' : text.includes("= 'pending'") ? 'pending' : 'paid'; return { affectedRows: 1 }; }
  if (/UPDATE audit_collections SET status/.test(text)) {
    const updated = collections.find(row => row.id === params.id);
    if (text.includes("payment_method = 'cash'")) Object.assign(updated, {payment_method: 'cash', qr_payload_enc: null, qr_image_url_enc: null});
    Object.assign(updated, { status: params.status || 'paid', payment_id: params.paymentId, paid_at: (params.status || 'paid') === 'paid' ? '2026-11-09' : null }); return { affectedRows: 1 };
  }
  throw new Error(`Unexpected SQL: ${text.slice(0, 90)}`);
}
const conn = { execute: async (...args) => [await sql(...args)] };
let tail = Promise.resolve();
stub('../src/config/db', { query: sql, transaction: work => { const result = tail.then(() => work(conn)); tail = result.catch(() => {}); return result; } });
stub('../src/services/organization-payment-settings.service', { assertManualAllowed: async () => { if (!manual) throw Object.assign(new Error('Gateway only'), { statusCode: 409 }); } });
stub('../src/services/audit-collection-log.service', { collectionLog: (_req, _res, next) => next() });
stub('../src/middlewares/auth', { authenticate: (req, _res, next) => { req.auth = req.get('x-test-role') === 'accounting' ? management : auth; next(); } });
const service = require('../src/services/audit-collection.service');
const app = express(); app.use(express.json());
const routes = require('../src/modules/audit/collections.routes');
app.use('/mobile', routes.mobile); app.use('/management', routes.management);
app.use(require('../src/middlewares/error-handler').errorHandler);
const input = { kind: 'pos', draft: { marketId: 2, customerReference: 'Private store', note: 'Private note', lines: [{ itemId: 4, quantity: 3 }] } };

test('POS uses real prices, VAT, encrypted identity, exact QR amount and no dummy booking', async () => {
  const first = await service.create(auth, input, 'request-key-00001');
  assert.equal(first.amount, 32.42); assert.equal(first.vatAmount, 2.12); assert.equal(first.status, 'pending');
  assert.match(first.qrPayload, /32\.42/);
  assert.equal(collections[0].audit_check_id, null);
  assert.notEqual(collections[0].customer_reference_enc, 'Private store');
  assert.equal(decryptField(collections[0].customer_reference_enc), 'Private store');
  assert.equal(statements.some(value => /INSERT INTO (bookings|booking_items|booths)/.test(value)), false);
});
test('idempotent retry returns one charge; changed payload and unassigned markets are rejected', async () => {
  const results = await Promise.all([service.create(auth, input, 'request-key-00002'), service.create(auth, input, 'request-key-00002')]);
  assert.equal(results[0].id, results[1].id);
  await assert.rejects(service.create(auth, { ...input, draft: { ...input.draft, note: 'Changed' } }, 'request-key-00002'), { statusCode: 409 });
  await assert.rejects(service.create({ ...auth, marketIds: [] }, input, 'request-key-00003'), { statusCode: 403 });
  await assert.rejects(service.get({ ...auth, organizationId: 99 }, results[0].id), { statusCode: 404 });
  await assert.rejects(service.create(auth, { ...input, draft: { ...input.draft, marketId: 1 } }, 'request-key-00004'), { statusCode: 404 });
});
test('audit collections reuse the same check across staff and honor organization gateway policy', async () => {
  const first = await service.create(auth, { kind: 'audit', auditCheckId: 8 }, 'audit-request-00001');
  const again = await service.create({ ...auth, sub: 5 }, { kind: 'audit', auditCheckId: 8 }, 'audit-request-00002');
  assert.equal(first.id, again.id); assert.equal(first.amount, 107);
  manual = false;
  await assert.rejects(service.create(auth, input, 'request-key-00005'), { statusCode: 409 }); manual = true;
});
test('payment needs a real image and management confirmation; repeat settlement cannot create another payment', async () => {
  const created = await service.create(auth, input, 'request-key-00006');
  await assert.rejects(service.review(management, created.id, 'paid'), { statusCode: 400 });
  await assert.rejects(service.proof(auth, created.id, { buffer: Buffer.from('not-an-image') }), { statusCode: 400 });
  const pending = await service.proof(auth, created.id, { buffer: Buffer.from([255, 216, 255, 224]) });
  assert.equal(pending.status, 'processing');
  const paid = await service.review(management, created.id, 'paid'); assert.equal(paid.status, 'paid');
  const count = payments.length;
  await assert.rejects(service.review(management, created.id, 'paid'), { statusCode: 409 }); assert.equal(payments.length, count);
  assert.equal((await service.get(auth, created.id)).status, 'paid');
});
test('HTTP rejects client prices and wrong roles; audit-role cannot approve its own collection', async () => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}`;
  try {
    const tampered = await fetch(`${base}/mobile/collections`, { method: 'POST', headers: { 'Content-Type': 'application/json', 'Idempotency-Key': 'request-key-00007' }, body: JSON.stringify({ ...input.draft, amount: 1 }) });
    assert.equal(tampered.status, 400);
    const denied = await fetch(`${base}/management/audit-collections/1/proof-status`, { method: 'PATCH', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ status: 'paid' }) });
    assert.equal(denied.status, 403);
    const mobileAdmin = await fetch(`${base}/mobile/markets`, { headers: { 'x-test-role': 'accounting' } }); assert.equal(mobileAdmin.status, 403);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
test('waiting and cancelled audit debts never show another payable QR; cancelled debt cannot be settled', async () => {
  checks.push({id: 9, organization_id: 7, market_id: 1, fine_payment_status: 'waiting', total_fine_amount: 50, vat_amount: 0});
  const waiting = await service.create(auth, {kind: 'audit', auditCheckId: 9}, 'audit-waiting-0001');
  assert.equal(waiting.status, 'processing'); assert.equal(waiting.qrPayload, undefined);
  assert.equal(collections.find(row => row.id === waiting.id).payment_id, 99);
  const audit = collections.find(row => row.audit_check_id === 8);
  checks.find(row => row.id === 8).fine_payment_status = 'cancelled';
  assert.equal((await service.get(auth, audit.id)).status, 'cancelled');
  assert.equal((await service.get(auth, audit.id)).qrPayload, undefined);
  await assert.rejects(service.proof(auth, audit.id, {buffer: Buffer.from([255, 216, 255])}), {statusCode: 409});
  await assert.rejects(service.review(management, audit.id, 'paid'), {statusCode: 409});
  assert.equal(statements.some(text => /SELECT c\.\*/.test(text)), false);
});
test('staff proof and rejection synchronize the original merchant-cart fine lifecycle', async () => {
  checks.push({id: 11, organization_id: 7, market_id: 1, fine_payment_status: 'pending', total_fine_amount: 10, vat_amount: 0});
  const charge = await service.create(auth, {kind: 'audit', auditCheckId: 11}, 'audit-proof-000001');
  await service.proof(auth, charge.id, {buffer: Buffer.from([255, 216, 255])});
  assert.equal(checks.find(row => row.id === 11).fine_payment_status, 'waiting');
  await service.review(management, charge.id, 'failed');
  assert.equal(checks.find(row => row.id === 11).fine_payment_status, 'pending');
  await service.proof(auth, charge.id, {buffer: Buffer.from([255, 216, 255])});
  await service.review(management, charge.id, 'paid');
  assert.equal(checks.find(row => row.id === 11).fine_payment_status, 'paid');
});

test('cash collection settles exactly once without requiring PromptPay settings or proof', async () => {
  paymentDetails = {};
  manual = false;
  const cashInput = {...input, paymentMethod: 'cash', expectedAmount: 32.42};
  const before = payments.length;
  const cash = await service.create(auth, cashInput, 'cash-request-000001');
  assert.equal(cash.status, 'paid'); assert.equal(cash.paymentMethod, 'cash'); assert.equal(cash.qrType, null);
  assert.equal(cash.qrPayload, undefined); assert.equal(cash.qrImageUrl, undefined);
  assert.equal(payments.length, before + 1);
  assert.deepEqual(JSON.parse(payments.at(-1).metadata), {paymentMethod: 'cash', collectedByAdminId: auth.sub});
  const repeated = await service.create(auth, cashInput, 'cash-request-000001');
  assert.equal(repeated.id, cash.id); assert.equal(payments.length, before + 1);
  await assert.rejects(service.proof(auth, cash.id, {buffer: Buffer.from([255, 216, 255])}), {statusCode: 409});
  manual = true; paymentDetails = {promptpayId: '0812345678'};
});
test('configured organization QR image takes precedence over a simultaneously saved PromptPay ID', async () => {
  paymentDetails = {promptpayId: '0812345678', qrCodeImageUrl: 'https://example.test/organization-qr.png'};
  const image = await service.create(auth, input, 'image-request-000001');
  assert.equal(image.qrType, 'image'); assert.equal(image.paymentMethod, 'promptpay');
  assert.equal(image.qrImageUrl, paymentDetails.qrCodeImageUrl); assert.equal(image.qrPayload, null);
  const configured = await service.catalog(auth, 2);
  assert.deepEqual(configured.paymentOptions, {paymentMethods: ['cash', 'promptpay'], qrType: 'image'});
  paymentDetails = {};
  const cashOnly = await service.catalog(auth, 2);
  assert.deepEqual(cashOnly.paymentOptions, {paymentMethods: ['cash'], qrType: null});
  await assert.rejects(service.create(auth, input, 'no-qr-request-00001'), {code: 'COLLECTION_PAYMENT_NOT_CONFIGURED'});
  paymentDetails = {promptpayId: '0812345678'};
});

test('cash rejects changed prices before creating a merchant or receiving money', async () => {
  const before = payments.length;
  const count = collections.length;
  await assert.rejects(service.create(auth, {...input, paymentMethod: 'cash', expectedAmount: 1, draft: {...input.draft, persistMerchant: true}}, 'cash-price-changed1'), {statusCode: 409, code: 'COLLECTION_TOTAL_CHANGED'});
  assert.equal(payments.length, before); assert.equal(collections.length, count);
  const exact = await service.create(auth, {...input, paymentMethod: 'cash', expectedAmount: 32.42}, 'cash-price-exact001');
  assert.equal(exact.status, 'paid'); assert.equal(exact.amount, 32.42);
});

test('cash requires confirmed expectedAmount and performs no writes when it is omitted', async () => {
  const paymentCount = payments.length;
  const collectionCount = collections.length;
  const statementCount = statements.length;
  await assert.rejects(service.create(auth, {...input, paymentMethod: 'cash', draft: {...input.draft, persistMerchant: true}}, 'cash-unconfirmed-01'), {statusCode: 400});
  assert.equal(payments.length, paymentCount); assert.equal(collections.length, collectionCount);
  assert.equal(statements.length, statementCount);
});

test('an existing unpaid audit PromptPay bill converts to one cash receipt; reviewed bills cannot convert', async () => {
  checks.push({id: 21, organization_id: 7, market_id: 1, fine_payment_status: 'pending', total_fine_amount: 25, vat_amount: 0});
  const pending = await service.create(auth, {kind: 'audit', auditCheckId: 21}, 'audit-convert-qr01');
  const before = payments.length;
  const cashInput = {kind: 'audit', auditCheckId: 21, paymentMethod: 'cash', expectedAmount: 25};
  const cash = await service.create(auth, cashInput, 'audit-convert-cash1');
  assert.equal(cash.id, pending.id); assert.equal(cash.reference, pending.reference);
  assert.equal(cash.status, 'paid'); assert.equal(cash.paymentMethod, 'cash'); assert.equal(cash.qrType, null);
  assert.equal(payments.length, before + 1);
  const repeat = await service.create(auth, cashInput, 'audit-convert-cash1');
  assert.equal(repeat.id, cash.id); assert.equal(payments.length, before + 1);
  checks.push({id: 22, organization_id: 7, market_id: 1, fine_payment_status: 'pending', total_fine_amount: 30, vat_amount: 0});
  const review = await service.create(auth, {kind: 'audit', auditCheckId: 22}, 'audit-waiting-qr01');
  await service.proof(auth, review.id, {buffer: Buffer.from([255, 216, 255])});
  await assert.rejects(service.create(auth, {kind: 'audit', auditCheckId: 22, paymentMethod: 'cash', expectedAmount: 30}, 'audit-waiting-cash1'), {code: 'COLLECTION_NOT_PAYABLE'});
  assert.equal(payments.length, before + 1);
});

test('POS rent is a stored bill line, taxed with services, and cash retries do not duplicate payments', async () => {
  const combined = await service.create(auth, {...input, draft: {...input.draft, rentAmount: 100.25}}, 'rent-combined-00001');
  assert.equal(combined.amount, 139.69);
  const bill = collections.find(row => row.id === combined.id);
  const lines = JSON.parse(bill.lines_json);
  assert.deepEqual(lines[0], {kind: 'rent', name: 'ค่าเช่าแผง', quantity: 1, unitPrice: 100.25, lineTotal: 100.25});
  assert.equal(lines[1].unitPrice, 10.10);
  const cashInput = {...input, draft: {...input.draft, rentAmount: 100.25, lines: []}, paymentMethod: 'cash', expectedAmount: 107.27};
  const cash = await service.create(auth, cashInput, 'rent-cash-only-001');
  assert.equal(cash.amount, 107.27); assert.equal(cash.status, 'paid');
  const count = payments.length;
  const replay = await service.create(auth, cashInput, 'rent-cash-only-001');
  assert.equal(replay.id, cash.id); assert.equal(payments.length, count);
  await assert.rejects(service.create(auth, {...cashInput, expectedAmount: 100.25}, 'rent-stale-total-01'), e => e.code === 'COLLECTION_TOTAL_CHANGED');
});
test('HTTP accepts rent without catalog items and rejects invalid rent or empty bills before writes', async () => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const url = `http://127.0.0.1:${server.address().port}/mobile/collections`;
  const send = (body, key) => fetch(url, {method: 'POST', headers: {'Content-Type': 'application/json', 'Idempotency-Key': key}, body: JSON.stringify(body)});
  try {
    const created = await send({marketId: 2, customerReference: 'Rent only', rentAmount: 100.25, paymentMethod: 'cash', expectedAmount: 107.27}, 'rent-http-only-001');
    assert.equal(created.status, 201); assert.equal((await created.json()).data.amount, 107.27);
    const count = collections.length;
    for (const rentAmount of [-1, 0, 1.001, 100000000, '100']) {
      const invalid = await send({marketId: 2, customerReference: 'Invalid', lines: [], rentAmount}, 'rent-invalid-00001');
      assert.equal(invalid.status, 400);
    }
    assert.equal(collections.length, count);
  } finally {await new Promise(resolve => server.close(resolve));}
});
