const test = require('node:test');
const assert = require('node:assert/strict');
const id = require.resolve('../src/config/db');
const row = {country_code:'TH',code:'004',name_th:'ธนาคารกสิกรไทย',name_en:'Kasikornbank',short_name:'KBANK'};
let queries = 0;
require.cache[id] = {id,filename:id,loaded:true,exports:{query:async(sql,params) => {
  queries += 1;
  assert.ok(sql.includes("country_code = 'TH'")); assert.ok(sql.includes("status = 'active'"));
  return !params || params.code === '004' ? [row] : [];
}}};
const { listActiveBanks, findActiveBank } = require('../src/services/bank-master.service');
const { BankMasterInitializer } = require('../src/services/bank-master-initializer');
const seed = require('../src/data/banks.th.json');
test('bank master retains leading-zero codes and excludes missing/inactive banks', async () => {
  assert.deepEqual(await listActiveBanks(),[{code:'004',countryCode:'TH',nameTh:row.name_th,nameEn:'Kasikornbank',shortName:'KBANK'}]);
  assert.equal((await findActiveBank('004')).code,'004');
  await assert.rejects(findActiveBank('999'),{code:'INVALID_BANK_CODE'});
  const before = queries;
  await assert.rejects(findActiveBank('4'),{code:'INVALID_BANK_CODE'});
  assert.equal(queries,before);
});
test('portable bank initialization is repeatable without overwriting operator changes', async () => {
  const existing = new Map([['004',{code:'004',nameTh:'Custom name',status:'inactive'}]]);
  let creates = 0;
  const conn = {query:async sql => {assert.ok(sql.includes('CREATE TABLE IF NOT EXISTS master_banks'));creates += 1;},execute:async(sql,bank) => {
    assert.ok(sql.startsWith('INSERT IGNORE'));assert.match(bank.code,/^\d{3}$/);
    if (!existing.has(bank.code)) existing.set(bank.code,bank);
  }};
  const initializer = new BankMasterInitializer();
  await initializer.initialize(conn); await initializer.initialize(conn);
  assert.equal(creates,2);assert.equal(existing.size,seed.length);
  assert.equal(existing.get('004').nameTh,'Custom name');assert.equal(existing.get('004').status,'inactive');
  assert.equal(new Set(seed.map(bank => bank.code)).size,seed.length);
});
