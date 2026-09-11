const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const publicSource = fs.readFileSync(path.join(__dirname, '../src/modules/public/public.routes.js'), 'utf8');
const mobileSource = fs.readFileSync(path.join(__dirname, '../src/modules/mobile/mobile.routes.js'), 'utf8');

function route(source, name) {
  const start = source.indexOf(`'${name}'`);
  assert.notEqual(start, -1);
  const end = source.indexOf('\nrouter.', start);
  return source.slice(start, end === -1 ? undefined : end);
}

for (const name of ['/floor-plans/:floorPlanId/booths', '/floor-plans/:floorPlanId/booths/availability', '/booths/:boothId/availability']) {
  test(`${name} filters inactive booths and draft locks with tenant scope`, () => {
    const sql = route(publicSource, name);
    assert.match(sql, /AND b\.status = 'active'/);
    assert.match(sql, /booking\.id = bdl\.booking_id/);
    assert.match(sql, /booking\.organization_id = bdl\.organization_id/);
    assert.match(sql, /booking\.market_id = bdl\.market_id/);
    assert.match(sql, /booking\.status <> 'draft'/);
    assert.match(sql, /bdl\.status IN \('held', 'processing', 'paid'\)/);
  });
}

test('authenticated mobile endpoint excludes draft locks in LEFT JOIN', () => {
  const sql = route(mobileSource, '/markets/:marketId/booths');
  assert.match(sql, /AND b\.status = 'active'/);
  assert.match(sql, /AND EXISTS \([\s\S]*booking\.status <> 'draft'[\s\S]*\)\s+WHERE b\.organization_id/);
});
