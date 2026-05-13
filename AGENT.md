# Jonglock Backend Agent Guide

## Context

ระบบนี้สร้างใหม่จาก legacy project `/Users/zone-idea/Desktop/scmarket` ซึ่งเดิมใช้ CodeIgniter 3 และ Pure PHP:

- `api/application/controllers`: API สำหรับ mobile app เช่น login, register, booth, booking, cart, payment, notification และ audit app
- `application/controllers`: ระบบจัดการหลังบ้าน เช่น market, booth, product, coupon, booking, report, accounting/fine
- `oClass`: helper เก่าแบบ Pure PHP มี `ckLogin`, `oInsert`, `oUpdate`, `oDelete`, token generator และ SQL string ตรง ๆ

ระบบใหม่ใช้ Node.js + Express + MySQL และอยู่ในโฟลเดอร์นี้ (`backend`).

## Hard Rules

1. Route ต้องแยก mobile และ management ชัดเจน
   - Mobile customer: `/api/mobile/*`
   - Mobile audit app: `/api/mobile/audit/*`
   - Management: `/api/management/*`
   - Payment ที่เรียกจาก app: `/api/mobile/payments/*`

2. ทุกข้อมูลธุรกิจต้องผูก `organization_id`
   - ห้ามรับ `organization_id` จาก body/query หลัง login
   - ให้ใช้ `req.auth.organizationId` จาก JWT เท่านั้น
   - ทุก SQL ที่อ่าน/แก้ข้อมูล business table ต้องมีเงื่อนไข `organization_id = :organizationId`

3. Market access ต้องถูกบังคับก่อนเข้า service
   - `supervisor`: เห็นทุกเมนูและทุกตลาดของ organization ตัวเองเท่านั้น
   - `admin`: เห็นเฉพาะ market ที่อยู่ใน `admin_market_assignments`
   - `accounting`: ใช้เฉพาะเมนูบัญชี
   - `audit`: ใช้เฉพาะ mobile audit app และเฉพาะ market ที่ได้รับมอบหมาย

4. ข้อมูลลูกค้าและแอดมินที่เป็น PII ต้องเข้ารหัสก่อนบันทึก
   - ใช้ `encryptField()` สำหรับชื่อ, เบอร์, อีเมล, เลขบัตร, ที่อยู่
   - ใช้ `blindIndex()` สำหรับค่าที่ต้อง search/login เช่น username, phone, email, id card
   - Password ใช้ `bcrypt` เท่านั้น ห้ามใช้ `md5`

5. ห้ามใช้ SQL string interpolation กับ input
   - ใช้ named placeholders ของ `mysql2` เช่น `:organizationId`, `:marketId`
   - ถ้าต้องทำ transaction ให้ใช้ helper `transaction()`

## Current Route Shape

- `POST /api/mobile/auth/register`
- `POST /api/mobile/auth/login`
- `GET /api/mobile/markets`
- `GET /api/mobile/markets/:marketId/floor-plans`
- `GET /api/mobile/markets/:marketId/booths?date=YYYY-MM-DD`
- `POST /api/mobile/bookings`
- `GET /api/mobile/bookings`
- `POST /api/mobile/payments/transactions`
- `POST /api/mobile/payments/callbacks/:provider`
- `POST /api/mobile/audit/auth/login`
- `GET /api/mobile/audit/markets/:marketId/bookings?date=YYYY-MM-DD`
- `POST /api/mobile/audit/markets/:marketId/checks`
- `POST /api/management/auth/login`
- `GET /api/management/me`
- `GET /api/management/markets`
- `POST /api/management/markets`
- `GET /api/management/markets/:marketId/bookings`
- `GET /api/management/markets/:marketId/products`
- `POST /api/management/markets/:marketId/products`
- `GET /api/management/markets/:marketId/coupons`
- `GET /api/management/accounting/payments`
- `POST /api/management/admins`

## Legacy Mapping

- `btbu` / `btmarketinformation` -> `organizations`, `markets`
- `tbusersystem` -> `admin_users`, `admin_market_assignments`
- `btmember` -> `mobile_users`
- `btmodel` -> `floor_plans`
- `btbooth` -> `booths`
- `tbcategory`, `btgroup`, `btproduct` -> `product_categories`, `product_groups`, `products`
- `btanother` -> `accessories`
- `btcoupon`, `btcoupon_in` -> `coupons`, `coupon_assignments`
- `btbooking`, `btbooking_detail` -> `bookings`, `booking_items`
- `btproduct_booking` -> `booking_products`
- `btbooking_detail_another` -> `booking_accessories`
- `transaction_master`, `transaction_details`, payment callbacks -> `payments`, `payment_callbacks`
- `audit_checker_details`, images/accessories -> `audit_checks`, `audit_check_images`
- `nontification_master` -> `notifications`

## Booking Rules

- จองจาก mobile เป็นหลัก
- Admin สามารถจองแทนได้ผ่าน management แต่สถานะต้องยังรอชำระ และผู้จองต้องชำระผ่าน mobile
- Booth/date เดียวกันห้ามถูกจองซ้ำเมื่อ booking item อยู่ใน `pending_payment`, `payment_processing`, หรือ `paid`
- การสร้าง booking ต้องทำใน transaction และ lock booth/date ก่อน insert

## Development Commands

```bash
npm install
npm run migrate
npm run dev
```

Create first supervisor:

```bash
SEED_ADMIN_USERNAME=admin SEED_ADMIN_PASSWORD='change-this-password' npm run seed:supervisor
```

Health check:

```bash
curl http://localhost:3000/health
```

## Database

Connection config อยู่ใน `.env` และ `.env.example`.

ฐานข้อมูลใหม่ใช้ migration `migrations/001_init.sql`. ตารางทั้งหมดถูกออกแบบให้รองรับหลาย organization และมี `organization_id` ในทุก business table.

## Security Notes

- `.env` ต้องไม่ commit
- JWT secret และ encryption key ต้องเปลี่ยนก่อน production
- Payment callback ตอนนี้รับ payload และ log ลง `payment_callbacks`; การ verify signature ของ provider ต้องเพิ่มก่อนเปิดใช้งานเงินจริง
- Field encryption เป็น AES-256-GCM และ blind index เป็น HMAC-SHA256
