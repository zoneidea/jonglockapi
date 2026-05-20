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

## Notes

- Database schema อยู่ที่ `migrations/001_init.sql`
- รายละเอียด requirement, legacy mapping, RBAC และ security rules อยู่ที่ `AGENT.md`
- Deployment checklist สำหรับ MVP อยู่ที่ `docs/MVP_DEPLOYMENT_CHECKLIST.md`

## Quality Gates

```bash
npm run lint
npm test
```

## Initial Supervisor

```bash
SEED_ORG_CODE=ORG001 \
SEED_ORG_NAME="Market Owner" \
SEED_ADMIN_USERNAME=admin \
SEED_ADMIN_PASSWORD='change-this-password' \
SEED_ADMIN_NAME="System Supervisor" \
npm run seed:supervisor
```
