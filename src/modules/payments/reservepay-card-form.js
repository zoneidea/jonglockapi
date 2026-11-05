const { randomBytes } = require('node:crypto');

function cardForm(config) {
  const nonce = randomBytes(18).toString('base64');
  const settings = JSON.stringify({ merchantId: config.merchantId, installationId: config.installationId }).replace(/</g, '\\u003c');
  return {
    csp: `default-src 'none'; script-src 'nonce-${nonce}' https://sdk.reservepay.com; style-src 'unsafe-inline'; frame-src https://*.reservepay.com; connect-src https://*.reservepay.com; img-src data: https://*.reservepay.com; base-uri 'none'; form-action 'none'`,
    html: `<!doctype html><html lang="th"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>ชำระด้วยบัตร</title>
<style>
*{box-sizing:border-box}body{margin:0;background:#f7fbfb;color:#07111f;font:16px 'Thonburi','Tahoma',-apple-system,sans-serif;-webkit-font-smoothing:antialiased}
main{max-width:520px;margin:0 auto;padding:24px 20px 32px}.heading{display:flex;align-items:center;gap:14px;margin-bottom:24px}.card-icon{display:grid;place-items:center;width:52px;height:52px;flex-shrink:0;border-radius:16px;background:#edf7f5;color:#087b70}.card-icon svg{width:27px;height:27px}h1{font-size:24px;line-height:1.4;margin:0 0 4px;font-weight:800;letter-spacing:-.4px}.subtitle{margin:0;color:#607086;font-size:14px;line-height:1.6}
.panel{padding:22px;background:#fff;border:1px solid #dbe7ef;border-radius:24px;box-shadow:0 8px 28px rgba(11,32,52,.04)}.panel-heading{display:flex;align-items:center;justify-content:space-between;gap:12px;margin-bottom:22px}.panel-heading h2{margin:0;font-size:16px;font-weight:800}.brands{display:flex;gap:6px;flex-shrink:0}.brands span{border:1px solid #dbe7ef;border-radius:6px;padding:4px 6px;font-size:10px;line-height:1.2;font-weight:800;color:#607086;background:#fff}
.group{margin-bottom:20px}.group:last-child{margin-bottom:0}label{display:block;font-size:14px;font-weight:700;margin:0 0 9px;color:#071827}.field,input{width:100%;border:1.5px solid #dbe7ef;border-radius:14px;background:#fff;padding:16px;transition:border-color .15s,box-shadow .15s}.field{min-height:54px}.field.focused,input:focus{outline:0;border-color:#14a997;box-shadow:0 0 0 3px rgba(20,169,151,.10)}input{font:inherit;font-size:16px;color:#07111f}input::placeholder{color:#8996a5}.pair{display:grid;grid-template-columns:1fr 1fr;gap:14px}.hint{font-size:12px;line-height:1.6;color:#607086;margin:8px 0 0}
button{width:100%;min-height:56px;padding:16px 18px;margin-top:24px;border:0;border-radius:16px;background:#14a997;color:#fff;font:inherit;font-size:16px;font-weight:800;cursor:pointer;transition:background .15s,opacity .15s}button:active{background:#087b70}button:focus-visible{outline:3px solid #087b70;outline-offset:3px}button:disabled{opacity:.5;cursor:default}.secure{display:flex;justify-content:center;align-items:flex-start;gap:7px;margin:18px 8px 0;color:#607086;font-size:12px;line-height:1.7;text-align:center}.secure svg{flex-shrink:0;width:15px;height:15px;margin-top:3px;color:#087b70}
@media(max-width:350px){main{padding:18px 14px 26px}.panel{padding:18px}.pair{gap:10px}.brands span{font-size:9px}h1{font-size:22px}}
</style>
<main>
<header class="heading"><div class="card-icon" aria-hidden="true"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="2.5" y="4.5" width="19" height="15" rx="3"/><path d="M3 9h18M6.5 15h4" stroke-linecap="round"/></svg></div><div><h1>ข้อมูลบัตร</h1><p class="subtitle">บัตรเครดิต / บัตรเดบิต</p></div></header>
<section class="panel" aria-labelledby="card-details-title">
<div class="panel-heading"><h2 id="card-details-title">รายละเอียดบัตร</h2><div class="brands" aria-label="บัตรเครดิตและเดบิต"><span>VISA</span><span>Mastercard</span></div></div>
<div class="group"><label id="number-label">หมายเลขบัตร</label><div class="field" id="number" role="group" aria-labelledby="number-label"></div></div>
<div class="pair"><div class="group"><label id="expiry-label">วันหมดอายุ</label><div class="field" id="expiry" role="group" aria-labelledby="expiry-label"></div></div><div class="group"><label id="cvv-label">รหัส CVV</label><div class="field" id="cvv" role="group" aria-labelledby="cvv-label"></div></div></div>
<div class="group"><label for="name">ชื่อบนบัตร</label><input id="name" autocomplete="cc-name" autocapitalize="words" placeholder="ชื่อและนามสกุลตามหน้าบัตร"><p class="hint">กรอกชื่อให้ตรงกับที่ระบุบนบัตร</p></div>
</section>
<button id="submit" disabled>ยืนยันข้อมูลบัตร</button>
<p class="secure"><svg aria-hidden="true" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="5" y="10" width="14" height="11" rx="2"/><path d="M8 10V7a4 4 0 0 1 8 0v3"/></svg><span>ข้อมูลบัตรส่งตรงและเข้ารหัสโดย ReservePay<br>Jonglock ไม่จัดเก็บหมายเลขบัตรและ CVV</span></p>
</main>
<script nonce="${nonce}" src="https://sdk.reservepay.com/js/v1/reservepay.js"></script><script nonce="${nonce}">
(async function(){const button=document.getElementById('submit');function notify(message){if(window.ReactNativeWebView){window.ReactNativeWebView.postMessage(JSON.stringify({type:'reservepay.cardError',message}));}else{window.alert(message);}}try{
const rp=window.Reservepay.initReservepay(${settings});const fields=await rp.customCardFields.create({fields:{cardNumber:{container:'#number',placeholder:'0000 0000 0000 0000'},expirationDate:{container:'#expiry',placeholder:'MM / YY'},cvv:{container:'#cvv',placeholder:'CVV'}},styles:{input:{'font-size':'16px','font-family':'-apple-system, BlinkMacSystemFont, Thonburi, sans-serif','font-weight':'500',color:'#07111f'},':focus':{color:'#071827'},'.valid':{color:'#07111f'},'.invalid':{color:'#07111f'}}});button.disabled=false;
const containers={cardNumber:'number',expirationDate:'expiry',cvv:'cvv'};fields.on('focus',event=>document.getElementById(containers[event.field])?.classList.add('focused'));fields.on('blur',event=>document.getElementById(containers[event.field])?.classList.remove('focused'));
button.onclick=async()=>{button.disabled=true;button.textContent='กำลังตรวจสอบบัตร…';try{const name=document.getElementById('name').value.trim();if(!name)throw Error();const result=await fields.tokenize({name,usage:'SINGLE'});if(!result.token)throw Error();window.ReactNativeWebView.postMessage(JSON.stringify({type:'reservepay.cardToken',token:result.token}));fields.destroy();}catch(_){notify('กรุณาตรวจสอบข้อมูลบัตรและลองอีกครั้ง');button.disabled=false;button.textContent='ยืนยันข้อมูลบัตร';}};
window.addEventListener('pagehide',()=>fields.destroy());}catch(_){notify('โหลดฟอร์มบัตรไม่สำเร็จ กรุณาลองใหม่');}})();</script></html>`,
  };
}

module.exports = { cardForm };
