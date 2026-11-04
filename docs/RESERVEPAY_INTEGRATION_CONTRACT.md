# ReservePay integration proposal and API contract

สถานะ: อนุมัติโครงสร้างแล้ว มี backend implementation และ migration 051–053; เปิด checkout หลังทดสอบ staging, provider sandbox และแอปรองรับ JWT contract แล้วเท่านั้น

ขอบเขตแรกคือชำระค่าจองหลาย booking ในองค์กรเดียว ผ่าน ReservePay โดยใช้ customer JWT ของ backend การจ่ายข้ามองค์กร บัตร ค่าปรับ refund และ payout แยกองค์กรยังไม่อยู่ในขอบเขตเปิดใช้ครั้งแรก เก็บ `RESERVEPAY_CHECKOUT_ENABLED=false` จนผ่าน acceptance tests และยืนยันข้อตกลงรับเงินแทนองค์กร

## Current integration and compatibility

- `src/modules/payments/reservepay.routes.js` ยังใช้ public endpoints และอีเมลจาก body ไม่มี durable payment mapping หรือ webhook settlement
- `payments` เดิมมีหนึ่ง `booking_id` ต่อแถว รายงานบัญชีและการตรวจสลิปใช้ตารางนี้ จึงต้องเก็บยอดแยก booking ต่อไป
- JWT จาก `src/modules/auth/auth.service.js` มี `sub`, `organizationId` และ `userType=customer` อยู่แล้ว แต่ public profile flow ไม่ใช่หลักฐานยืนยันตัวตนสำหรับ payment
- contract ใหม่นี้ต้องให้แอปใช้ customer JWT ที่ออกโดย backend ก่อน หาก login ปัจจุบันใช้ public profile ต้องออกแบบการเชื่อม identity แยกต่างหาก ห้ามออก JWT จากอีเมลที่ client ส่งมาเพียงอย่างเดียว

## Proposed payment mapping

เพิ่ม `payment_attempts` เป็นหัวรายการของการเรียก gateway หนึ่งครั้ง แล้วเพิ่ม `payments.payment_attempt_id` เพื่อเชื่อมยอดย่อยของแต่ละ booking ตาราง `payments` ยังเป็นแหล่งยอดสำหรับรายงานบัญชี ตารางหัวรายการใช้ติดตาม provider เท่านั้น ห้ามรวมยอดจากทั้งสองตารางเข้ารายงานเดียวกัน

ตัวอย่าง booking 101 = 100.00 บาท และ 102 = 250.00 บาท: สร้าง attempt ยอด 35000 สตางค์, ReservePay paymentId เดียว และ payments สองแถว amount 100.00/250.00 บาท ทั้งสองแถวมี attempt เดียวกันและ provider_reference เดียวกัน จึงห้ามตั้ง UNIQUE บน `payments.provider_reference`

### New payment attempts table

| Fields | Proposed storage and invariant |
| --- | --- |
| `id`, `public_id` | BIGINT PK; VARCHAR(40) UNIQUE สำหรับอ้างอิงจาก client |
| `organization_id`, `mobile_user_id` | NOT NULL FK; ตรวจว่าผู้ใช้และ bookings เป็นองค์กรเดียวกัน |
| `provider`, `merchant_id` | ค่า `reservepay` และ merchant ที่ server กำหนด; ไม่รับจาก client |
| `external_id` | VARCHAR(128), UNIQUE(provider, merchant_id, external_id); ใช้ `JL-` + UUID ที่สร้างและบันทึกก่อนเรียก gateway ไม่มีการต่อ booking IDs แล้วตัดข้อความ |
| `provider_reference` | VARCHAR(255) NULL, UNIQUE(provider, merchant_id, provider_reference); คือ ReservePay paymentId |
| `payment_session_id` | VARCHAR(128), UNIQUE(provider, merchant_id, payment_session_id); session เดิมห้ามสร้าง attempt ใหม่ |
| `idempotency_key`, `request_hash` | VARCHAR(128) และ CHAR(64); UNIQUE(organization_id, mobile_user_id, idempotency_key) |
| `amount_minor`, `currency` | BIGINT UNSIGNED และ CHAR(3); snapshot ผลรวม payments เป็นสตางค์และ THB |
| `state`, `provider_status` | local state: creating/pending/unknown/paid/failed/expired/cancelled/review; เก็บ provider status แยก ไม่แก้ enum เดิมให้ใช้ชื่อ provider ทั้งหมด |
| `provider_expires_at`, `paid_at`, `last_checked_at` | DATETIME NULL; provider Unix timestamp ต้องแปลงหน่วยและ timezone ชัดเจน |
| `next_check_at`, `lease_until`, `retry_count`, `last_error_code` | สำหรับ reconcile และ claim งานข้ามหลาย process; ห้ามเก็บ raw error ที่มี PII |
| `created_at`, `updated_at` | timestamps; index(organization_id, state, next_check_at) |

เพิ่ม UNIQUE(organization_id, id) ในหัวรายการสำหรับ composite FK จาก payments เพื่อบังคับ tenant ของความสัมพันธ์

### Existing payments and callbacks

- `payments`: เพิ่ม `reservepay` ใน provider enum, เพิ่ม nullable `payment_attempt_id`, composite FK `(organization_id, payment_attempt_id)` และ UNIQUE(payment_attempt_id, booking_id) แถว manual/ksher/mock เดิมคงค่า NULL
- payment ย่อยใช้ `created` ระหว่างเริ่ม, `waiting` ระหว่างรอ, `paid` เมื่อสำเร็จ; provider FAILED/EXPIRED ใช้ `failed` และ CANCELLED ใช้ `cancelled` โดยเก็บเหตุผลจริงใน attempt ไม่เพิ่ม status enum โดยไม่จำเป็น
- `payment_callbacks`: เพิ่ม nullable `merchant_id`, `event_id`, `payment_attempt_id`, `event_type`, `provider_reference`, `processing_status`, `processed_at`, `retry_count`, `next_retry_at`, `lease_until`, `last_error_code`; UNIQUE(provider, merchant_id, event_id) ป้องกัน event ซ้ำ โดย callback เก่าที่ event_id เป็น NULL อยู่ต่อได้
- callback ที่หา attempt ไม่เจอให้คง `organization_id=NULL` และสถานะ pending; เมื่อจับคู่ได้แล้วให้ผูกองค์กรจาก attempt เท่านั้น ห้ามเชื่อองค์กรจาก payload
- เพิ่ม index สำหรับ claim callbacks ที่ pending/retry และ lease หมดอายุ พร้อม composite FK ของ callback ที่ resolve แล้ว
- `payload_json` เก็บเฉพาะ allowlist ของ event/payment IDs, event, status และ delivered_at; ไม่เก็บ PII หรือ raw provider response ทั้งก้อน

## Mobile API contract

Canonical prefix: `/api/mobile/payments/reservepay` ทุก endpoint ต้องมี `Authorization: Bearer <backend-customer-jwt>` ตรวจ signature, expiry, active customer และ `userType === 'customer'` โดยเฉพาะ ห้ามใช้ `requireMobileAccount` เพียงอย่างเดียวเพราะปัจจุบันอนุญาต audit ด้วย

ใช้ `req.auth.organizationId` และ `req.auth.sub` ตรวจทุก booking/attempt query ไม่รับ organizationId, merchantId หรือ user.email จาก body เป็นตัวระบุสิทธิ์ return URL กำหนดโดย server เป็น `jonglock://payment-return`

### POST methods

Request: `{"platform":"IOS"}` หรือ `ANDROID`

HTTP 200 ใช้ envelope เดิม `{status:"success",message:"",data:{...}}` โดย data คง fields `merchantId`, `installationId`, `platform`, `installationEnabled`, `emailCapture`, `mobileCapture`, `addressCapture`, `methods`, `checkoutEnabled` ตาม service เดิม เฉพาะข้อมูลสาธารณะ ไม่มี API key

### POST initiate

Header เพิ่ม `Idempotency-Key: <client-generated-uuid>`; client เก็บ key เดิมเมื่อ retry รายการเดิม สร้าง key ใหม่หลังรายการเดิมจบและเลือก session ใหม่แล้ว

```json
{
  "bookingIds": [101, 102],
  "paymentSessionId": "session_from_sdk",
  "amount": "35000"
}
```

bookingIds เป็น positive integers 1–50 รายการ ไม่ซ้ำ เรียง canonical ก่อน hash; amount เป็น positive integer string หน่วยสตางค์ server คำนวณจาก DECIMAL ทีละ booking ด้วย integer arithmetic แล้วตรวจตรงกับ request ห้ามเชื่อ client amount หรือใช้ float รวมเงินบาท

Successful response HTTP 200:

```json
{
  "status": "success",
  "message": "",
  "data": {
    "attemptId": "RPAexample",
    "paymentId": "payment_from_provider",
    "status": "pending",
    "amount": "35000",
    "currency": "THB"
  }
}
```

หากอยู่ระหว่างสร้างหรือผล gateway ไม่แน่นอน ส่ง HTTP 202 พร้อม data รูปแบบเดียวกัน แต่ paymentId เป็น null และ status เป็น creating/unknown แอปตรวจ `/status` ด้วย attemptId ห้ามสร้าง session ใหม่เพื่อ retry ทันที

`request_hash` ผูก sorted bookingIds, paymentSessionId, amount และ currency; key เดิมกับ hash เดิมคืน attempt เดิม key เดิมแต่ payload เปลี่ยนคืน 409 ห้ามสร้าง provider payment ใหม่

### POST status

Request: `{"attemptId":"RPAexample"}` ตรวจเจ้าของและองค์กรก่อนอ่านหรือ reconcile กับ gateway ไม่รับ paymentId ใดก็ได้เพื่อส่งต่อ Merchant API

HTTP 200 data: `attemptId`, `paymentId` (nullable), `status` (local state), `providerStatus` (nullable), `amount`, `currency`, `bookingIds`, `updatedAt` สถานะ paid ต้องมาจาก settlement ที่ commit แล้ว การ polling หรือกลับจาก deep link ไม่ใช่คำสั่งตั้ง paid

| HTTP | Code and client handling |
| --- | --- |
| 400 | VALIDATION_ERROR, PAYMENT_AMOUNT_MISMATCH, BOOKING_NOT_PAYABLE |
| 401/403 | token ไม่ถูกต้อง/หมดอายุ หรือไม่ใช่ customer |
| 403 | PAYMENT_CHECKOUT_DISABLED เมื่อปิด flag สำหรับ initiate; methods ยังคืน checkoutEnabled=false; status ของ attempt เดิมยังอ่าน/reconcile ได้ |
| 404 | BOOKING_NOT_FOUND / PAYMENT_NOT_FOUND; ใช้กับข้อมูลผู้อื่นด้วย |
| 409 | IDEMPOTENCY_CONFLICT / PAYMENT_IN_PROGRESS; คืน existing attemptId เฉพาะเจ้าของ |
| 503 | PAYMENT_NOT_CONFIGURED ก่อนสร้าง attempt |
| 202 | ผล initiate ยังไม่แน่นอน; poll attempt เดิม ไม่ตัดสินว่า failed |

Failure envelope ใช้ `{status:"failed",message:"...",code:"...",data:null}` ตาม error middleware

### Compatibility with public payment routes

ก่อนเปิด flag ต้องปิด public `/initiate` และ `/status` เดิมด้วย 410 หรือ authenticated alias ที่บังคับกฎเดียวกันทั้งหมด ห้ามเหลือช่องทางเชื่ออีเมลจาก body; public methods เดิมคงไว้สำหรับ discovery ได้

แอปต้องย้ายไป contract ใหม่และรองรับ 202, polling ด้วย attemptId และการแบ่ง cart ตามองค์กร การเปลี่ยนแอปเป็นงานแยกจาก backend scope นี้

## Initiation and concurrent writes

1. ตรวจ flag/config/token แล้วเริ่ม transaction; lock bookings ตาม id เพื่อให้ลำดับ lock คงที่ ตรวจองค์กร เจ้าของ active user สถานะ pending_payment และเวลาหมดอายุ รวมถึง active manual/gateway payments ที่ขัดกัน
2. ตรวจหรือสร้าง idempotent attempt และ payments ย่อยพร้อม snapshot amount ทั้งหมดใน transaction เดียว เปลี่ยน bookings/items เป็น payment_processing และ booth_date_locks เป็น processing; เอา local expiry ออกระหว่างผล gateway ยังไม่ชัดเจนเพื่อไม่ให้ cleanup ปล่อยพื้นที่
3. Commit ก่อนเรียก ReservePay ไม่ถือ DB lock ระหว่าง network call ส่ง amount/currency/session, external_id ที่บันทึกไว้, capture=true และ return_url ที่ server กำหนด ตาม [initiate-payment-flow API](https://developer.reservepay.com/api/merchants/initiate-payment-flow); customer PII อ่านจาก record ที่ตรวจสิทธิ์แล้วและถอดรหัสเฉพาะเวลาส่ง
4. ใช้ lease claim attempt ให้ worker เดียวเรียก initiate; หลังตอบกลับ bind provider paymentId และเปลี่ยน state ภายใต้ transaction เดียวกับ payments ย่อย
5. Timeout, non-JSON 2xx, connection reset หรือ process crash หลังส่ง request จัดเป็น unknown ค้น `find-payment` ด้วย external_id เดิมก่อนเสมอ ห้ามสร้าง external_id ใหม่หรือ initiate ซ้ำจาก timeout/NOT_FOUND ครั้งเดียว ต้อง resolve ผลเดิมให้ชัดเจนก่อนเปิด retry
6. definitive rejection ที่ยืนยันว่าไม่มี provider payment จึง mark failed และคืน bookings เป็น pending_payment พร้อมเวลาจ่ายรอบใหม่; transaction ต้องตรวจว่า attempt ยังเป็นรายการ active ของ bookings และยังไม่ paid

เพิ่ม active-attempt guards ใน writers ที่เปลี่ยน booking, cancel, แนบสลิป หรือสร้าง transaction รวมถึง public paths ที่เกี่ยวข้อง เพื่อไม่ให้แก้ยอด/ยกเลิก/จ่าย manual ซ้อนระหว่าง gateway pending/unknown โดยใช้ lock booking ชุดเดียวกัน manual workflow เดิมยังใช้ได้กับ booking ที่ไม่มี active gateway attempt

## Webhook contract

Proposed endpoint: `POST /api/mobile/payments/callbacks/reservepay` เป็น provider endpoint ใช้ signature แทน customer JWT ต้อง register ก่อน generic `/callbacks/:provider` และก่อน `express.json()` ปัจจุบันใน `src/app.js`

อ่าน raw Buffer ด้วย `express.raw({type:'application/json',limit:'64kb'})` และตรวจ HMAC_SHA256 ก่อน JSON.parse ตั้งค่า `RESERVEPAY_WEBHOOK_KEY` เป็น secret ฝั่ง server ใช้ key ที่ Base64 decode แล้วตรวจ header `Reservepay-Signature: hmac_sha256=<hex>` ด้วย constant-time comparison ปฏิเสธ signature หาย/ผิด/รูปแบบไม่ถูกต้องด้วย 401 ตาม [ReservePay webhook guide](https://developer.reservepay.com/guides/real-time-notifications)

Payload จาก provider ไม่ใช่ envelope ของ API ภายใน:

```json
{
  "event_id": "evt_example",
  "event": "payment_completed",
  "payment_id": "payment_from_provider",
  "external_id": "JL-uuid_saved_before_initiate",
  "status": "SUCCESSFUL",
  "delivered_at": 1793725200
}
```

Subscribe `payment_completed` และ `payment_expired` โดย completed ต้องตรวจ SUCCESSFUL/FAILED ส่วน expired ต้องเป็น EXPIRED ตาม [completed reference](https://developer.reservepay.com/webhooks/merchants/payment_completed) และ [expired reference](https://developer.reservepay.com/webhooks/merchants/payment_expired) ไม่คาดหวัง amount/currency ใน event ให้เรียก find-payment ก่อน settlement

หลัง signature ผ่าน ตรวจ schema/event pair แล้ว persist inbox event ก่อนคืน 200 ภายใน 10 วินาที duplicate event_id คืน 200 เมื่อรายการเดิมถูกบันทึกอย่าง durable แล้ว; delivery เดิมอาจมี delivered_at/body/signature ต่างกัน จึงไม่ใช้ body hash เป็น dedup key ถ้า DB บันทึกไม่ได้คืน 503 ให้ provider retry ส่วน JSON เสีย/schema ไม่ถูกต้องคืน 400 และขนาดเกินกำหนดคืน 413

หาก signed event เป็นชนิดที่ยังไม่รองรับ ให้เก็บ metadata ที่ปลอดภัยและ mark ignored พร้อมคืน 200; ห้ามใช้ event นั้นเปลี่ยน booking

## Settlement and recovery

ใช้ service เดียวสำหรับ status reconciliation และ webhook processing เรียก find-payment นอก transaction ก่อน แล้ว apply ผลใน transaction เดียว โดยทุก writer ใช้ลำดับ lock เดียวกัน: bookings ตาม id, attempt, payments ตาม id และ booth locks ตาม id; resolve booking IDs จาก mapping ก่อน แล้วตรวจ mapping/state ซ้ำหลัง lock ห้าม settlement สลับลำดับกับ initiation ตรวจ merchant credential ที่กำหนด, provider_reference/external_id, amount และ currency ให้ตรง snapshot ตาม [find-payment API](https://developer.reservepay.com/api/merchants/find-payment)

| Verified provider state | Local updates |
| --- | --- |
| PENDING / AUTHORIZED | คง attempt pending และ processing locks; AUTHORIZED ยังไม่ paid |
| SUCCESSFUL | เมื่อยอด/ความสัมพันธ์/locks ถูกต้อง: attempt และ payments ทุกแถวเป็น paid, paid_at มาจาก provider เมื่อมี, bookings/items/locks เป็น paid, ซ่อน cart; commit ทั้งกลุ่มพร้อมกัน |
| FAILED | attempt failed, payments failed; คืน booking/items เป็น pending_payment และ held locks พร้อม expiry รอบใหม่ เมื่อยังเป็น active attempt เดิม |
| EXPIRED / CANCELLED | attempt expired/cancelled, payments failed/cancelled; bookings/items expired และ release เฉพาะ locks ที่เป็นของ booking/attempt ชุดนี้ |
| provider lookup ล้มเหลวหรือผลยังไม่ชัด | เก็บ pending/unknown พร้อม retry ห้ามคืนพื้นที่หรือตั้ง paid |
| amount/currency/reference ไม่ตรง หรือ booking/lock ถูกแก้/ขายต่อ | เก็บ review และแจ้งผู้ดูแลพร้อมหลักฐาน ห้ามตั้ง booking paid หรือปล่อยพื้นที่อื่นอัตโนมัติ |

paid เป็นสถานะป้องกันการ downgrade ของ settlement รุ่นแรก: event เก่าหรือ polling ที่ช้ากว่าห้ามย้อนเป็น failed/expired การ refund/reversal/dispute ที่ตรวจพบให้บันทึก review/แจ้งเตือนแยกจาก paid booking และไม่ปล่อยพื้นที่อัตโนมัติ

webhook อาจมาก่อน initiate response: resolve ด้วย external_id ที่บันทึกไว้, bind paymentId แบบ atomic และตรวจซ้ำเมื่อ response ตามมา event ที่ยังหา attempt ไม่พบอยู่ใน inbox เพื่อ retry; ห้ามผูกตาม email หรือ booking IDs ที่เดาจาก external_id

เพิ่ม cron handler สำหรับ claim callbacks และ attempts ที่ค้าง โดยใช้ DB lease และ next_retry_at ในรูปแบบ cron module เดิม ห้ามให้ secret ว่างผ่านเหมือน fallback ของ cron เดิมสำหรับ handler ใหม่นี้ งานต้อง retry ได้หลัง process crash และ scan pending/unknown attempts เพื่อกู้ webhook ที่พลาด มี alert เมื่อ retry ต่อเนื่องหรือสถานะ review ไม่สร้าง queue infrastructure ใหม่ในระยะแรก

หากผลใหม่ชนกับ state ที่เคย terminal หรือ generation ของ booking เปลี่ยนแล้ว ให้ตรวจ provider ซ้ำและส่ง review แทน apply จากลำดับการมาถึงของ event ไม่ใช้ delivered_at ตัดสินว่าเหตุการณ์ไหนใหม่กว่า

## Logging and secrets

เก็บ activity/request/response metadata ที่ปลอดภัยใน event_logs และไฟล์ log ที่ตั้งปลายทางชัดเจน: attemptId, eventId, organizationId, bookingIds, action, status, duration และ error code ไม่มี API key, webhook key, Authorization, session ID, บัตร หรือ customer PII

webhook route ที่วางก่อน global logger ต้องมี safe logging ของตัวเอง อย่าให้ raw body หรือ header signature เข้า logs และอย่าใช้ providerBody จาก AppError เป็น log ทั้งก้อน ข้อมูล PII ที่จำเป็นใน DB ใช้ encryptField/blindIndex ตามระบบเดิม

## Migration and rollout proposal

1. หลังอนุมัติแบบ เพิ่ม migration ถัดจาก 050 เพื่อสร้าง payment_attempts และขยาย payments/payment_callbacks แบบ additive ผ่าน migration runner เดิม ห้ามแก้ 001_init.sql แทน migration ใหม่
2. ใช้ MySQL staging snapshot ทดสอบ schema/FK/index และ migration restart เพราะ [MySQL DDL มี implicit commit](https://dev.mysql.com/doc/refman/8.4/en/implicit-commit.html) transaction wrapper ไม่รับประกัน rollback ทั้ง migration ต้องเขียนขั้นตอนตรวจสภาพหลังล้มเหลวด้วย
3. แยก settlement service, webhook verifier และ reconciliation worker เป็น modules ที่ทดสอบแยกได้ ใช้ transaction/query helpers เดิม ไม่รวมทุก flow ไว้ใน route ไฟล์เดียว
4. Deploy โดย flag ปิด ตั้ง webhook key และ cron secret ให้ครบ ตรวจ provider API version 2025-04-01 กับ sandbox และ payload จริง แล้วให้แอปใช้ customer JWT contract
5. ทดสอบตารางด้านล่างและยืนยัน merchant settlement ระหว่างองค์กร ก่อนเปิด initiate; ปิด flag ต้องหยุดสร้างรายการใหม่ แต่ webhook/status/cron ยัง settle รายการเดิมต่อได้
6. Rollback ด้วย flag ก่อน ไม่ drop ตารางหรือเอา enum reservepay ออกเมื่อมีรายการจริง และไม่ rollback ไป public initiation ที่ไม่มี auth เก็บ callback/attempt ledger เพื่อ reconcile จนจบ

## Acceptance tests before enabling checkout

| Scenario | Required result |
| --- | --- |
| ไม่มี JWT / audit JWT / user ถูกปิด | ไม่สร้าง attempt และไม่เรียก Merchant API |
| booking ของผู้อื่น/ต่างองค์กร หรือ batch ปนองค์กร | 404 ไม่เปิดเผยข้อมูลและไม่เรียก provider |
| ยอดต่างจาก DB, สตางค์เศษ, booking ซ้ำ, booking หมดอายุ | reject ก่อนเริ่ม payment |
| หลาย booking และรายชื่อยาว | ผลรวมสตางค์ถูกต้อง external_id สั้นและไม่ซ้ำ รายงานไม่นับยอดหัวรายการซ้ำ |
| key เดิม payload เดิม / payload เปลี่ยน | ใช้ attempt เดิม / 409 ตามลำดับ |
| initiate พร้อมกันคนละ key/session หรือแนบสลิป/ยกเลิกพร้อมกัน | active attempt เดียว ไม่มีสองช่องทางเรียกเก็บพร้อมกัน |
| timeout หรือ crash ก่อน bind paymentId | recover ด้วย external_id เดิม ไม่เรียกเก็บซ้ำ ไม่ปล่อย locks |
| webhook มาก่อน response, ซ้ำ, สลับลำดับ หรือ processed event retry | bind ถูกต้องและ apply ผลครั้งเดียว ไม่มี downgrade |
| signature ผิด, key ผิด, whitespace ของ body เปลี่ยน | 401 และไม่มี booking/payment mutation |
| webhook completed แต่ FAILED / expired | ไม่ตั้ง paid และคืน/ปล่อย locks ตาม state policy |
| provider amount/currency/reference ไม่ตรง | review และแจ้งเตือน ไม่มี false paid |
| DB ล้มระหว่าง settle | rollback ทุก booking/payment/lock ในกลุ่ม; event ยัง retry ได้ |
| worker crash หลัง claim หรือก่อน mark processed | lease หมดแล้ว retry ได้; commit ที่สำเร็จแล้วไม่ถูกทำซ้ำ |
| webhook หายหรือปิด checkout flag ขณะมีรายการค้าง | cron/status recover และ settle ต่อได้ |
| existing manual/ksher/mock rows และรายงานบัญชี | แถวเดิมยังใช้ได้; manual proof route ไม่อนุมัติ gateway payment |

## Approved implementation scope

อนุมัติเพิ่ม payment_attempts, FK/index และ callback inbox fields ตามแบบนี้ พร้อมเปลี่ยน app-facing ReservePay contract เป็น customer JWT ภายใต้ mobile prefix เพื่อรองรับหนึ่ง gateway payment ต่อหลาย booking โดยรักษารายงานเดิม ป้องกันจ่ายซ้ำ และกู้ผลหลัง timeout/webhook retry ได้ ใช้ lease_token เพิ่มจาก lease_until เพื่อกัน worker เก่าเขียนทับ worker ใหม่

การออกแบบ login bridge สำหรับ public profile และการจ่ายข้ามองค์กรต้องแยกอนุมัติหากจำเป็น ไม่ถือว่า contract นี้อนุมัติให้ขยาย authentication ทั้งระบบหรือแก้ app/frontend/landing

ขั้นตอน deploy, recovery ของ migration และคำสั่งทดสอบอยู่ใน [ReservePay rollout](RESERVEPAY_ROLLOUT.md)
