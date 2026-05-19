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
