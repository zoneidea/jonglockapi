const test = require('node:test');
const assert = require('node:assert/strict');
const {createMarketLayout} = require('../src/services/market-layout-create.service');
const scope={organizationId:7,marketId:9,adminUserId:3};
const body={floorPlanId:5,name:' Plan ',description:'',rowsCount:20,columnsCount:30,cellSize:48};
function conn(results) {
 const calls=[];
 return {calls,execute:async(sql,params)=>{
  calls.push({sql,params});assert.equal(params.organizationId,7);assert.equal(params.marketId,9);
  const rows=results.shift();assert.notEqual(rows,undefined,'Unexpected SQL');return [rows];
 }};
}
test('layout creation serializes on tenant market before checking reference and duplicate',async()=>{
 const db=conn([[{id:9}],[{id:5,name:'Booths'}],[],{insertId:22}]);
 const result=await createMarketLayout(db,scope,body,{items:[]});
 assert.deepEqual(result,{insertId:22,floorPlanName:'Booths'});
 assert.match(db.calls[0].sql,/FROM markets[\s\S]*FOR UPDATE/);
 assert.match(db.calls[1].sql,/FROM floor_plans[\s\S]*FOR UPDATE/);
 assert.match(db.calls[2].sql,/floor_plan_id = :floorPlanId AND is_active = 1[\s\S]*FOR UPDATE/);
 assert.equal(db.calls[3].params.name,'Plan');
});
test('existing active reference returns conflict without inserting; soft-deleted rows allow recreation',async()=>{
 const duplicate=conn([[{id:9}],[{id:5,name:'Booths'}],[{id:10}]]);
 await assert.rejects(createMarketLayout(duplicate,scope,body,{}),{statusCode:409});
 assert.equal(duplicate.calls.length,3);
 const deleted=conn([[{id:9}],[{id:5,name:'Booths'}],[],{insertId:23}]);
 assert.equal((await createMarketLayout(deleted,scope,body,{})).insertId,23);
 assert.match(deleted.calls[2].sql,/is_active = 1/);
});
test('missing/deleted market and wrong-market floor plans cannot create layouts',async()=>{
 await assert.rejects(createMarketLayout(conn([[]]),scope,body,{}),{statusCode:404});
 await assert.rejects(createMarketLayout(conn([[{id:9}],[]]),scope,body,{}),{statusCode:400});
});
