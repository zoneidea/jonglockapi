const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');

// Isolated test process: substitute external boundaries so no production DB,
// Firebase or credentials are touched by route tests.
function stub(path, exports) {
  const id = require.resolve(path);
  require.cache[id] = { id, filename: id, loaded: true, exports };
}
let databaseCalls = 0;
stub('../src/config/db', {
  query: async () => { databaseCalls += 1; return []; },
  transaction: async () => { throw new Error('writes must not reach the database in authorization tests'); },
});
stub('../src/config/logger', { logger: { info() {} } });
stub('../src/utils/crypto', { decryptField: (v) => v });
stub('../src/middlewares/auth', {
  authenticate(req, res, next) {
    const actor = req.headers.authorization;
    if (!actor) return res.status(401).json({ message: 'Unauthorized' });
    req.auth = { sub: actor, userType: actor === 'management' ? 'admin' : 'platform' };
    return next();
  },
});
stub('../src/modules/platform/platform.service', {
  getPlatformUserById: async (actor) => ({
    role: `platform_${actor}`,
    menus: ['superadmin', 'support', 'ops'].includes(actor) ? ['organizations'] : [],
  }),
  listOrganizations: async () => ({ items: [] }),
  getOrganizationDetail: async () => ({ id: 7 }),
});
const routes = require('../src/modules/platform/platform.routes');

test('organization routes require platform/menu/write authorization before data access', async () => {
  const app = express();
  app.use(express.json());
  app.use('/platform', routes);
  app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({ message: error.message }));
  const server = app.listen(0, '127.0.0.1');
  await new Promise((resolve) => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/platform/organizations`;
  try {
    const get = (path, actor) => fetch(`${base}${path}`, { headers: actor ? { authorization: actor } : {} });
    assert.equal((await get('')).status, 401);
    assert.equal((await get('', 'management')).status, 403);
    for (const actor of ['billing', 'audit']) {
      assert.equal((await get('', actor)).status, 403);
      assert.equal((await get('/7', actor)).status, 403);
      assert.equal((await get('/7/bookings', actor)).status, 403);
    }
    for (const actor of ['superadmin', 'support', 'ops']) {
      const response = await get('', actor);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
    }
    const deniedWrite = await fetch(`${base}/7/users/2`, { method: 'PATCH', headers: { authorization: 'ops', 'content-type': 'application/json' }, body: JSON.stringify({ status: 'inactive' }) });
    assert.equal(deniedWrite.status, 403);
    const invalidWrite = await fetch(`${base}/7/users/2`, { method: 'PATCH', headers: { authorization: 'support', 'content-type': 'application/json' }, body: JSON.stringify({ password: 'short' }) });
    assert.equal(invalidWrite.status, 400);
    assert.equal((await get('/7/markets/99/booths?zoneId=-1', 'superadmin')).status, 400);
    assert.equal((await get('/7/bookings?dateFrom=2026-02-30', 'superadmin')).status, 400);
    assert.equal(databaseCalls, 0);
  } finally {
    await new Promise((resolve) => server.close(resolve));
  }
});
