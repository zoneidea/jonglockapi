const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
const calls = [];
const id = require.resolve('../src/services/organization-payment-settings.service');
require.cache[id] = { id, filename: id, loaded: true, exports: {
  getSettings: async organizationId => {calls.push(['get', organizationId]); return {mode: 'manual', details: {qrCodeImageUrl: ''}};},
  saveSettings: async (organizationId, body) => {calls.push(['save', organizationId, body]); return {mode: body.mode};},
  disableGateway: async organizationId => {calls.push(['disable', organizationId]); return {mode: 'manual'};},
  adoptMarketSettings: async (organizationId, marketId) => {calls.push(['adopt', organizationId, marketId]); return {mode: 'gateway'};},
} };
const { requireRoles } = require('../src/middlewares/rbac');
const app = express();
app.use(express.json());
app.use('/organization-settings/payments', (req, _res, next) => {
  req.auth = {organizationId: 7, role: req.get('x-test-role') || 'supervisor'}; next();
}, requireRoles('supervisor'), require('../src/modules/payments/organization-payment-settings.routes'));
app.use((error, _req, res, _next) => res.status(error.statusCode || 500).json({code: error.code}));
test('organization settings require supervisor and never accept a frontend tenant ID', async () => {
  const server = app.listen(0, '127.0.0.1'); await new Promise(resolve => server.once('listening', resolve));
  const base = `http://127.0.0.1:${server.address().port}/organization-settings/payments`;
  try {
    const admin = await fetch(base, {headers: {'x-test-role': 'admin'}});
    assert.equal(admin.status, 403); assert.equal(calls.length, 0);
    const body = {mode: 'manual', details: {accountNumber: '1234567890'}};
    const rejected = await fetch(base, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({...body, organizationId: 99})});
    assert.equal(rejected.status, 400); assert.equal(calls.length, 0);
    const saved = await fetch(base, {method: 'PUT', headers: {'Content-Type': 'application/json'}, body: JSON.stringify(body)});
    assert.equal(saved.status, 200); assert.equal(calls.at(-1)[1], 7);
    const cancelled = await fetch(`${base}/disable`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({confirmed: false})});
    assert.equal(cancelled.status, 400);
    assert.ok(!calls.some(call => call[0] === 'disable'));
    const adopted = await fetch(`${base}/adopt`, {method: 'POST', headers: {'Content-Type': 'application/json'}, body: JSON.stringify({sourceMarketId: 33, confirmed: true})});
    assert.equal(adopted.status, 200); assert.deepEqual(calls.at(-1), ['adopt', 7, 33]);
  } finally { await new Promise(resolve => server.close(resolve)); }
});
