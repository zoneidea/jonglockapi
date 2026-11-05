const test = require('node:test');
const assert = require('node:assert/strict');
function stub(path, exports) {
  const id = require.resolve(path); require.cache[id] = { id, filename: id, loaded: true, exports };
}
stub('../src/config/env', { FIELD_ENCRYPTION_KEY: Buffer.alloc(32, 17).toString('base64'), FIELD_HASH_SECRET: 'test-only-secret' });
const { decryptField, encryptField } = require('../src/utils/crypto');
let sourceRow; let row; let calls; let busy; let active; let bankCreated; let loseBankResponse;
const recipient = { bankCode: '004', accountNumber: '1234567890', accountName: 'Test Recipient', email: 'recipient@example.test', phone: '' };
const notFound = () => Object.assign(new Error('not found'), { providerCode: 'NOT_FOUND' });
async function query(sql, p) {
  if (!sql.includes('payment-status')) {
    if (p.organizationId !== 7) throw new Error('tenant scope lost');
  }
  if (sql.includes('FROM organizations WHERE id')) return [{ id: 7 }];
  if (sql.includes('FROM market_payment_settings')) return sourceRow && (!p.marketId || p.marketId === 33) ? [{...sourceRow, market_id: 33, market_name: 'Market A'}] : [];
  if (sql.startsWith('SELECT') && sql.includes('FROM organization_payment_settings')) return row ? [{ ...row }] : [];
  if (sql.startsWith('INSERT IGNORE')) { if (!row) row = { mode: 'manual', sync_state: 'inactive', generation: 1, details_enc: p.details }; return { affectedRows: 1 }; }
  if (sql.includes("sync_state = 'syncing'")) {
    if (busy) return { affectedRows: 0 };
    row.lease_token = p.token; row.sync_state = 'syncing'; return { affectedRows: 1 };
  }
  if (sql.startsWith('SELECT id FROM bookings')) return active ? [{ id: 1 }] : [];
  if (sql.includes('migration_conflict = 0')) Object.assign(row, {mode:p.mode, sync_state:p.state, details_enc:p.details, recipient_details_enc:p.recipient, contact_id:p.contactId, bank_account_id:p.bankId, generation:p.generation, source_market_id:p.marketId, migration_conflict:0});
  else if (sql.includes('recipient_details_enc = :encrypted')) row.recipient_details_enc = p.encrypted;
  else if (sql.includes('details_enc = :details')) Object.assign(row, { details_enc: p.details, contact_id: p.contactId, bank_account_id: p.bankAccountId });
  else if (sql.includes('mode = :mode')) Object.assign(row, { mode: p.mode, sync_state: p.state });
  else if (sql.includes("mode = 'manual'")) Object.assign(row, { mode: 'manual', sync_state: 'inactive', contact_id: null, bank_account_id: null, details_enc: null, generation: row.generation + 1 });
  else if (sql.includes("sync_state = 'error'")) row.sync_state = 'error';
  else throw new Error(`Unexpected query ${sql}`);
  return { affectedRows: 1 };
}
stub('../src/config/db', { query, transaction: async fn => {
  const snapshot = structuredClone(row);
  try { return await fn({ execute: async (sql, p) => [await query(sql, p)] }); }
  catch (error) { row = snapshot; throw error; }
} });
stub('../src/services/payment-activity.service', { activity: async () => {} });
stub('../src/services/reservepay.service', { callMerchantApi: async (endpoint, body) => {
  calls.push({ endpoint, body });
  if (endpoint === 'retrieve-contact') throw notFound();
  if (endpoint === 'find-bank-account') {
    if (!bankCreated) throw notFound();
    return { bank_account_id: 'bka_test', owner: 'CONTACT', primary: true, bank_code: recipient.bankCode, number: recipient.accountNumber, name: recipient.accountName };
  }
  if (endpoint === 'add-contact') {
    // The locally stored recipient is encrypted even if the remote call fails.
    assert.equal(decryptField(row.recipient_details_enc), JSON.stringify(recipient));
    assert.ok(!row.recipient_details_enc.includes(recipient.accountNumber));
    return 'ctc_test';
  }
  if (endpoint === 'link-bank-account') {
    bankCreated = true;
    if (loseBankResponse) { loseBankResponse = false; throw new Error('Response lost after provider commit'); }
    return 'bka_test';
  }
  return true;
} });
const settings = require('../src/services/organization-payment-settings.service');
function reset() { sourceRow = null; row = null; calls = []; busy = false; active = false; bankCreated = false; loseBankResponse = false; }
test('registers and encrypts a recipient; repeated saves never duplicate the account or call update-bank-account', async () => {
  reset();
  const saved = await settings.saveSettings(7, { mode: 'gateway', details: recipient });
  assert.equal(saved.mode, 'gateway'); assert.equal(saved.syncState, 'ready');
  assert.equal(decryptField(row.details_enc), JSON.stringify(recipient));
  await settings.saveSettings(7, { mode: 'gateway', details: recipient });
  assert.equal(calls.filter(c => c.endpoint === 'add-contact').length, 1);
  assert.equal(calls.filter(c => c.endpoint === 'link-bank-account').length, 1);
  assert.equal(calls.filter(c => c.endpoint === 'update-bank-account').length, 0);
  await assert.rejects(settings.saveSettings(7, { mode: 'gateway', details: { ...recipient, accountNumber: '9999999999' } }), { code: 'RECIPIENT_ALREADY_REGISTERED' });
});
test('disabling removes only this contact and retains the encrypted local recipient', async () => {
  reset(); await settings.saveSettings(7, { mode: 'gateway', details: recipient });
  const result = await settings.disableGateway(7);
  assert.equal(result.mode, 'manual'); assert.equal(result.contactId, null);
  assert.equal(result.recipientDetails.accountNumber, recipient.accountNumber);
  assert.deepEqual(calls.find(c => c.endpoint === 'remove-contact').body, { contact_id: 'ctc_test' });
});
test('active payments and concurrent saves block recipient changes before contacting the provider', async () => {
  reset(); active = true;
  await assert.rejects(settings.saveSettings(7, { mode: 'gateway', details: recipient }), { code: 'PAYMENT_IN_PROGRESS' });
  assert.equal(calls.length, 0);
  active = false; busy = true;
  await assert.rejects(settings.saveSettings(7, { mode: 'gateway', details: recipient }), { code: 'SETTINGS_BUSY' });
  assert.equal(calls.length, 0);
});
test('manual policy disables gateway and gateway policy disables direct manual payment', async () => {
  reset(); row = { mode: 'manual', sync_state: 'inactive' };
  const conn = { execute: async (sql, p) => [await query(sql, p)] };
  await assert.rejects(settings.assertGatewayAllowed(conn, 7), { code: 'ORGANIZATION_GATEWAY_DISABLED' });
  row.mode = 'gateway'; row.sync_state = 'ready';
  await settings.assertGatewayAllowed(conn, 7);
  await assert.rejects(settings.assertManualAllowed(conn, 7), { code: 'ORGANIZATION_MANUAL_PAYMENT_DISABLED' });
});

test('lost bank-link response keeps encrypted details and recovers the original account without duplication', async () => {
  reset(); loseBankResponse = true;
  await assert.rejects(settings.saveSettings(7, { mode: 'gateway', details: recipient }), /Response lost/);
  assert.equal(row.sync_state, 'error'); assert.equal(row.mode, 'manual');
  assert.equal(row.contact_id, 'ctc_test');
  assert.equal(decryptField(row.recipient_details_enc), JSON.stringify(recipient));
  const result = await settings.saveSettings(7, { mode: 'gateway', details: recipient });
  assert.equal(result.syncState, 'ready'); assert.equal(result.bankAccountId, 'bka_test');
  assert.equal(calls.filter(c => c.endpoint === 'link-bank-account').length, 1);
  assert.equal(calls.filter(c => c.endpoint === 'add-contact').length, 1);
});

test('organization channels are shared across market readers and changes use only tenant scope', async () => {
  reset();
  await settings.saveSettings(7, { mode: 'manual', details: { accountNumber: '1234567890' } });
  const firstMarket = await settings.paymentOptions(7);
  const secondMarket = await settings.paymentOptions(7);
  assert.deepEqual(firstMarket, secondMarket);
  assert.equal(firstMarket.scope, 'organization');
  assert.equal(firstMarket.mode, 'manual');
  await settings.saveSettings(7, { mode: 'gateway', details: recipient });
  assert.equal((await settings.paymentOptions(7)).mode, 'gateway');
  await assert.rejects(settings.getSettings(99), /tenant scope lost/);
});
test('migration conflicts block both payment channels until an organization choice is confirmed', async () => {
  reset(); row = { mode: 'manual', sync_state: 'error', migration_conflict: 1 };
  assert.equal((await settings.paymentOptions(7)).mode, 'unavailable');
  const conn = { execute: async (sql, p) => [await query(sql, p)] };
  await assert.rejects(settings.assertGatewayAllowed(conn, 7), { code: 'ORGANIZATION_GATEWAY_DISABLED' });
  await assert.rejects(settings.assertManualAllowed(conn, 7), { code: 'ORGANIZATION_MANUAL_PAYMENT_DISABLED' });
});

test('supervisor adoption preserves the chosen encrypted account and cannot select a foreign market', async () => {
  reset(); row = { mode: 'manual', sync_state: 'error', migration_conflict: 1 };
  sourceRow = {mode:'gateway',sync_state:'ready',details_enc:encryptField(JSON.stringify(recipient)),recipient_details_enc:encryptField(JSON.stringify(recipient)),contact_id:'ctc_existing',bank_account_id:'bka_existing',generation:4};
  await assert.rejects(settings.adoptMarketSettings(7, 999), {code:'SETTINGS_NOT_FOUND'});
  assert.equal(row.migration_conflict, 1);
  const result = await settings.adoptMarketSettings(7, 33);
  assert.equal(result.migrationConflict, false); assert.equal(result.contactId, 'ctc_existing');
  assert.equal(result.recipientDetails.accountNumber, recipient.accountNumber);
  assert.equal(row.source_market_id, 33); assert.equal(row.generation, 4);
  assert.equal(calls.length, 0);
});
test('a migrated partial registration retains its original market external identity for safe retries', async () => {
  reset(); row = { mode: 'gateway', sync_state: 'error', generation: 4, source_market_id: 33,
    recipient_details_enc: encryptField(JSON.stringify(recipient)) };
  await settings.saveSettings(7, {mode:'gateway',details:recipient});
  assert.equal(calls.find(call => call.endpoint === 'retrieve-contact').body.contact_id, 'jl-market-7-33-4');
});
