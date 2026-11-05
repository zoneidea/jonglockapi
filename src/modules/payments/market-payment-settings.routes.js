const express = require('express');
const { AppError } = require('../../utils/errors');
const router = express.Router();
// Old clients must reload instead of accidentally changing every market in an organization.
router.use((_req, _res, next) => next(new AppError(410,
  'ย้ายการตั้งค่ารับเงินไปหน้าตั้งค่าองค์กรแล้ว กรุณาโหลดเว็บใหม่', 'PAYMENT_SETTINGS_MOVED')));
module.exports = router;
