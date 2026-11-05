const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
for (const [key, value] of Object.entries({DB_PASSWORD:'test',JWT_SECRET:'test-secret-'.repeat(4),FIELD_ENCRYPTION_KEY:'a'.repeat(64),FIELD_HASH_SECRET:'b'.repeat(32)})) process.env[key] ||= value;
const markets = [
  {id:1,organization_id:7,code:'SYS',name:'System market',collection_mode:'system',status:'active'},
  {id:2,organization_id:7,code:'SELF',name:'Self market',collection_mode:'self',status:'active'},
];
const writes = [];
function stub(path, exports) { const id = require.resolve(path); require.cache[id] = {id,filename:id,loaded:true,exports}; }
stub('../src/config/db', {query:async(sql, params = {}) => {
  if (/INSERT INTO markets/.test(sql)) {
    assert.match(sql, /:collectionMode/); assert.equal(params.organizationId,7);
    writes.push(params); return {insertId:40 + writes.length};
  }
  if (/FROM announcement_items ai/.test(sql)) {
    assert.match(sql, /m.collection_mode = 'system'/);
    assert.match(sql, /ai.market_id IS NULL OR m.id IS NOT NULL/);
    return [{id:1,organization_id:7,market_id:1,type:'news',title:'Visible'}, {id:3,organization_id:7,market_id:null,type:'news',title:'Global'}];
  }
  if (/FROM markets m/.test(sql) && /admin_market_assignments/.test(sql)) return markets;
  if (/FROM markets m|JOIN markets m/.test(sql)) {
    assert.match(sql, /m.collection_mode = 'system'/);
    assert.match(sql, /m.deleted_at IS NULL/);
    if (/FROM markets m/.test(sql)) return markets.filter(m => m.collection_mode === 'system' && (!params.marketId || m.id === params.marketId));
    return [];
  }
  throw new Error('Unexpected SQL in collection test');
}, transaction: async handler => handler({execute: async sql => {
  assert.match(sql, /m.collection_mode = 'system'/);
  assert.match(sql, /FOR UPDATE/);
  return [[]];
}})});
stub('../src/middlewares/auth', {authenticate:(req,_res,next) => {req.auth={organizationId:7,sub:3,userType:'admin',role:req.get('x-test-role') || 'supervisor'};next();},signToken:()=>''});
stub('../src/services/subscription.service', {assertPlanQuota:async()=>{},requireSubscriptionForMutations:()=> (_req,_res,next)=>next()});
const app = express(); app.use(express.json());
app.use('/management',require('../src/modules/management/management.routes'));
app.use('/public',require('../src/modules/public/public.routes'));
app.use((error,_req,res,_next) => res.status(error.name === 'ZodError' ? 400 : error.statusCode || 500).json({message:error.message}));

test('collection mode persists with defaults, supervisor access and customer discovery filtering', async () => {
  const server=app.listen(0,'127.0.0.1'); await new Promise(resolve=>server.once('listening',resolve));
  const base=`http://127.0.0.1:${server.address().port}`;
  try {
    for (const mode of ['self','system',undefined]) {
      const form=new FormData(); form.append('code','NEW');form.append('name','New market');
      if(mode)form.append('collectionMode',mode);
      const response=await fetch(`${base}/management/markets`,{method:'POST',body:form});
      assert.equal(response.status,201);assert.equal((await response.json()).data.collectionMode,mode || 'system');
      assert.equal(writes.at(-1).collectionMode,mode || 'system');
    }
    const before=writes.length;
    const invalid=await fetch(`${base}/management/markets`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({code:'BAD',name:'Bad',collectionMode:'gateway'})});
    assert.equal(invalid.status,400);assert.equal(writes.length,before);
    const forbidden=await fetch(`${base}/management/markets`,{method:'POST',headers:{'Content-Type':'application/json','x-test-role':'admin'},body:JSON.stringify({name:'Bad',collectionMode:'self'})});
    assert.equal(forbidden.status,403);assert.equal(writes.length,before);
    const admin=await (await fetch(`${base}/management/markets`)).json(); assert.equal(admin.data.length,2);
    const list=await (await fetch(`${base}/public/markets`)).json(); assert.deepEqual(list.data.map(m=>m.id),[1]);
    const hidden=await (await fetch(`${base}/public/markets/2`)).json(); assert.equal(hidden.data,null);
    const plans=await (await fetch(`${base}/public/markets/2/floor-plans`)).json(); assert.deepEqual(plans.data,[]);
    const hold=await fetch(`${base}/public/booths/20/hold`,{method:'POST',headers:{'Content-Type':'application/json'},body:JSON.stringify({dates:['2026-12-01'],user:{email:'test@example.test'}})});
    assert.equal(hold.status,404);
    const news=await (await fetch(`${base}/public/announcements?type=news`)).json(); assert.deepEqual(news.data.map(n=>n.id),[1,3]);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
