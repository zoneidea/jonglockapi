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
