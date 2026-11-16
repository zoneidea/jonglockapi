# Jonglock Backend

Node + Express + MySQL backend สำหรับระบบจองพื้นที่ตลาดแบบ multi-organization.

## Setup

```bash
cp .env.example .env
npm install
npm run migrate
npm run dev
```

Server default: `http://localhost:3000`

## Route Groups

- Mobile: `/api/mobile/*`
- Mobile audit app: `/api/mobile/audit/*`
- Management: `/api/management/*`
- Location master data: `/api/locations/*`, `/api/public/locations/*`, `/api/mobile/locations/*`, `/api/management/locations/*`

## Location Master Data

ข้อมูลจังหวัด อำเภอ/เขต ตำบล/แขวง และรหัสไปรษณีย์ seed จาก `parsilver/thailand-provinces` ผ่าน migration `019_thailand_location_master_data.sql`.

```text
GET /api/locations/geographies
GET /api/locations/provinces?geographyId=2&q=กรุงเทพ
GET /api/locations/amphures?provinceId=1&q=จตุจักร
GET /api/locations/subdistricts?amphureId=30&q=จอมพล
GET /api/locations/address/:districtId
```

## Master data cache

- Uses `node-cache` in the existing response-cache middleware for location master data (24-hour TTL). Existing public market, announcement and app-config caches retain their 60/30/60-second TTLs.
- Only anonymous GET responses with HTTP 200 are cached. Authenticated/cookie requests, errors, private responses and responses setting cookies bypass the cache.
- Query strings are part of cache keys. Each namespace has a bounded entry count. Values are cloned to avoid mutation of cached data.
- `X-Cache: HIT` / `MISS` can be used to verify repeated location requests. No payload or API contract changes are required.
- Management writes retain existing public-cache invalidation. After importing location master data, restart all API workers (or clear `locations` in every worker).
- Cache is per Node process, not shared across workers. TTL bounds staleness; invalidation affects only the current worker. Do not apply this cache to bookings, payments, permissions or account data.

## Notes

- Database schema อยู่ที่ `migrations/001_init.sql`
- รายละเอียด requirement, legacy mapping, RBAC และ security rules อยู่ที่ `AGENT.md`
- Deployment checklist สำหรับ MVP อยู่ที่ `docs/MVP_DEPLOYMENT_CHECKLIST.md`
- ReservePay API contract: `docs/RESERVEPAY_INTEGRATION_CONTRACT.md`; migration/webhook/cron rollout: `docs/RESERVEPAY_ROLLOUT.md`

## Quality Gates

```bash
npm run lint
npm test
```

## Jonglock Audit แยกและ POS

แอปแยกอยู่ที่ [jonglockaudit](https://github.com/zoneidea/jonglockaudit) และใช้ API ออดิทเดิมร่วมกับ `GET /api/mobile/audit/markets`, `GET /api/mobile/audit/markets/:marketId/collection-catalog`, `POST /api/mobile/audit/collections`, `POST /api/mobile/audit/checks/:auditCheckId/collection`, `GET /api/mobile/audit/collections` และ API สถานะ/แนบสลิปของแต่ละ collection

ติดตั้ง migrations `060_audit_collections.sql`, `061_audit_web_merchants.sql` และ `062_audit_collection_requests.sql` ด้วย `npm run migrate` ก่อนเปิด code รุ่นนี้ โดยมี initializer ของ collections, merchants และ request fence รองรับการ initialize ซ้ำบน host ใหม่ ห้ามย้อนกลับด้วยการลบตารางที่มีรายการรับเงินจริง

POS ใช้บริการเสริม active ของตลาด `collection_mode = self` โดยไม่ต้องมีบูธหรือการจอง ราคาจริงและ VAT คำนวณที่ Backend; ข้อมูลผู้ค้า หมายเหตุ QR และสลิปเก็บเข้ารหัส

POS รองรับ `rentAmount` เป็นค่าเช่าแผงก่อน VAT และเรียกเก็บค่าเช่าอย่างเดียวได้โดยไม่ต้องมีบริการเสริม บันทึกลง lines_json เดิมจึงไม่ต้องเพิ่ม migration ให้ deploy Backend ก่อน Web App รุ่นที่ส่ง field นี้

Web App รองรับเงินสด (ต้องยืนยัน expectedAmount) และพร้อมเพย์ พร้อมค้นชื่อผู้ค้าเดิมในตลาดหรือสร้าง ID ใหม่ ชื่อเข้ารหัสและไม่สร้างบัญชี login ปลอม

QR ใช้รูปที่องค์กรตั้งค่าไว้ก่อน PromptPay ID และใช้การตั้งค่ารับเงิน manual ขององค์กร ไม่ข้ามนโยบาย gateway-only การแนบสลิปจะรอให้ supervisor/admin/accounting ตรวจผ่าน `/api/management/markets/:marketId/audit-collections`, `/api/management/audit-collections/:collectionId/proof` และ PATCH `/api/management/audit-collections/:collectionId/proof-status` ก่อนยืนยัน `paid` รายการ POS ที่อนุมัติแล้วรวมในรายงานบัญชีและออกเอกสารผ่าน API เดิมได้ โดยยังไม่เพิ่มหน้าจอ frontend management ใหม่

รายละเอียด payload, response, สิทธิ์, idempotency และขั้นตอนทดสอบอยู่ใน [API Contract ของแอป Audit](https://github.com/zoneidea/jonglockaudit/blob/main/docs/API_CONTRACT.md)

Audit Web จำการเข้าสู่ระบบผ่าน HttpOnly cookie ได้ด้วย rememberMe และ GET /api/mobile/audit/auth/session ตรวจบัญชี/สิทธิ์ปัจจุบันใหม่ก่อนคืน bearer token POST /api/mobile/audit/auth/logout ล้าง cookie อายุเซสชันยึด JWT เดิม ไม่มี migration เพิ่ม ให้ deploy Backend ก่อน Web และใช้ HTTPS พร้อม CORS credentials ที่ไม่ซ้ำ

สถานะ UAT และขั้นตอน deploy รอบ Audit Web: [AUDIT_UAT_ROLLOUT.md](docs/AUDIT_UAT_ROLLOUT.md)

## Initial Supervisor

```bash
SEED_ORG_CODE=ORG001 \
SEED_ORG_NAME="Market Owner" \
SEED_ADMIN_USERNAME=admin \
SEED_ADMIN_PASSWORD='change-this-password' \
SEED_ADMIN_NAME="System Supervisor" \
npm run seed:supervisor
```
