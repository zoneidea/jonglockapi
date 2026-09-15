const test = require('node:test');
const assert = require('node:assert/strict');
const { createOrganizationService } = require('../src/modules/platform/organization.service');
const { userSchema, bookingsSchema, boothsSchema, listSchema } = require('../src/modules/platform/organization.schemas');

function harness(results = []) {
  const calls = [];
  const logs = [];
  const run = async (sql, params) => {
    calls.push({ sql, params });
    assert.equal(params.organizationId, 7);
    assert.match(sql, /:organizationId/);
    const result = results.shift();
    assert.notEqual(result, undefined, 'unexpected query');
    if (result instanceof Error) throw result;
    return result;
  };
  return { calls, logs, service: createOrganizationService({
    query: run,
    transaction: (handler) => handler({ execute: async (sql, params) => [await run(sql, params)] }),
    decryptField: (v) => v ? `decoded:${v}` : '',
    hashPassword: async () => 'hashed-password',
    logger: { info: (event) => logs.push(event) },
  }) };
}

test('organizations pagination is bounded and IDs cannot inject SQL', () => {
  assert.equal(listSchema.safeParse({ params: { organizationId: '7' }, query: { pageSize: '101' } }).success, false);
  assert.equal(boothsSchema.safeParse({ params: { organizationId: '7', marketId: '1 OR 1=1' }, query: {} }).success, false);
  assert.equal(listSchema.parse({ params: { organizationId: '7' }, query: {} }).query.pageSize, 20);
});

test('report rejects reversed and nonexistent dates', () => {
  const parse = (query) => bookingsSchema.safeParse({ params: { organizationId: 7 }, query }).success;
  assert.equal(parse({ dateFrom: '2026-02-30' }), false);
  assert.equal(parse({ dateFrom: '2026-09-12', dateTo: '2026-09-11' }), false);
  assert.equal(parse({ dateFrom: '2024-02-29', dateTo: '2024-02-29' }), true);
  assert.equal(parse({}), true);
});

test('password/status actions reject weak, oversized, mixed and empty payloads', () => {
  const parse = (body) => userSchema.safeParse({ params: { organizationId: 7, userId: 2 }, query: {}, body }).success;
  assert.equal(parse({ password: 'short' }), false);
  assert.equal(parse({ password: `A1!${'ก'.repeat(24)}` }), false);
  assert.equal(parse({ status: 'deleted' }), false);
  assert.equal(parse({ status: 'active', password: 'ExampleOnly1!' }), false);
  assert.equal(parse({}), false);
  assert.equal(parse({ password: 'ExampleOnly1!' }), true);
  assert.equal(parse({ status: 'inactive' }), true);
});

test('markets return all pages without an active-only filter', async () => {
  const h = harness([[{ id: 7 }], [{ total: 22 }], [{ id: 9, name: 'Market', status: 'inactive', zone_count: 2, booth_count: 3 }]]);
  const result = await h.service.listMarkets(7, { page: 2, pageSize: 20 });
  assert.equal(result.pagination.totalPages, 2);
  assert.equal(result.items[0].status, 'inactive');
  assert.equal(h.calls[2].params.offset, 20);
});

test('market from another organization cannot expose zones or booths', async () => {
  for (const method of ['listZones', 'listBooths']) {
    const h = harness([[]]);
    await assert.rejects(h.service[method](7, 99, {}), { statusCode: 404 });
    assert.equal(h.calls.length, 1);
    assert.match(h.calls[0].sql, /organization_id = :organizationId AND id = :marketId/);
  }
});

test('zone must belong to selected market before querying booths', async () => {
  const h = harness([[{ id: 9 }], []]);
  await assert.rejects(h.service.listBooths(7, 9, { zoneId: 55 }), { statusCode: 404 });
  assert.equal(h.calls.length, 2);
  assert.match(h.calls[1].sql, /market_id = :marketId AND id = :zoneId/);
});

test('booths include inactive and unassigned but exclude deleted', async () => {
  const h = harness([[{ id: 9 }], [{ total: 1 }], [{ id: 1, status: 'inactive', price: '10.00' }]]);
  const result = await h.service.listBooths(7, 9, {});
  assert.equal(result.items[0].zoneName, 'ไม่ระบุโซน');
  assert.equal(result.items[0].price, 10);
  assert.match(h.calls[2].sql, /LEFT JOIN floor_plans/);
  assert.match(h.calls[2].sql, /b.status <> 'deleted'/);
});

test('user response decrypts only allowed contact fields and omits hashes', async () => {
  const h = harness([[{ id: 7 }], [{ total: 1 }], [{ id: 2, role: 'audit', status: 'inactive', name_enc: 'name', password_hash: 'secret' }]]);
  const result = await h.service.listUsers(7, {});
  assert.equal(result.items[0].name, 'decoded:name');
  assert.equal('password_hash' in result.items[0], false);
});

test('reset uses scoped update, hash only, and preserves existing sessions', async () => {
  const h = harness([[{ id: 7 }], [{ id: 2, role: 'admin', status: 'active' }], { affectedRows: 1 }]);
  const result = await h.service.updateUser(7, 2, { password: 'ExampleOnly1!' }, 8);
  assert.equal(result.passwordReset, true);
  assert.equal(result.existingSessionsRevoked, false);
  assert.equal(h.calls[2].params.passwordHash, 'hashed-password');
  assert.match(h.calls[2].sql, /organization_id = :organizationId AND id = :userId/);
  assert.equal(JSON.stringify(result).includes('ExampleOnly1!'), false);
  assert.equal(JSON.stringify(h.logs).includes('passwordHash'), false);
});

test('cross-organization user is rejected before mutation', async () => {
  const h = harness([[{ id: 7 }], []]);
  await assert.rejects(h.service.updateUser(7, 99, { status: 'inactive' }, 8), { statusCode: 404 });
  assert.equal(h.calls.length, 2);
  assert.equal(h.logs.length, 0);
});

test('final active supervisor cannot be disabled and org row serializes changes', async () => {
  const h = harness([[{ id: 7 }], [{ id: 2, role: 'supervisor', status: 'active' }], [{ id: 2 }]]);
  await assert.rejects(h.service.updateUser(7, 2, { status: 'inactive' }, 8), { statusCode: 409 });
  assert.match(h.calls[0].sql, /FOR UPDATE/);
  assert.equal(h.calls.length, 3);
});

test('disable and enable are supported without changing passwords', async () => {
  for (const status of ['active', 'inactive']) {
    const h = harness([[{ id: 7 }], [{ id: 2, role: 'audit', status: 'active' }], { affectedRows: 1 }]);
    const result = await h.service.updateUser(7, 2, { status }, 8);
    assert.equal(result.status, status);
    assert.equal(result.passwordReset, false);
    assert.equal(h.calls[2].params.status, status);
  }
});

test('report dates use EXISTS on booking items without duplicating booking totals', async () => {
  const h = harness([[{ id: 7 }], [{ id: 9 }], [{ total: 1 }], [{ id: 1, total_amount: '250', status: 'draft' }]]);
  const result = await h.service.listBookings(7, { marketId: 9, dateFrom: '2026-09-01', dateTo: '2026-09-30' });
  assert.equal(result.items[0].totalAmount, 250);
  assert.equal(result.items[0].status, 'draft');
  assert.match(h.calls[2].sql, /EXISTS.*booking_items/s);
  assert.match(h.calls[3].sql, /bi.booking_date >= :dateFrom AND bi.booking_date <= :dateTo/);
  assert.equal(h.calls[3].params.marketId, 9);
});

test('failed update produces no success audit log', async () => {
  const h = harness([[{ id: 7 }], [{ id: 2, role: 'admin', status: 'active' }], new Error('write failed')]);
  await assert.rejects(h.service.updateUser(7, 2, { status: 'inactive' }, 8), /write failed/);
  assert.equal(h.logs.length, 0);
});
