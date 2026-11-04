# ReservePay backend rollout

Backend รองรับ payment หลาย booking ภายในองค์กรเดียวด้วย customer JWT และ webhook inbox แล้ว คง `RESERVEPAY_CHECKOUT_ENABLED=false` ระหว่างเตรียม staging และให้แอปใช้ [API contract](RESERVEPAY_INTEGRATION_CONTRACT.md) ก่อนเปิดชำระจริง

## Validation

```bash
npm ci --ignore-scripts --no-audit --no-fund
npm run lint
npm test
```

Unit/route tests ใช้ boundary stubs ไม่เชื่อมฐานข้อมูลหรือ ReservePay จริง มี MySQL integration test แบบ opt-in ซึ่งสร้างและลบเฉพาะ database ชั่วคราวชื่อ `reservepay_test_<uuid>` บน localhost ที่ระบุเอง ห้ามตั้ง URL เป็นฐานข้อมูลจริง ผู้ใช้ MySQL สำหรับทดสอบต้องมีสิทธิ์ CREATE/DROP DATABASE

```bash
RESERVEPAY_TEST_MYSQL_URL='mysql://test_user:test_password@127.0.0.1:3306' node --test test/reservepay-mysql.test.js
```

Integration test ตรวจ migration 051–053, composite tenant FK, concurrent checkout/idempotency, duplicate event และ group settlement ด้วย InnoDB จริง ใช้ schema ก่อน migration เฉพาะตารางที่เกี่ยวข้อง จึงต้องทดสอบ migration ทั้งชุดบน staging snapshot เพิ่มด้วย

## Expand schema before enabling checkout

1. สำรองฐานข้อมูลและใช้ staging snapshot ก่อน ตรวจ `schema_migrations` และ `SHOW CREATE TABLE` ของ payments/payment_callbacks
2. ปิด flag แล้วรัน `npm run migrate` ด้วย environment ของ staging ตามกลไก deploy เดิม ต้องใช้ connection ที่ตั้งค่าชัดเจน ไม่รันกับ production โดยไม่ตั้งใจ
3. ตรวจว่ามี payment_attempts และ migration 051/052/053 ถูกบันทึก พร้อม FK/index ของ payments และ payment_callbacks ข้อมูล provider เดิมต้องยังอยู่ครบ
4. Deploy backend และตั้ง `RESERVEPAY_API_KEY`, merchant/installation IDs, `RESERVEPAY_WEBHOOK_KEY` ที่ได้จาก endpoint แบบ HMAC_SHA256 และ `CRON_SECRET` ใน secret environment ของ host ค่าตัวอย่างใน repository เป็นค่าว่างเท่านั้น
5. ให้ deployment เก็บไฟล์ `backend/logs/payments.log` ด้วย access control และ log rotation ที่เหมาะสม รวม event_logs ใน DB ไว้ตรวจสอบ ห้ามส่ง raw provider payload, session IDs หรือ secret ไป log

051 ใช้ CREATE TABLE IF NOT EXISTS ส่วน 052 และ 053 ใช้ ALTER TABLE หนึ่ง statement ต่อไฟล์เพื่อลดจุดค้างระหว่าง DDL แต่ MySQL DDL มี implicit commit หาก process หยุดหลัง DDL สำเร็จก่อนบันทึก schema_migrations ห้าม retry แบบสุ่มหรือ drop ตาราง:

- ตรวจ SHOW CREATE TABLE ว่า columns, enum, indexes และ constraints ตรงกับ migration นั้นครบทุกจุด และไม่มีการข้าม migration ก่อนหน้า
- ถ้า DDL สำเร็จครบแต่ marker หาย จึงให้ผู้ดูแลบันทึก filename นั้นใน schema_migrations แล้วรัน runner ต่อ โดยเก็บหลักฐานการตรวจ
- ถ้า schema ไม่ครบหรือชนกับโครงสร้างที่มีอยู่ ให้หยุดและจัด forward repair migration ตามสภาพจริง อย่าอาศัย ROLLBACK เพื่อย้อน DDL และอย่าลบ ledger

## Webhook and recovery job

ลงทะเบียน HTTPS endpoint ของ host โดยใช้ path `POST /api/mobile/payments/callbacks/reservepay` และ subscribe payment_completed/payment_expired ตั้ง signature type เป็น HMAC_SHA256 และ API version ให้ตรงกับ integration ที่ตรวจสอบแล้ว

ให้ระบบ scheduler ของ host เรียก `POST /api/cron/reservepay-reconcile` ทุกนาที พร้อม header `X-Cron-Secret` ค่าเดียวกับ CRON_SECRET ฝั่ง backend endpoint ใหม่นี้ปฏิเสธเมื่อไม่ได้ตั้ง secret และไม่รับ secret จาก query string จำกัดงานต่อ request เป็น 20 attempts และ 20 callbacks; เฝ้าระวังเวลา request/backlog และเพิ่มความถี่/ทรัพยากรเมื่อจำเป็น

Webhook ตรวจ signature แล้วเก็บ inbox ก่อนตอบ 200 ไม่รอ Merchant API สถานะ paid มาจาก find-payment และ settlement transaction ของทั้งกลุ่มเท่านั้น callback ที่เข้าก่อน initiate response จะรอ lease หมดแล้ว retry ด้วย external_id เดิม การปิด flag ไม่หยุด status/webhook/recovery ของรายการที่มีอยู่

รายการที่ lookup ไม่สำเร็จต่อเนื่อง 10 ครั้งหรือข้อมูลขัดกันจะอยู่ใน review พร้อม payment activity log ให้ระบบ monitor แจ้งผู้ดูแลจาก action `reservepay_review_required` หรือ `reservepay_callback_review` แล้วตรวจ provider payment/external ID ผ่านบัญชี merchant ที่ถูกต้อง ห้ามปล่อย booth หรือ initiate ใหม่เพราะ lookup timeout/NOT_FOUND เพียงอย่างเดียว

## Enable and rollback

ก่อนเปิด flag ต้องทดสอบ sandbox สำเร็จ/ล้มเหลว/หมดอายุ, webhook ซ้ำ/ผิด signature/ขาดหาย, timeout และ concurrent requests พร้อมชุด acceptance ใน contract ยืนยันให้แอปส่ง customer JWT, Idempotency-Key และรองรับ response 202/attemptId cart ต้องแบ่งตามองค์กร และตกลงเรื่อง merchant รับเงินแทนองค์กรแล้ว

Rollback ขั้นแรกคือปิด checkout flag แต่คง webhook/recovery และ credentials ให้ settle รายการค้างต่อ อย่า drop ตารางหรือเอา reservepay ออกจาก enum เมื่อมี ledger แล้ว ห้าม rollback ไป public initiation ที่เชื่ออีเมลจาก body หากต้องถอย code ให้ใช้เวอร์ชันที่ยังปฏิเสธ public payment writes และรักษา gateway guards

public /initiate และ /status เดิมคืน 410; public methods ยังคงใช้ discovery ได้ manual proof และบัญชีเดิมใช้ payments ต่อ แต่ไม่สามารถแนบ/อนุมัติสลิปซ้อนรายการ gateway ที่ active หรือแปลง gateway ledger เป็น manual ได้ การลบ booking ที่เคยมี gateway payment ถูกปฏิเสธเพื่อรักษาประวัติ
