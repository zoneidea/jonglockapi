const test = require('node:test');
const assert = require('node:assert/strict');
const { cacheResponse, clearResponseCache, getResponseCacheStats } = require('../src/middlewares/response-cache');

function response() {
  return {
    statusCode: 200, headers: {},
    setHeader(key, value) { this.headers[key] = value; },
    getHeader(key) { return this.headers[key]; },
    status(value) { this.statusCode = value; return this; },
    json(value) { this.body = value; return this; },
  };
}
const req = { method: 'GET', originalUrl: '/api/locations/provinces?geographyId=1', headers: {} };

test('cache hit avoids loader and isolates stored response objects', () => {
  clearResponseCache();
  const middleware = cacheResponse({ namespace: 'locations' });
  const data = { data: [{ id: 1 }] };
  const first = response();
  middleware(req, first, () => {});
  first.json(data);
  data.data[0].id = 999;
  const hit = response();
  middleware(req, hit, () => assert.fail('cache miss'));
  assert.equal(hit.headers['X-Cache'], 'HIT');
  assert.equal(hit.body.data[0].id, 1);
});

test('query filters, authentication, non-GET and error responses never share cached data', () => {
  clearResponseCache();
  const middleware = cacheResponse({ namespace: 'locations' });
  const first = response();
  middleware(req, first, () => {});
  first.json({ ok: true });
  for (const request of [
    { ...req, originalUrl: '/api/locations/provinces?geographyId=2' },
    { ...req, auth: { organizationId: 1 } },
    { ...req, headers: { authorization: 'Bearer test' } },
    { ...req, headers: { cookie: 'session=test' } },
    { ...req, method: 'POST' },
  ]) {
    let called = false;
    middleware(request, response(), () => { called = true; });
    assert.equal(called, true);
  }
  clearResponseCache();
  const failure = response();
  middleware(req, failure, () => {});
  failure.status(500).json({ error: true });
  assert.equal(getResponseCacheStats().size, 0);
});

test('TTL expires without returning stale values', async () => {
  clearResponseCache();
  const middleware = cacheResponse({ namespace: 'locations', ttlSeconds: 0.01 });
  const res = response();
  middleware(req, res, () => {});
  res.json({ ok: true });
  await new Promise(resolve => setTimeout(resolve, 30));
  assert.equal(getResponseCacheStats().size, 0);
});

test('namespace limits and invalidation do not evict other namespaces', () => {
  clearResponseCache();
  for (const namespace of ['locations', 'public:markets']) {
    const middleware = cacheResponse({ namespace, maxEntries: 1 });
    for (const id of [1, 2]) {
      const res = response();
      middleware({ ...req, originalUrl: `/items/${id}` }, res, () => {});
      res.json({ id });
    }
  }
  assert.equal(getResponseCacheStats().size, 2);
  assert.equal(clearResponseCache('public:'), 1);
  assert.equal(getResponseCacheStats().size, 1);
});

test('in-flight responses cannot repopulate an invalidated cache', () => {
  clearResponseCache();
  const res = response();
  cacheResponse({ namespace: 'locations' })(req, res, () => {});
  clearResponseCache('locations');
  res.json({ stale: true });
  assert.equal(getResponseCacheStats().size, 0);
});
