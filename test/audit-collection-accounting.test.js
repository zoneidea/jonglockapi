const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
for (const [key, value] of Object.entries({ DB_PASSWORD: 'test', JWT_SECRET: 'test-secret-'.repeat(4), FIELD_ENCRYPTION_KEY: 'a'.repeat(64), FIELD_HASH_SECRET: 'b'.repeat(32) })) process.env[key] ||= value;

function stub(path, exports) { const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports }; }
const { encryptField, decryptField } = require('../src/utils/crypto');
const payment = {
  id: 31, public_id: 'ACP-31', provider: 'manual', status: 'paid', amount: 107,
  audit_check_id: null, booking_id: null, booking_public_id: 'AC-31', payment_kind: 'audit_collection',
  subtotal_amount: 100, discount_amount: 0, vat_amount: 7, total_amount: 107,
  market_id: 2, market_name: 'Self market', organization_name: 'Organization', vat_enabled: 1, vat_rate: 7,
  customer_reference_enc: encryptField('Private store'),
  collection_lines_json: JSON.stringify([{ name: 'Market service', quantity: 2, unitPrice: 50, lineTotal: 100 }]),
};
let document;
let writes = 0;
const queries = [];
function assertScope(sql, params) {
  assert.match(sql, /audit_collections col ON col.payment_id = p.id AND col.organization_id = (?:p|ad).organization_id/);
  assert.match(sql, /(?:p|ad).organization_id = :organizationId/);
  assert.match(sql, /:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL/);
  assert.match(sql, /COALESCE\(b.market_id, ac.market_id, col.market_id\)/);
  return params.organizationId === 7 && (!params.marketId || params.marketId === 2)
    && (params.hasGlobalMarketAccess || params.adminUserId === 3);
}
async function query(sql, params = {}) {
  queries.push(sql);
  if (/SELECT col.id FROM audit_collections/.test(sql)) {
    assert.match(sql, /col.organization_id = :organizationId/);
    assert.match(sql, /ama.organization_id = col.organization_id/);
    assert.match(sql, /:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL/);
    return params.organizationId === 7 && (params.hasGlobalMarketAccess || params.adminUserId === 3) ? [{id: 21}] : [];
  }
  if (/FROM accounting_documents/.test(sql) && params.documentId) return document && params.organizationId === 7 ? [document] : [];
  if (/FROM payments p/.test(sql)) {
    const allowed = assertScope(sql, params);
    assert.match(sql, /WHEN col.id IS NOT NULL THEN 'audit_collection'/);
    if (!allowed || (params.paymentId && params.paymentId !== 31)) return [];
    if (/AS payment_status/.test(sql)) return [{ payment_kind: 'audit_collection', provider: 'manual', payment_status: 'paid', payment_amount: 107, booking_amount: 107, booking_status: 'paid' }];
    assert.match(sql, /WHEN col.id IS NOT NULL THEN col.subtotal_amount/);
    assert.match(sql, /WHEN col.id IS NOT NULL THEN col.vat_amount/);
    assert.match(sql, /WHEN col.id IS NOT NULL THEN col.total_amount/);
    if (params.paidOnly !== undefined) {
      assert.equal(params.paidOnly, 1);
      assert.match(sql, /p.booking_id IS NULL AND p.audit_check_id IS NULL AND col.status = 'paid'/);
      if (params.startDate) assert.match(sql, /COALESCE\(bi.booking_date, DATE\(col.created_at\)\) >= :startDate/);
    }
    return [{ ...payment }];
  }
  if (/FROM accounting_documents ad/.test(sql)) {
    return assertScope(sql, params) ? [{ ...document, customer_reference_enc: payment.customer_reference_enc }] : [];
  }
  if (/INSERT INTO accounting_document_sequences/.test(sql)) return { affectedRows: 1 };
  if (/SELECT sequence_no/.test(sql)) return [{ sequence_no: 1 }];
  if (/INSERT INTO accounting_documents/.test(sql)) {
    writes += 1;
    assert.equal(params.organizationId, 7); assert.equal(params.paymentId, 31);
    assert.equal(params.bookingId, null); assert.equal(params.auditCheckId, null);
    assert.equal(params.subtotalAmount, 100); assert.equal(params.vatAmount, 7); assert.equal(params.totalAmount, 107);
    assert.equal(params.customerName, 'ผู้ค้าหน้าตลาด');
    assert.equal(params.customerSnapshotJson.includes('Private store'), false);
    assert.equal(decryptField(JSON.parse(params.customerSnapshotJson).nameEnc), 'Private store');
    assert.deepEqual(JSON.parse(params.lineItemsJson), [{ description: 'Market service', detail: '2 x 50.00', amount: 100 }]);
    document = { id: 41, payment_id: 31, booking_id: null, audit_check_id: null, document_type: params.documentType, document_no: params.documentNo, customer_name: params.customerName,
      subtotal_amount: 100, discount_amount: 0, vat_amount: 7, total_amount: 107, document_status: 'issued' };
    return { insertId: 41 };
  }
  if (/SELECT \*.*FROM accounting_documents/s.test(sql)) {
    assert.match(sql, /organization_id = :organizationId/);
    return document && params.organizationId === 7 ? [document] : [];
  }
  throw new Error(`Unexpected accounting SQL: ${sql.slice(0, 80)}`);
}
stub('../src/config/db', { query, transaction: async work => work({ execute: async (...args) => [await query(...args)] }) });
stub('../src/utils/booking-status', { expireStaleBookings: async () => {} });
stub('../src/services/subscription.service', { assertPlanQuota: async () => {}, requireSubscriptionForMutations: () => (_req, _res, next) => next() });
stub('../src/middlewares/auth', { authenticate: (req, _res, next) => {
  req.auth = { organizationId: Number(req.get('x-test-org') || 7), sub: Number(req.get('x-test-user') || 3), role: req.get('x-test-role') || 'admin', userType: 'admin', marketIds: [2] }; next();
}, signToken: () => '' });
const app = express(); app.use(express.json());
app.use('/management', require('../src/modules/management/management.routes'));
app.use(require('../src/middlewares/error-handler').errorHandler);

test('paid POS accounting preserves organization and assigned-market scope, totals and references', async () => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/management`;
  try {
    const response = await fetch(`${base}/accounting/payments?paidOnly=1&marketId=2&dateField=booking_date&startDate=2026-11-09`);
    assert.equal(response.status, 200);
    const rows = (await response.json()).data;
    assert.equal(rows[0].payment_kind, 'audit_collection'); assert.equal(rows[0].booking_public_id, 'AC-31');
    assert.equal(rows[0].customer_name, 'Private store'); assert.equal(rows[0].vat_amount, 7); assert.equal(rows[0].total_amount, 107);
    assert.equal(rows[0].customer_reference_enc, undefined);
    for (const [path, headers] of [
      ['/accounting/payments?paidOnly=1&marketId=99', {}],
      ['/accounting/payments?paidOnly=1', { 'x-test-org': '99' }],
      ['/accounting/payments?paidOnly=1', { 'x-test-user': '4' }],
    ]) assert.deepEqual((await (await fetch(`${base}${path}`, { headers })).json()).data, []);
    const denied = await fetch(`${base}/accounting/payments?paidOnly=1`, { headers: { 'x-test-role': 'audit' } }); assert.equal(denied.status, 403);
    const reconciled = (await (await fetch(`${base}/accounting/reconciliation?marketId=2`)).json()).data;
    assert.equal(reconciled[0].reconciliation_status, 'matched');
  } finally { await new Promise(resolve => server.close(resolve)); }
});

test('POS receipts use collection line and tax snapshots, keep stored identity encrypted and remain visible to assigned admins', async () => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/management`;
  try {
    const send = headers => fetch(`${base}/accounting/payments/31/document`, { method: 'POST', headers: { 'Content-Type': 'application/json', ...headers }, body: JSON.stringify({ documentType: 'receipt' }) });
    assert.equal((await send({ 'x-test-user': '4' })).status, 404);
    const created = await send({}); assert.equal(created.status, 201);
    const result = (await created.json()).data;
    assert.equal(result.customer_name, 'Private store'); assert.equal(result.document.total_amount, 107);
    assert.equal(result.customer_reference_enc, undefined);
    assert.equal((await send({})).status, 201); assert.equal(writes, 1);
    for (const report of ['documents', 'tax-sales']) {
      const rows = (await (await fetch(`${base}/accounting/${report}`)).json()).data;
      assert.equal(rows[0].customer_name, 'Private store'); assert.equal(rows[0].customer_reference_enc, undefined);
      assert.deepEqual((await (await fetch(`${base}/accounting/${report}`, { headers: { 'x-test-user': '4' } })).json()).data, []);
    }
    for (const [method, action] of [['PATCH', 'cancel'], ['POST', 'credit-note']]) {
      const denied = await fetch(`${base}/accounting/documents/41/${action}`, {method, headers: {'Content-Type': 'application/json', 'x-test-user': '4'}, body: '{}'});
      assert.equal(denied.status, 404);
    }
    assert.ok(queries.length > 0);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
