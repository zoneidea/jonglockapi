const test=require('node:test');
const assert=require('node:assert/strict');
const jwt=require('jsonwebtoken');
function stub(file,exports) {const id=require.resolve(file);require.cache[id]={id,filename:id,loaded:true,exports};}
const secret='test-only-account-deletion-secret-32';
let active=true;let lookups=0;
stub('../src/config/env',{JWT_SECRET:secret,JWT_EXPIRES_IN:'15m'});
stub('../src/config/db',{query:async(sql,p)=>{
  lookups+=1;assert.equal(p.organizationId,7);assert.equal(p.userId,9);
  assert.match(sql,/status = 'active'/);return active?[{id:9}]:[];
}});
const {authenticate}=require('../src/middlewares/auth');
function token(userType='customer') {return jwt.sign({sub:9,organizationId:7,userType},secret,{issuer:'jonglock-backend',expiresIn:'15m'});}
async function authorize(value) {let result;await authenticate({headers:{authorization:`Bearer ${value}`}},null,error=>{result=error || 'accepted';});return result;}
test('deleted accounts lose access even when their old JWT has not expired',async()=>{
  active=true;assert.equal(await authorize(token()),'accepted');
  active=false;assert.equal((await authorize(token())).statusCode,401);
});
test('admin JWT behavior is preserved and forged tokens never reach account data',async()=>{
  lookups=0;assert.equal(await authorize(token('admin')),'accepted');assert.equal(lookups,0);
  assert.equal((await authorize('forged')).statusCode,401);assert.equal(lookups,0);
});
