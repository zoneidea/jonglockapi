const test=require('node:test');
const assert=require('node:assert/strict');
const id=require.resolve('../src/config/db');
let row=null;const calls=[];
require.cache[id]={id,filename:id,loaded:true,exports:{query:async(sql,params)=>{
 calls.push({sql,params});
 if(sql.includes('FROM market_layouts')) {
  assert.match(sql,/ml.status = 'published'/);assert.match(sql,/ml.is_active = 1/);
  assert.match(sql,/ml.floor_plan_id = :floorPlanId/);assert.match(sql,/m.collection_mode = 'system'/);
  assert.match(sql,/m.deleted_at IS NULL/);assert.match(sql,/o.status = 'active'/);
  return row ? [row] : [];
 }
 assert.match(sql,/organization_id = :organizationId/);assert.equal(params.organizationId,7);
 assert.equal(params.marketId,9);assert.equal(params.floorPlanId,5);
 return [{id:10,code:'A01'}];
}}};
const {getPublishedMarketLayout}=require('../src/services/public-market-layout.service');
test('no published matching plan returns null',async()=>{
 assert.equal(await getPublishedMarketLayout(9,5),null);
 assert.equal(calls.length,1);
});
test('published response excludes admin data and booths outside the exact market/floor plan',async()=>{
 row={id:1,market_id:9,organization_id:7,floor_plan_id:5,name:'Plan',rows_count:2,columns_count:3,
 layout_json:JSON.stringify({items:[
 {id:'a',type:'booth',boothId:10,row:1,col:1},
 {id:'b',type:'booth',boothId:99,row:1,col:2},
 {id:'t',type:'tree',label:'ต้นไม้',row:2,col:3},
 {id:'x',type:'custom',row:3,col:1},
 {id:'bad',type:'script',row:1,col:3},
 ]}),created_by:77,updated_by:88};
 const plan=await getPublishedMarketLayout(9,5);
 assert.deepEqual(plan.items.map(i=>i.id),['a','t']);
 assert.equal(plan.items[0].label,'A01');assert.equal(plan.floorPlanId,5);
 assert.equal(plan.createdBy,undefined);assert.equal(plan.created_by,undefined);
});
test('malformed legacy JSON safely returns null',async()=>{
 row={...row,layout_json:'invalid'};assert.equal(await getPublishedMarketLayout(9,5),null);
});
