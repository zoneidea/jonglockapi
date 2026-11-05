const express = require('express');
const { z } = require('zod');
const { asyncHandler } = require('../../utils/async-handler');
const { AppError } = require('../../utils/errors');
const { ok } = require('../../utils/api-response');
const settings = require('../../services/organization-payment-settings.service');
const router = express.Router({ mergeParams: true });
const manual = z.object({
  bankCode: z.string().regex(/^\d{3}$/).or(z.literal('')).optional().default(''),
  bankName: z.string().trim().max(120).default(''), accountName: z.string().trim().max(255).default(''),
  accountNumber: z.string().trim().max(40).default(''), promptpayId: z.string().trim().max(40).default(''),
  qrCodeImageUrl: z.string().max(1000).default(''), instructions: z.string().max(1000).default(''),
}).strict();
const recipient = z.object({
  bankCode: z.string().regex(/^\d{3}$/), accountNumber: z.string().regex(/^[\d -]{6,40}$/).transform(value => value.replace(/[ -]/g, '')).refine(value => /^\d{6,34}$/.test(value)),
  accountName: z.string().trim().min(1).max(255), email: z.union([z.literal(''), z.string().email().max(255)]).default(''),
  phone: z.string().regex(/^[+\d -]{0,30}$/).default(''),
}).strict().refine(value => value.email || value.phone.replace(/\D/g, '').length >= 9, 'กรุณากรอกอีเมลหรือเบอร์โทรติดต่อ');
router.get('/', asyncHandler(async (req, res) => ok(res, await settings.getSettings(req.auth.organizationId))));
router.put('/', asyncHandler(async (req, res) => {
  let raw = req.body;
  // The existing management image uploader supports multipart QR images.
  if (typeof raw?.settings === 'string') {
    try { raw = JSON.parse(raw.settings); } catch (_error) { throw new AppError(400, 'ข้อมูลการตั้งค่าไม่ถูกต้อง', 'VALIDATION_ERROR'); }
  }
  const parsed = z.discriminatedUnion('mode', [z.object({ mode: z.literal('manual'), details: manual }).strict(),
    z.object({ mode: z.literal('gateway'), details: recipient }).strict()]).safeParse(raw);
  if (!parsed.success) throw new AppError(400, 'กรุณาตรวจสอบข้อมูลบัญชีรับเงินและข้อมูลติดต่อให้ครบถ้วน', 'VALIDATION_ERROR');
  if (req.file) {
    if (parsed.data.mode !== 'manual') throw new AppError(400, 'อัปโหลด QR Code ได้เฉพาะช่องทางโอนเงิน', 'VALIDATION_ERROR');
    const env = require('../../config/env');
    const base = env.PUBLIC_BASE_URL || `${req.protocol}://${req.get('host')}`;
    // Only a server-issued local upload URL is persisted.
    parsed.data.details.qrCodeImageUrl = `${base.replace(/\/$/, '')}/uploads/payments/${req.auth.organizationId}/${req.file.filename}`;
  }
  if (parsed.data.mode === 'manual') {
    if (!parsed.data.details.qrCodeImageUrl && !parsed.data.details.promptpayId && !parsed.data.details.accountNumber) throw new AppError(400, 'กรุณาอัปโหลด QR Code หรือกรอกบัญชี/หมายเลขพร้อมเพย์สำหรับโอนเงิน', 'MANUAL_PAYMENT_REQUIRED');
    const previous = await settings.getSettings(req.auth.organizationId);
    if (!req.file && parsed.data.details.qrCodeImageUrl !== (previous.mode === 'manual' ? previous.details.qrCodeImageUrl || '' : '')) {
      throw new AppError(400, 'กรุณาอัปโหลดรูป QR Code ผ่านฟอร์ม', 'INVALID_QR_IMAGE');
    }
  }
  const bankCode = parsed.data.details.bankCode;
  if (bankCode) {
    let bank;
    try { bank = await require('../../services/bank-master.service').findActiveBank(bankCode); }
    catch (error) {
      // Preserve an immutable, already registered recipient if its bank is retired.
      const previous = await settings.getSettings(req.auth.organizationId);
      if (error.code !== 'INVALID_BANK_CODE' || parsed.data.mode !== 'gateway' || !previous.contactId
        || previous.recipientDetails?.bankCode !== bankCode) throw error;
    }
    if (bank && parsed.data.mode === 'manual') parsed.data.details.bankName = bank.nameTh;
  } else if (parsed.data.mode === 'manual' && (parsed.data.details.bankName || parsed.data.details.accountNumber)) {
    const previous = await settings.getSettings(req.auth.organizationId);
    if (previous.mode !== 'manual' || previous.details.bankName !== parsed.data.details.bankName
      || previous.details.accountNumber !== parsed.data.details.accountNumber) {
      throw new AppError(400, 'กรุณาเลือกธนาคารจากรายการก่อนบันทึกบัญชีใหม่', 'BANK_SELECTION_REQUIRED');
    }
  }
  return ok(res, await settings.saveSettings(req.auth.organizationId, parsed.data));
}));
router.post('/disable', asyncHandler(async (req, res) => {
  if (req.body?.confirmed !== true) throw new AppError(400, 'กรุณายืนยันยกเลิก Payment Gateway', 'CONFIRMATION_REQUIRED');
  return ok(res, await settings.disableGateway(req.auth.organizationId));
}));
router.post('/adopt', asyncHandler(async (req, res) => {
  const parsed = z.object({ sourceMarketId: z.number().int().positive(), confirmed: z.literal(true) }).strict().safeParse(req.body);
  if (!parsed.success) throw new AppError(400, 'กรุณายืนยันการตั้งค่าที่จะใช้ร่วมกันทั้งองค์กร', 'CONFIRMATION_REQUIRED');
  return ok(res, await settings.adoptMarketSettings(req.auth.organizationId, parsed.data.sourceMarketId));
}));
module.exports = router;
