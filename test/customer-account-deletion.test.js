const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {randomUUID} = require('node:crypto');
function stub(file, exports) { const id = require.resolve(file); require.cache[id] = { id, filename:id, loaded:true, exports }; }
let configured; let fail; let profiles; let users; let operations; let files; let cloudDeleted;
let linkedNotificationOwners;
stub('../src/utils/crypto', { blindIndex: value => `hash:${value}` });
stub('../src/config/logger', { logger: { info: () => {} } });
stub('../src/services/firebase-admin.service', {
  getFirebaseFirestore: () => configured ? {
    collection: name => { assert.equal(name,'booth_temp_locks'); return { where: (field, op, email) => {
      assert.equal(field,'ownerId'); assert.equal(op,'=='); assert.equal(email,'owner@gmail.com');
      return {limit: () => ({get: async () => cloudDeleted ? {empty:true} : {empty:false,docs:[{ref:'owned-lock'}]}})};
    }}; },
    batch: () => ({delete: ref => assert.equal(ref,'owned-lock'), commit: async () => {cloudDeleted=true;}}),
  } : null,
  getFirebaseAuth: () => ({deleteUser: async uid => {assert.equal(uid,'phone-owner');}}),
});
stub('../src/config/db', {transaction: async fn => {
  const snapshot = structuredClone({profiles,users});
  try {return await fn({execute: async (sql, p) => {
    operations.push({sql,p});
    if (sql.startsWith('SELECT id FROM public_user_profiles WHERE id <>')) return [[]];
    if (sql.includes('FROM public_user_profiles') && sql.startsWith('SELECT')) {
      assert.equal(p.emailHash,'hash:owner@gmail.com'); return [profiles];
    }
    if (sql.startsWith('SELECT id, organization_id FROM mobile_users')) return [users];
    if (sql.startsWith('DELETE psn FROM payment_status_notifications')) {
      assert.match(sql, /mn.id = psn.notification_id/);
      assert.match(sql, /mn.organization_id = psn.organization_id/);
      assert.match(sql, /mn.organization_id = :organizationId AND mn.mobile_user_id = :userId/);
      linkedNotificationOwners.delete(`${p.organizationId}:${p.userId}`);
      return [{affectedRows:1}];
    }
    if (sql.startsWith('DELETE FROM mobile_notifications')) {
      assert.ok(!linkedNotificationOwners.has(`${p.organizationId}:${p.userId}`), 'Payment notification foreign keys must be removed before parent notifications');
    }
    if (fail && sql.startsWith('UPDATE mobile_users')) throw new Error('Storage failure');
    if (sql.startsWith('UPDATE mobile_users')) {
      assert.equal(p.organizationId,users.find(user=>user.id===p.userId).organization_id);
      assert.match(sql,/email_hash = NULL/); assert.match(sql,/status = 'deleted'/);
      assert.ok(!JSON.stringify(p).includes('owner@gmail.com'));
      return [{affectedRows:1}];
    }
    if (/^DELETE FROM (mobile_device_tokens|mobile_notifications|notifications)/.test(sql)) return [{affectedRows:1}];
    if (sql.startsWith('DELETE FROM public_user_profiles')) {profiles=[]; users=[]; return [{affectedRows:1}];}
    throw new Error(`Unexpected mutation: ${sql}`);
  }});} catch (error) {({profiles,users}=snapshot); throw error;}
}});
const {deleteCustomerAccount} = require('../src/services/customer-account-deletion.service');
function reset() {
  files?.forEach(file=>fs.rmSync(file,{force:true}));
  configured=true; fail=false; operations=[]; files=[]; cloudDeleted=false;
  const dir=path.resolve(__dirname,'../uploads/public-profiles');fs.mkdirSync(dir,{recursive:true});
  const names=['avatar','gallery'].map(name=>`account-delete-test-${randomUUID()}-${name}.png`);
  files=names.map(name=>path.join(dir,name)); files.forEach(file=>fs.writeFileSync(file,'test'));
  profiles=[{id:3,firebase_uid:'phone-owner',avatar_url:`/uploads/public-profiles/${names[0]}`,store_logo_url:'https://third.example/logo.png',store_gallery_json:JSON.stringify([`/uploads/public-profiles/${names[1]}`,'/uploads/other/private.png'])}];
  users=[{id:9,organization_id:7},{id:10,organization_id:8}];
  linkedNotificationOwners=new Set(['7:9','8:10','7:99']);
}
test.afterEach(()=>{files?.forEach(file=>fs.rmSync(file,{force:true}));});
test('deletes owned profile, personal files, push tokens and cloud locks while preserving financial tables',async()=>{
  reset(); await deleteCustomerAccount({email:'owner@gmail.com'});
  assert.equal(profiles.length,0); assert.equal(cloudDeleted,true);
  assert.equal(files.length,2); // Owned upload paths only; external URLs never cause network requests.
  assert.ok(files.every(file=>!fs.existsSync(file)));
  assert.ok(files.every(file=>file.includes('/uploads/public-profiles/')));
  assert.equal(operations.filter(item=>item.sql.startsWith('UPDATE mobile_users')).length,2);
  assert.ok(!operations.some(item=>/\b(bookings|payments|payment_attempts)\b/.test(item.sql)));
});
test('removes payment notification references before parent rows, scoped to the deleted account',async()=>{
  reset(); await deleteCustomerAccount({email:'owner@gmail.com'});
  for (const user of [{id:9,organization_id:7},{id:10,organization_id:8}]) {
    const owned=operations.filter(item=>item.p.userId===user.id && item.p.organizationId===user.organization_id);
    const child=owned.findIndex(item=>item.sql.startsWith('DELETE psn FROM payment_status_notifications'));
    const parent=owned.findIndex(item=>item.sql.startsWith('DELETE FROM mobile_notifications'));
    assert.ok(child>=0 && child<parent);
  }
  assert.deepEqual([...linkedNotificationOwners],['7:99']);
});
test('deletion is idempotent and cannot recreate a deleted profile',async()=>{
  reset(); await deleteCustomerAccount({email:'owner@gmail.com'});
  assert.deepEqual(await deleteCustomerAccount({email:'owner@gmail.com'}),{deleted:true});
  assert.ok(!operations.some(item=>item.sql.startsWith('INSERT')));
});
test('missing cloud cleanup credentials fail before destructive SQL and storage errors roll back',async()=>{
  reset(); configured=false;
  await assert.rejects(deleteCustomerAccount({email:'owner@gmail.com'}),{code:'ACCOUNT_DELETION_NOT_CONFIGURED'});
  assert.equal(operations.length,0);
  reset(); fail=true;
  await assert.rejects(deleteCustomerAccount({email:'owner@gmail.com'}),/Storage failure/);
  assert.equal(profiles.length,1); assert.equal(users.length,2);
});
