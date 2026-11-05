const { randomBytes } = require('node:crypto');

function cardForm(config) {
  const nonce = randomBytes(18).toString('base64');
  const settings = JSON.stringify({ merchantId: config.merchantId, installationId: config.installationId }).replace(/</g, '\\u003c');
  return {
    csp: `default-src 'none'; script-src 'nonce-${nonce}' https://sdk.reservepay.com; style-src 'unsafe-inline'; frame-src https://*.reservepay.com; connect-src https://*.reservepay.com; img-src data: https://*.reservepay.com; base-uri 'none'; form-action 'none'`,
    html: `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ชำระด้วยบัตร</title>
<style>body{font:16px 'Thonburi','Tahoma',-apple-system,sans-serif;color:#142c3a;margin:20px;background:white}label{display:block;margin:16px 0 8px}.field,input{box-sizing:border-box;width:100%;padding:14px;border:1px solid #bbcbd0;border-radius:12px}button{width:100%;padding:16px;margin-top:24px;background:#087f8c;color:white;border:0;border-radius:12px;font:inherit}button:disabled{opacity:.5}p{line-height:1.6}</style>
<p>ข้อมูลบัตรส่งตรงให้ ReservePay</p><label>เลขบัตร</label><div class="field" id="number"></div><label>วันหมดอายุ</label><div class="field" id="expiry"></div><label>CVV</label><div class="field" id="cvv"></div><label for="name">ชื่อบนบัตร</label><input id="name" autocomplete="cc-name"><button id="submit" disabled>ใช้บัตรนี้</button>
<script nonce="${nonce}" src="https://sdk.reservepay.com/js/v1/reservepay.js"></script><script nonce="${nonce}">
(async function(){const button=document.getElementById('submit');function notify(message){if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify({type:'reservepay.cardError',message}));}else{window.alert(message);}}try{
const rp=window.Reservepay.initReservepay(${settings});const fields=await rp.customCardFields.create({fields:{cardNumber:{container:'#number'},expirationDate:{container:'#expiry'},cvv:{container:'#cvv'}},styles:{input:{'font-size':'16px',color:'#142c3a'}}});button.disabled=false;
button.onclick=async()=>{button.disabled=true;try{const name=document.getElementById('name').value.trim();if(!name)throw Error();const result=await fields.tokenize({name,usage:'SINGLE'});if(!result.token)throw Error();window.ReactNativeWebView.postMessage(JSON.stringify({type:'reservepay.cardToken',token:result.token}));fields.destroy();}catch(_){notify('กรุณาตรวจสอบข้อมูลบัตรและลองอีกครั้ง');button.disabled=false;}};
window.addEventListener('pagehide',()=>fields.destroy());}catch(_){notify('โหลดฟอร์มบัตรไม่สำเร็จ กรุณาลองใหม่');}})();</script></html>`,
  };
}

module.exports = { cardForm };
