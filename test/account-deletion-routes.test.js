const test = require('node:test');
const assert = require('node:assert/strict');
const express = require('express');
function stub(file, exports) { const id = require.resolve(file); require.cache[id] = {id,filename:id,loaded:true,exports}; }
let deleted=[];
stub('../src/modules/auth/google-customer.service', {verifiedGoogleIdentity: async token => {
  if (token!=='verified-google') throw Object.assign(new Error('Invalid identity'),{statusCode:401});
  return {email:'owner@gmail.com',sub:'verified-owner'};
}});
stub('../src/services/customer-account-deletion.service', {deleteCustomerAccount: async identity => {deleted.push(identity);return {deleted:true};}});
test('account deletion requires verified Google authentication and explicit confirmation; rejects email spoofing',async()=>{
  const app=express();app.use(express.json());app.use('/account',require('../src/modules/mobile/account.routes'));
  app.use((err,_req,res,_next)=>res.status(err.statusCode || 400).json({code:err.code}));
  const server=app.listen(0,'127.0.0.1');await new Promise(resolve=>server.once('listening',resolve));
  const send=(body,token)=>fetch(`http://127.0.0.1:${server.address().port}/account`,{method:'DELETE',headers:{'Content-Type':'application/json',...(token?{Authorization:`Bearer ${token}`}:{})},body:JSON.stringify(body)});
  try {
    assert.equal((await send({confirmation:true})).status,401);
    assert.equal((await send({confirmation:true},'forged')).status,401);
    assert.equal((await send({confirmation:false},'verified-google')).status,400);
    assert.equal((await send({confirmation:true,email:'other@gmail.com'},'verified-google')).status,400);
    assert.equal(deleted.length,0);
    assert.equal((await send({confirmation:true},'verified-google')).status,200);
    assert.deepEqual(deleted,[{email:'owner@gmail.com',sub:'verified-owner'}]);
  } finally {await new Promise(resolve=>server.close(resolve));}
});
