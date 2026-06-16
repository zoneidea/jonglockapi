# Backend Rules

ใช้กับโปรเจกต์ `backend/` เท่านั้น

## 1. Stack และขอบเขต

- Node.js + Express + MySQL
- ใช้ `mysql2`
- ใช้ Firebase Admin เฉพาะงาน server-side เช่น FCM หรือ Firestore lock
- ห้ามย้าย business logic ไปไว้ใน route file มากเกินจำเป็น

## 2. Route และ Scope

- route ต้องแยกชัด:
  - `/api/mobile/*`
  - `/api/mobile/audit/*`
  - `/api/management/*`
  - `/api/platform/*`
- business data ทุกชุดต้องมี `organization_id`
- หลัง login ห้ามเชื่อ scope จาก body/query ถ้ามีข้อมูลจาก auth token อยู่แล้ว

## 3. Security และ Data Handling

- ใช้ bcrypt สำหรับ password เท่านั้น
- PII ต้องใช้ utility encryption/blind index ตามระบบเดิม
- ห้ามทำ SQL string interpolation กับ input
- ใช้ placeholder, transaction helper, และ lock strategy ที่มีอยู่

## 4. Business Critical Areas

- booking, payment, booth lock, audit fine, subscription enforcement, notification sending เป็น flow เสี่ยงสูง
- ถ้าแตะ flow เหล่านี้ ต้องตรวจ:
  - status transition
  - organization scope
  - market scope
  - payment total/VAT
  - event log
  - mobile/management/platform consumer impact

## 5. Token Efficiency สำหรับ Backend

- เริ่มอ่านจาก:
  - `AGENT.md`
  - `README.md`
  - `package.json`
  - `src/app.js`
  - `src/server.js`
  - middleware หรือ service ที่ `rg` หาเจอจาก feature keyword
- ถ้างานเกี่ยวกับ endpoint:
  - เปิด route file + service/util ที่ route เรียกพอ
- ถ้างานเกี่ยวกับ schema:
  - เปิด migration ที่เกี่ยวข้อง + script seed ที่แตะตารางนั้น
- อย่าไล่อ่านทุก module ใน `src/modules` ถ้ายังไม่จำเป็น

## 6. Verification

- รัน:
  - `npm run lint`
  - `npm test`
- ถ้าแก้ schema หรือ seed:
  - ตรวจ `npm run migrate`
  - พิจารณาทดสอบ endpoint ที่เกี่ยวข้องแบบเบา ๆ
- ถ้าแก้ Firebase/notification:
  - ตรวจว่า fallback ไม่ทำให้ API ล่มเมื่อ credential ยังไม่พร้อม
