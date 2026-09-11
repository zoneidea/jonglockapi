const test = require('node:test');
const assert = require('node:assert/strict');
const { deleteBooths } = require('../src/services/booth-deletion.service');

function connectionWith(results) {
  const calls = [];
  return {
    calls,
    async execute(sql, params) {
      calls.push({ sql, params });
      assert.match(sql, /organization_id = :organizationId/);
      assert.match(sql, /market_id = :marketId/);
      assert.equal(params.organizationId, 7);
      assert.equal(params.marketId, 9);
      const result = results.shift();
      if (result instanceof Error) throw result;
      assert.notEqual(result, undefined, 'unexpected database operation');
      return [result];
    },
  };
}

const scope = { organizationId: 7, marketId: 9, boothIds: [2, 1, 2] };

test('deletes unique selected booths with scoped parameters and locks', async () => {
  const connection = connectionWith([[{ id: 1, status: 'active' }, { id: 2, status: 'inactive' }], [], { affectedRows: 2 }]);
  const result = await deleteBooths(connection, scope);
  assert.deepEqual(result, { boothIds: [1, 2], deletedCount: 2, status: 'deleted' });
  assert.match(connection.calls[0].sql, /FOR UPDATE/);
  assert.deepEqual(connection.calls[0].params, { organizationId: 7, marketId: 9, boothId0: 1, boothId1: 2 });
});

test('missing or out-of-scope booth rejects the entire batch before update', async () => {
  const connection = connectionWith([[{ id: 1, status: 'active' }]]);
  await assert.rejects(deleteBooths(connection, scope), { statusCode: 404 });
  assert.equal(connection.calls.length, 1);
});

test('booking or lock blocker rejects the entire batch before update', async () => {
  const connection = connectionWith([[{ id: 1 }, { id: 2 }], [{ id: 2 }]]);
  await assert.rejects(deleteBooths(connection, scope), { statusCode: 409 });
  assert.equal(connection.calls.length, 2);
  assert.match(connection.calls[1].sql, /booking_items/);
  assert.match(connection.calls[1].sql, /booth_date_locks/);
});

test('already deleted booths are accepted without inflating deletedCount', async () => {
  const connection = connectionWith([[{ id: 1, status: 'deleted' }, { id: 2, status: 'deleted' }], [], { affectedRows: 0 }]);
  assert.equal((await deleteBooths(connection, scope)).deletedCount, 0);
  assert.match(connection.calls[2].sql, /status <> 'deleted'/);
});

test('database failure propagates to transaction for rollback', async () => {
  const connection = connectionWith([[{ id: 1 }, { id: 2 }], [], new Error('database failure')]);
  await assert.rejects(deleteBooths(connection, scope), /database failure/);
});
