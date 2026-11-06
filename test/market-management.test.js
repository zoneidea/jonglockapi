const test = require('node:test');
const assert = require('node:assert/strict');
const { softDeleteMarket, updateMarketBasics } = require('../src/services/market-management.service');
const scope = { organizationId: 7, marketId: 9 };
function connection(results) {
  const calls = [];
  return { calls, async execute(sql, params) {
    calls.push({ sql, params });
    assert.equal(params.organizationId, 7);
    assert.equal(params.marketId, 9);
    assert.match(sql, /organization_id = :organizationId/);
    const result = results.shift();
    assert.notEqual(result, undefined, 'Unexpected SQL');
    if (result instanceof Error) throw result;
    return [result];
  } };
}
const market = [{ id: 9, status: 'active', deleted_at: null }];
test('basic edit changes only name and status, not contact/profile fields', async () => {
  const conn = connection([market, { affectedRows: 1 }]);
  assert.deepEqual(await updateMarketBasics(conn, scope, { name: 'New', status: 'inactive' }), { id: 9, name: 'New', status: 'inactive' });
  assert.match(conn.calls[0].sql, /FOR UPDATE/);
  assert.doesNotMatch(conn.calls[1].sql, /address|description|terms|phone/);
});
test('missing, cross-tenant and deleted markets cannot be changed', async () => {
  for (const rows of [[], [{ id: 9, deleted_at: '2026-09-16' }]]) {
    await assert.rejects(updateMarketBasics(connection([rows]), scope, { name: 'X', status: 'active' }), { statusCode: 404 });
    await assert.rejects(softDeleteMarket(connection([rows]), scope), { statusCode: 404 });
  }
});
test('paid/refunded booking history blocks deletion even after status changes', async () => {
  for (const booking of [{ status: 'paid' }, { status: 'refunded' }, { status: 'cancelled', paid_at: '2026-09-01' }]) {
    const conn = connection([market, [booking]]);
    await assert.rejects(softDeleteMarket(conn, scope), { statusCode: 409 });
    assert.equal(conn.calls.length, 2);
  }
});
test('payment history or paid booking items blocks deletion', async () => {
  for (const results of [[[{ id: 1 }], []], [[], [{ id: 1 }]]]) {
    const conn = connection([market, [{ status: 'expired' }], ...results]);
    await assert.rejects(softDeleteMarket(conn, scope), { statusCode: 409 });
    assert.equal(conn.calls.length, 4);
    assert.match(conn.calls[2].sql, /paid_at IS NOT NULL/);
  }
});
test('unfinished booking is protected from deletion during checkout', async () => {
  for (const status of ['draft', 'pending_payment', 'payment_processing']) {
    await assert.rejects(softDeleteMarket(connection([market, [{ status }], [], []]), scope), { statusCode: 409 });
  }
});
test('soft deletion preserves dependent rows and marks inactive with timestamp', async () => {
  const conn = connection([market, [{ status: 'cancelled' }, { status: 'expired' }], [], [], { affectedRows: 1 }]);
  assert.deepEqual(await softDeleteMarket(conn, scope), { id: 9, deleted: true });
  assert.match(conn.calls[4].sql, /status = 'inactive', deleted_at = CURRENT_TIMESTAMP/);
  assert.ok(conn.calls.every(({ sql }) => !/DELETE FROM/.test(sql)));
});
test('write errors propagate for transaction rollback', async () => {
  await assert.rejects(softDeleteMarket(connection([market, [], [], [], new Error('write failure')]), scope), /write failure/);
});

test('basic edit updates collection, image and weekdays without replacing contact fields', async () => {
  const conn = connection([[{id:9, main_image_url:'/uploads/old.jpg'}], {affectedRows:1}]);
  const result = await updateMarketBasics(conn, scope, {name:'New',status:'active',collectionMode:'self',openDays:['mon','fri','mon'],mainImageUrl:'/uploads/new.jpg'});
  assert.deepEqual(result.openDays,['mon','fri']);
  assert.equal(result.previousMainImageUrl,'/uploads/old.jpg');
  assert.equal(conn.calls[1].params.collectionMode,'self');
  assert.equal(conn.calls[1].params.openDaysJson,'["mon","fri"]');
  assert.equal(conn.calls[1].params.mainImageUrl,'/uploads/new.jpg');
  assert.doesNotMatch(conn.calls[1].sql,/address|phone|email|description|terms/);
});
test('older basic payloads preserve collection, image and weekdays', async () => {
  const conn = connection([market,{affectedRows:1}]);
  await updateMarketBasics(conn,scope,{name:'New',status:'active'});
  assert.equal(conn.calls[1].params.collectionMode,null);
  assert.equal(conn.calls[1].params.mainImageUrl,null);
  assert.equal(conn.calls[1].params.openDaysJson,null);
});
test('basic update validates JSON and multipart weekday/collection fields', () => {
  const {marketBasicUpdateSchema:schema}=require('../src/utils/market-basic-update');
  const base={name:'Market',status:'active'};
  assert.deepEqual(schema.parse({...base,openDays:'["mon","sat"]'}).openDays,['mon','sat']);
  assert.equal(schema.safeParse({...base,openDays:'[]'}).success,false);
  assert.equal(schema.safeParse({...base,openDays:'not json'}).success,false);
  assert.equal(schema.safeParse({...base,collectionMode:'unknown'}).success,false);
  assert.equal(schema.safeParse({...base,organizationId:99}).success,false);
});
