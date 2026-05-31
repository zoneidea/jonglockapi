const express = require('express');
const fs = require('fs');
const path = require('path');
const { Readable } = require('stream');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const ExcelJS = require('exceljs');
const { z } = require('zod');
const { query, transaction } = require('../../config/db');
const { authenticate } = require('../../middlewares/auth');
const { requireManagement, requireRoles, requireMarketAccess } = require('../../middlewares/rbac');
const { validate } = require('../../middlewares/validate');
const { clearResponseCache } = require('../../middlewares/response-cache');
const { ROLES, MENU_ACCESS } = require('../../constants/roles');
const { asyncHandler } = require('../../utils/async-handler');
const { ok, created } = require('../../utils/api-response');
const { badRequest, conflict, notFound } = require('../../utils/errors');
const { encryptField, blindIndex, decryptField } = require('../../utils/crypto');
const { publicId } = require('../../utils/id');
const { assertPasswordPolicy, PASSWORD_POLICY_MESSAGE } = require('../../utils/password-policy');
const { expireStaleBookings } = require('../../utils/booking-status');
const { PAYMENT_EXPIRES_MINUTES } = require('../../constants/booking');
const {
  attachBookingItemToLock,
  insertBoothDateLock,
  moveBookingItemLock,
  releaseBookingLocks,
  updateBookingLocksStatus,
} = require('../../utils/booth-locks');
const { applyVatToAmount, calculateVatBreakdown, getOrganizationVatSettings } = require('../../utils/vat');
const { assertPlanQuota, getCurrentSubscription, requireSubscriptionForMutations } = require('../../services/subscription.service');
const { sendMobilePushNotification } = require('../../services/mobile-notification.service');
const authService = require('../auth/auth.service');

const router = express.Router();
const uploadRoot = path.join(__dirname, '..', '..', '..', 'uploads');
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);

function clearPublicReadCache() {
  clearResponseCache('public:markets');
  clearResponseCache('public:announcements');
}

const ALL_MARKET_OPEN_DAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'];

function normalizeOpenDays(value) {
  if (Array.isArray(value)) {
    const normalized = value.map((item) => String(item || '').trim().toLowerCase()).filter((item) => ALL_MARKET_OPEN_DAYS.includes(item));
    return Array.from(new Set(normalized));
  }
  if (typeof value === 'string') {
    const text = value.trim();
    if (!text) return [];
    try {
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) return normalizeOpenDays(parsed);
    } catch {}
    return normalizeOpenDays(text.split(','));
  }
  return [];
}
const imageUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      const marketId = String(req.params.marketId || 'markets').replace(/[^\d]/g, '') || 'markets';
      const destination = path.join(uploadRoot, 'markets', marketId);
      fs.mkdirSync(destination, { recursive: true });
      callback(null, destination);
    },
    filename(req, file, callback) {
      const extension = path.extname(file.originalname || '').toLowerCase();
      const safeName = path
        .basename(file.originalname || 'market-image', extension)
        .replace(/[^a-zA-Z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'market-image';
      callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}${extension}`);
    },
  }),
  limits: { files: 20, fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!allowedImageTypes.has(file.mimetype)) return callback(badRequest('Only JPG, PNG, WEBP, and GIF images are allowed'));
    return callback(null, true);
  },
});

const pdpaAssetUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      const organizationId = String(req.auth?.organizationId || 'org').replace(/[^\d]/g, '') || 'org';
      const destination = path.join(uploadRoot, 'pdpa', organizationId);
      fs.mkdirSync(destination, { recursive: true });
      callback(null, destination);
    },
    filename(req, file, callback) {
      const extension = path.extname(file.originalname || '').toLowerCase();
      const safeName = path
        .basename(file.originalname || 'pdpa-asset', extension)
        .replace(/[^a-zA-Z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'pdpa-asset';
      callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}${extension}`);
    },
  }),
  limits: { files: 1, fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!allowedImageTypes.has(file.mimetype)) return callback(badRequest('Only JPG, PNG, WEBP, and GIF images are allowed'));
    return callback(null, true);
  },
});

const announcementAssetUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      const organizationId = String(req.auth?.organizationId || 'org').replace(/[^\d]/g, '') || 'org';
      const destination = path.join(uploadRoot, 'announcements', organizationId);
      fs.mkdirSync(destination, { recursive: true });
      callback(null, destination);
    },
    filename(req, file, callback) {
      const extension = path.extname(file.originalname || '').toLowerCase();
      const safeName = path
        .basename(file.originalname || 'announcement-image', extension)
        .replace(/[^a-zA-Z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'announcement-image';
      callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}${extension}`);
    },
  }),
  limits: { files: 20, fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!allowedImageTypes.has(file.mimetype)) return callback(badRequest('Only JPG, PNG, WEBP, and GIF images are allowed'));
    return callback(null, true);
  },
});

const paymentAssetUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      const organizationId = String(req.auth?.organizationId || 'org').replace(/[^\d]/g, '') || 'org';
      const destination = path.join(uploadRoot, 'payments', organizationId);
      fs.mkdirSync(destination, { recursive: true });
      callback(null, destination);
    },
    filename(req, file, callback) {
      const extension = path.extname(file.originalname || '').toLowerCase();
      const safeName = path
        .basename(file.originalname || 'payment-qrcode', extension)
        .replace(/[^a-zA-Z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'payment-qrcode';
      callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}${extension}`);
    },
  }),
  limits: { files: 1, fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!allowedImageTypes.has(file.mimetype)) return callback(badRequest('Only JPG, PNG, WEBP, and GIF images are allowed'));
    return callback(null, true);
  },
});

const bookingImportUpload = multer({
  storage: multer.memoryStorage(),
  limits: { files: 1, fileSize: 2 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    const extension = path.extname(file.originalname || '').toLowerCase();
    const allowed = new Set(['.xlsx', '.csv']);
    if (!allowed.has(extension)) return callback(badRequest('Only XLSX or CSV files are allowed'));
    return callback(null, true);
  },
});

const supportAttachmentUpload = multer({
  storage: multer.diskStorage({
    destination(req, file, callback) {
      const organizationId = String(req.auth?.organizationId || 'org').replace(/[^\d]/g, '') || 'org';
      const destination = path.join(uploadRoot, 'support', organizationId);
      fs.mkdirSync(destination, { recursive: true });
      callback(null, destination);
    },
    filename(req, file, callback) {
      const extension = path.extname(file.originalname || '').toLowerCase();
      const safeName = path
        .basename(file.originalname || 'support-attachment', extension)
        .replace(/[^a-zA-Z0-9-_]+/g, '-')
        .replace(/^-+|-+$/g, '')
        .slice(0, 80) || 'support-attachment';
      callback(null, `${Date.now()}-${Math.round(Math.random() * 1e9)}-${safeName}${extension}`);
    },
  }),
  limits: { files: 10, fileSize: 5 * 1024 * 1024 },
  fileFilter(req, file, callback) {
    if (!allowedImageTypes.has(file.mimetype)) return callback(badRequest('Only JPG, PNG, WEBP, and GIF images are allowed'));
    return callback(null, true);
  },
});

function publicUploadUrl(req, filePath) {
  const relativePath = path.relative(uploadRoot, filePath).split(path.sep).join('/');
  return `${req.protocol}://${req.get('host')}/uploads/${relativePath}`;
}

function removeUploadedFile(imageUrl) {
  if (!imageUrl) return;
  let pathname = '';
  try {
    pathname = new URL(imageUrl).pathname;
  } catch (error) {
    pathname = imageUrl;
  }
  if (!pathname.startsWith('/uploads/')) return;
  const filePath = path.join(uploadRoot, pathname.replace(/^\/uploads\//, ''));
  if (!filePath.startsWith(uploadRoot)) return;
  fs.unlink(filePath, () => {});
}

function bangkokDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Bangkok',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function addDaysIso(dateValue, days) {
  const date = new Date(`${dateValue}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dateTimeStart(dateValue) {
  return `${dateValue} 00:00:00`;
}

function dateTimeEndExclusive(dateValue) {
  return `${addDaysIso(dateValue, 1)} 00:00:00`;
}

function safeIsoDate(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : null;
}

function buildAccountingDateFilter({ dateField, startDate, endDate, aliases = {} }) {
  const clauses = [];
  const params = {};
  const paymentAlias = aliases.payment || 'p';
  const bookingAlias = aliases.booking || 'b';
  const itemAlias = aliases.item || 'bi';
  const itemDateColumn = aliases.itemDateColumn || 'booking_date';

  if (dateField === 'created_date') {
    if (startDate) {
      clauses.push(`${bookingAlias}.created_at >= :startDateTime`);
      params.startDateTime = dateTimeStart(startDate);
    }
    if (endDate) {
      clauses.push(`${bookingAlias}.created_at < :endDateTime`);
      params.endDateTime = dateTimeEndExclusive(endDate);
    }
  } else if (dateField === 'booking_date') {
    if (startDate) {
      clauses.push(`${itemAlias}.${itemDateColumn} >= :startDate`);
      params.startDate = startDate;
    }
    if (endDate) {
      clauses.push(`${itemAlias}.${itemDateColumn} <= :endDate`);
      params.endDate = endDate;
    }
  } else {
    if (startDate) {
      clauses.push(`(${paymentAlias}.paid_at >= :startDateTime OR (${paymentAlias}.paid_at IS NULL AND ${paymentAlias}.created_at >= :startDateTime))`);
      params.startDateTime = dateTimeStart(startDate);
    }
    if (endDate) {
      clauses.push(`(${paymentAlias}.paid_at < :endDateTime OR (${paymentAlias}.paid_at IS NULL AND ${paymentAlias}.created_at < :endDateTime))`);
      params.endDateTime = dateTimeEndExclusive(endDate);
    }
  }

  return {
    sql: clauses.length ? ` AND ${clauses.join(' AND ')}` : '',
    params,
  };
}

function copiedBoothCode(sourceCode, floorPlanId) {
  const suffix = `-C${floorPlanId}`;
  const base = String(sourceCode || 'BOOTH').replace(/[^A-Za-z0-9-_]/g, '').slice(0, 80);
  const trimmedBase = base.slice(0, Math.max(1, 80 - suffix.length));
  return `${trimmedBase}${suffix}`;
}

function nextSequenceCode(rows, fieldName, defaultPrefix) {
  let maxNumber = 0;
  let bestPrefix = defaultPrefix;
  let bestWidth = 3;

  for (const row of rows) {
    const rawValue = String(row?.[fieldName] || '').trim();
    const match = rawValue.match(/^([^0-9]*?)(\d+)$/);
    if (!match) continue;
    const prefix = match[1] || defaultPrefix;
    const digits = match[2];
    const numericValue = Number(digits);
    if (Number.isNaN(numericValue)) continue;
    if (numericValue > maxNumber) {
      maxNumber = numericValue;
      bestPrefix = prefix;
      bestWidth = Math.max(3, digits.length);
    }
  }

  return `${bestPrefix}${String(maxNumber + 1).padStart(bestWidth, '0')}`;
}

function nextSequenceCodes(rows, fieldName, defaultPrefix, count) {
  const total = Math.max(0, Number(count || 0));
  if (!total) return [];

  let maxNumber = 0;
  let bestPrefix = defaultPrefix;
  let bestWidth = 3;

  for (const row of rows) {
    const rawValue = String(row?.[fieldName] || '').trim();
    const match = rawValue.match(/^([^0-9]*?)(\d+)$/);
    if (!match) continue;
    const prefix = match[1] || defaultPrefix;
    const digits = match[2];
    const numericValue = Number(digits);
    if (Number.isNaN(numericValue)) continue;
    if (numericValue > maxNumber) {
      maxNumber = numericValue;
      bestPrefix = prefix;
      bestWidth = Math.max(3, digits.length);
    }
  }

  return Array.from({ length: total }, (_, index) => `${bestPrefix}${String(maxNumber + index + 1).padStart(bestWidth, '0')}`);
}

async function buildNextMarketCode(organizationId) {
  const rows = await query(
    `SELECT code
     FROM markets
     WHERE organization_id = :organizationId`,
    { organizationId },
  );
  return nextSequenceCode(rows, 'code', 'MKT');
}

async function buildNextBoothCode(organizationId, marketId) {
  const rows = await query(
    `SELECT code
     FROM booths
     WHERE organization_id = :organizationId AND market_id = :marketId`,
    { organizationId, marketId },
  );
  return nextSequenceCode(rows, 'code', 'B');
}

async function ensureFixedProductCategories(organizationId, marketId) {
  for (const name of ['อาหาร', 'ไม่ใช่อาหาร']) {
    const existing = await query(
      `SELECT id
       FROM product_categories
       WHERE organization_id = :organizationId AND market_id = :marketId AND name = :name
       LIMIT 1`,
      { organizationId, marketId, name },
    );
    if (existing[0]) {
      await query(
        `UPDATE product_categories
         SET status = 'active'
         WHERE id = :id AND organization_id = :organizationId`,
        { organizationId, id: existing[0].id },
      );
      continue;
    }
    await query(
      `INSERT INTO product_categories (organization_id, market_id, name, status)
       VALUES (:organizationId, :marketId, :name, 'active')`,
      { organizationId, marketId, name },
    );
  }
}

async function syncAnnouncementCoverImage(organizationId, announcementId) {
  const coverRows = await query(
    `SELECT image_url
     FROM announcement_item_images
     WHERE organization_id = :organizationId
       AND announcement_item_id = :announcementId
       AND status = 'active'
       AND is_cover = 1
     ORDER BY sort_order, id
     LIMIT 1`,
    { organizationId, announcementId },
  );

  const fallbackRows = coverRows.length
    ? coverRows
    : await query(
      `SELECT image_url
       FROM announcement_item_images
       WHERE organization_id = :organizationId
         AND announcement_item_id = :announcementId
         AND status = 'active'
       ORDER BY sort_order, id
       LIMIT 1`,
      { organizationId, announcementId },
    );

  const nextImageUrl = fallbackRows[0]?.image_url || null;
  await query(
    `UPDATE announcement_items
     SET image_url = :imageUrl
     WHERE id = :announcementId AND organization_id = :organizationId`,
    { organizationId, announcementId, imageUrl: nextImageUrl },
  );

  return nextImageUrl;
}

async function getAnnouncementMarketSnapshot(organizationId, marketId) {
  if (!marketId) {
    return { marketId: null, marketCode: null, marketName: '' };
  }

  const rows = await query(
    `SELECT id, code, name
     FROM markets
     WHERE id = :marketId
       AND organization_id = :organizationId
     LIMIT 1`,
    { organizationId, marketId },
  );
  const market = rows[0];
  if (!market) throw notFound('Market not found');

  return {
    marketId: market.id,
    marketCode: market.code || null,
    marketName: market.name || '',
  };
}

const ACCOUNTING_DOCUMENT_PREFIX = {
  receipt: 'RC',
  tax_invoice: 'TAX',
  credit_note: 'CN',
};

function toJson(value) {
  return JSON.stringify(value || null);
}

function parseJsonArray(value) {
  if (Array.isArray(value)) return value;
  if (value == null || value === '') return [];
  try {
    const parsed = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : [];
  } catch {
    return String(value)
      .split(',')
      .map((item) => item.trim())
      .filter(Boolean);
  }
}

function supportCategories() {
  return {
    categories: [
      { value: 'issue', label: 'แจ้งปัญหา' },
      { value: 'suggestion', label: 'ข้อเสนอแนะ' },
      { value: 'inquiry', label: 'สอบถาม' },
    ],
    topics: [
      { value: 'booking', label: 'การจอง' },
      { value: 'payment', label: 'การชำระเงิน' },
      { value: 'market_setup', label: 'ตั้งค่าตลาด/บูธ' },
      { value: 'report', label: 'รายงาน' },
      { value: 'account', label: 'บัญชีผู้ใช้งาน' },
      { value: 'integration', label: 'การเชื่อมต่อระบบ' },
      { value: 'feature_request', label: 'ขอฟีเจอร์เพิ่มเติม' },
      { value: 'other', label: 'อื่น ๆ' },
    ],
    priorities: [
      { value: 'low', label: 'ต่ำ' },
      { value: 'normal', label: 'ปกติ' },
      { value: 'high', label: 'สูง' },
      { value: 'urgent', label: 'เร่งด่วน' },
    ],
  };
}

function normalizeSupportBody(body = {}) {
  const category = normalizeCell(body.category || 'issue');
  const topic = normalizeCell(body.topic || 'other');
  const subject = normalizeCell(body.subject);
  const message = normalizeCell(body.message);
  const priority = category === 'issue' ? normalizeCell(body.priority || 'normal') : null;
  const tagOrganization = body.tagOrganization === true || body.tagOrganization === 'true' || body.tagOrganization === '1';
  const taggedOrganizationId = body.taggedOrganizationId ? Number(body.taggedOrganizationId) : null;
  const eventLogIds = parseJsonArray(body.eventLogIds).map(Number).filter((id) => Number.isInteger(id) && id > 0);
  return { category, topic, subject, message, priority, tagOrganization, taggedOrganizationId, eventLogIds };
}

async function ensureSupportTicketAccess(conn, organizationId, ticketId) {
  const [rows] = await conn.execute(
    `SELECT id, organization_id, category, topic, priority, subject, message, status, related_event_log_id,
            tagged_organization_id, created_by_admin_id, created_at, updated_at
     FROM support_tickets
     WHERE id = :ticketId AND organization_id = :organizationId
     LIMIT 1`,
    { organizationId, ticketId },
  );
  if (!rows.length) throw notFound('Support ticket not found');
  return rows[0];
}

async function insertSupportAttachments(conn, req, { organizationId, ticketId, messageId = null }) {
  const files = req.files || [];
  for (const file of files) {
    await conn.execute(
      `INSERT INTO support_ticket_attachments (
        organization_id, support_ticket_id, support_ticket_message_id, file_url, file_name, file_size, mime_type
      ) VALUES (
        :organizationId, :ticketId, :messageId, :fileUrl, :fileName, :fileSize, :mimeType
      )`,
      {
        organizationId,
        ticketId,
        messageId,
        fileUrl: publicUploadUrl(req, file.path),
        fileName: file.originalname || file.filename,
        fileSize: file.size || 0,
        mimeType: file.mimetype || null,
      },
    );
  }
}

async function ensureSupportChatAccess(conn, organizationId, chatId) {
  const [rows] = await conn.execute(
    `SELECT id, organization_id, created_by_admin_id, subject, status, created_at, updated_at
     FROM support_chats
     WHERE id = :chatId AND organization_id = :organizationId
     LIMIT 1`,
    { organizationId, chatId },
  );
  if (!rows.length) throw notFound('Support chat not found');
  return rows[0];
}

async function insertSupportChatAttachments(conn, req, { organizationId, chatId, messageId = null }) {
  const files = req.files || [];
  for (const file of files) {
    await conn.execute(
      `INSERT INTO support_chat_attachments (
        organization_id, support_chat_id, support_chat_message_id, file_url, file_name, file_size, mime_type
      ) VALUES (
        :organizationId, :chatId, :messageId, :fileUrl, :fileName, :fileSize, :mimeType
      )`,
      {
        organizationId,
        chatId,
        messageId,
        fileUrl: publicUploadUrl(req, file.path),
        fileName: file.originalname || file.filename,
        fileSize: file.size || 0,
        mimeType: file.mimetype || null,
      },
    );
  }
}

async function linkSupportEventLogs(conn, { organizationId, ticketId, eventLogIds }) {
  if (!eventLogIds.length) return [];
  const placeholders = eventLogIds.map((_, index) => `:eventLogId${index}`).join(', ');
  const params = eventLogIds.reduce((values, id, index) => {
    values[`eventLogId${index}`] = id;
    return values;
  }, { organizationId });
  const [eventLogs] = await conn.execute(
    `SELECT id
     FROM event_logs
     WHERE organization_id = :organizationId
       AND id IN (${placeholders})
     ORDER BY created_at DESC`,
    params,
  );
  for (const eventLog of eventLogs) {
    await conn.execute(
      `INSERT IGNORE INTO support_ticket_event_logs (organization_id, support_ticket_id, event_log_id)
       VALUES (:organizationId, :ticketId, :eventLogId)`,
      { organizationId, ticketId, eventLogId: eventLog.id },
    );
  }
  return eventLogs.map((eventLog) => eventLog.id);
}

function normalizeCell(value) {
  if (value && typeof value === 'object') {
    if (value.text) return String(value.text).trim();
    if (value.result !== undefined) return normalizeCell(value.result);
    if (Array.isArray(value.richText)) return value.richText.map((part) => part.text || '').join('').trim();
  }
  return String(value ?? '').trim();
}

function normalizeBookingDateCell(value) {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return value.toISOString().slice(0, 10);
  }
  if (value && typeof value === 'object' && value.result) {
    return normalizeBookingDateCell(value.result);
  }
  if (typeof value === 'number' && Number.isFinite(value)) {
    const excelEpoch = Date.UTC(1899, 11, 30);
    const parsedDate = new Date(excelEpoch + value * 24 * 60 * 60 * 1000);
    if (!Number.isNaN(parsedDate.getTime())) return parsedDate.toISOString().slice(0, 10);
  }
  const raw = normalizeCell(value);
  if (/^\d{4}-\d{2}-\d{2}$/.test(raw)) return raw;
  const slashMatch = raw.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})$/);
  if (slashMatch) {
    return `${slashMatch[3]}-${slashMatch[2].padStart(2, '0')}-${slashMatch[1].padStart(2, '0')}`;
  }
  return raw;
}

function dateOnly(value) {
  if (!value) return '';
  if (value instanceof Date && !Number.isNaN(value.getTime())) return value.toISOString().slice(0, 10);
  return String(value).slice(0, 10);
}

function normalizeHeader(value) {
  return normalizeCell(value).replace(/\s+/g, '_').toLowerCase();
}

function worksheetRowsToObjects(worksheet) {
  const headerRow = worksheet.getRow(1);
  const headers = [];
  headerRow.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
    headers[columnNumber] = normalizeHeader(cell.value);
  });

  const rows = [];
  worksheet.eachRow({ includeEmpty: false }, (row, rowNumber) => {
    if (rowNumber === 1) return;
    const record = {};
    row.eachCell({ includeEmpty: true }, (cell, columnNumber) => {
      const key = headers[columnNumber];
      if (key) record[key] = cell.value;
    });
    rows.push({ rowNumber, record });
  });
  return rows;
}

async function bookingImportRowsFromWorkbook(file) {
  const extension = path.extname(file.originalname || '').toLowerCase();
  const workbook = new ExcelJS.Workbook();
  if (extension === '.csv') {
    await workbook.csv.read(Readable.from([file.buffer]));
  } else {
    await workbook.xlsx.load(file.buffer);
  }
  const worksheet = workbook.worksheets[0];
  if (!worksheet) throw badRequest('Excel file has no sheet');
  return worksheetRowsToObjects(worksheet)
    .map(({ rowNumber, record }) => ({
      rowNumber,
      customerIdentifier: normalizeCell(record.customer_identifier || record.customeridentifier || record['รหัสลูกค้า/อีเมล/เบอร์โทร']),
      bookingDate: normalizeBookingDateCell(record.booking_date || record.bookingdate || record['วันที่จอง']),
      boothCode: normalizeCell(record.booth_code || record.boothcode || record['รหัสบูธ']),
      productName: normalizeCell(record.product_name || record.productname || record['สินค้า']),
      note: normalizeCell(record.note || record['หมายเหตุ']),
    }))
    .filter((row) => row.customerIdentifier || row.bookingDate || row.boothCode || row.productName);
}

async function resolveImportMobileUser(conn, organizationId, identifier) {
  const raw = normalizeCell(identifier);
  const lower = raw.toLowerCase();
  const digits = raw.replace(/\D/g, '');
  const candidates = [...new Set([raw, lower, digits].filter(Boolean))];
  const hashCandidates = candidates.map((value) => blindIndex(value));
  const [rows] = await conn.execute(
    `SELECT id, public_id, first_name_enc, last_name_enc
     FROM mobile_users
     WHERE organization_id = :organizationId
       AND status = 'active'
       AND (
         public_id = :rawIdentifier
         OR username_hash IN (:hash0, :hash1, :hash2)
         OR email_hash IN (:hash0, :hash1, :hash2)
         OR phone_hash IN (:hash0, :hash1, :hash2)
       )
     LIMIT 1`,
    {
      organizationId,
      rawIdentifier: raw,
      hash0: hashCandidates[0] || '__no_hash_0__',
      hash1: hashCandidates[1] || '__no_hash_1__',
      hash2: hashCandidates[2] || '__no_hash_2__',
    },
  );
  return rows[0] || null;
}

async function resolveImportBooth(conn, organizationId, marketId, boothCode) {
  const [rows] = await conn.execute(
    `SELECT b.id, b.floor_plan_id, b.category_id, b.code, b.name, b.price,
            fp.start_date AS floor_plan_start_date,
            fp.end_date AS floor_plan_end_date,
            fp.status AS floor_plan_status
     FROM booths b
     LEFT JOIN floor_plans fp ON fp.id = b.floor_plan_id AND fp.organization_id = b.organization_id
     WHERE b.organization_id = :organizationId
       AND b.market_id = :marketId
       AND b.code = :boothCode
       AND b.status = 'active'
     LIMIT 1
     FOR UPDATE`,
    { organizationId, marketId, boothCode },
  );
  return rows[0] || null;
}

async function resolveImportProduct(conn, organizationId, marketId, productName) {
  const [rows] = await conn.execute(
    `SELECT id, category_id, name
     FROM products
     WHERE organization_id = :organizationId
       AND market_id = :marketId
       AND name = :productName
       AND status = 'active'
     ORDER BY id ASC
     LIMIT 1`,
    { organizationId, marketId, productName },
  );
  return rows[0] || null;
}

async function createMobileNotification(conn, {
  organizationId,
  mobileUserId,
  title,
  body,
  data,
}) {
  const [result] = await conn.execute(
    `INSERT INTO mobile_notifications (
      organization_id, mobile_user_id, title, body, data_json, channel, status
    ) VALUES (
      :organizationId, :mobileUserId, :title, :body, :dataJson, 'in_app', 'unread'
    )`,
    {
      organizationId,
      mobileUserId,
      title,
      body,
      dataJson: toJson(data),
    },
  );
  return result.insertId;
}

async function createManagementBooking(conn, {
  organizationId,
  marketId,
  mobileUserId,
  items,
  adminUserId,
  notify = false,
}) {
  await expireStaleBookings(conn, organizationId);
  const [users] = await conn.execute(
    `SELECT id
     FROM mobile_users
     WHERE id = :mobileUserId AND organization_id = :organizationId AND status = 'active'
     LIMIT 1`,
    { mobileUserId, organizationId },
  );
  const mobileUser = users[0];
  if (!mobileUser) throw notFound('Mobile user not found');

  const vatSettings = await getOrganizationVatSettings(conn, organizationId);
  let subtotal = 0;
  const pricedItems = [];
  for (const item of items) {
    const [booths] = await conn.execute(
      `SELECT id, floor_plan_id, category_id, price
       FROM booths
       WHERE id = :boothId AND market_id = :marketId AND organization_id = :organizationId AND status = 'active'
       LIMIT 1
       FOR UPDATE`,
      { boothId: item.boothId, marketId, organizationId },
    );
    if (!booths.length) throw badRequest(`Booth ${item.boothId} is not available`);

    const unitPrice = Number(booths[0].price || 0);
    subtotal += unitPrice;
    pricedItems.push({ ...item, floorPlanId: booths[0].floor_plan_id, unitPrice });
  }
  const totals = calculateVatBreakdown(subtotal, 0, vatSettings);

  const publicBookingId = publicId('BK');
  const [booking] = await conn.execute(
    `INSERT INTO bookings (
      organization_id, public_id, market_id, mobile_user_id, created_by_admin_id, source, cart_visible, status,
      subtotal_amount, discount_amount, vat_amount, total_amount, expires_at
    ) VALUES (
      :organizationId, :publicId, :marketId, :mobileUserId, :createdByAdminId, 'management', 1, 'pending_payment',
      :subtotalAmount, :discountAmount, :vatAmount, :totalAmount, DATE_ADD(NOW(), INTERVAL ${PAYMENT_EXPIRES_MINUTES} MINUTE)
    )`,
    {
      organizationId,
      publicId: publicBookingId,
      marketId,
      mobileUserId,
      createdByAdminId: adminUserId,
      subtotalAmount: totals.subtotalAmount,
      discountAmount: totals.discountAmount,
      vatAmount: totals.vatAmount,
      totalAmount: totals.totalAmount,
    },
  );
  const [createdBookings] = await conn.execute(
    `SELECT expires_at FROM bookings WHERE id = :bookingId AND organization_id = :organizationId LIMIT 1`,
    { organizationId, bookingId: booking.insertId },
  );
  const expiresAt = createdBookings[0]?.expires_at || null;

  for (const item of pricedItems) {
    await insertBoothDateLock(conn, {
      organizationId,
      marketId,
      floorPlanId: item.floorPlanId,
      boothId: item.boothId,
      bookingId: booking.insertId,
      bookingDate: item.bookingDate,
      status: 'held',
      expiresAt,
    });

    const [bookingItem] = await conn.execute(
      `INSERT INTO booking_items (organization_id, booking_id, booth_id, booking_date, unit_price, status)
       VALUES (:organizationId, :bookingId, :boothId, :bookingDate, :unitPrice, 'pending_payment')`,
      {
        organizationId,
        bookingId: booking.insertId,
        boothId: item.boothId,
        bookingDate: item.bookingDate,
        unitPrice: item.unitPrice,
      },
    );
    await attachBookingItemToLock(conn, {
      organizationId,
      bookingId: booking.insertId,
      boothId: item.boothId,
      bookingDate: item.bookingDate,
      bookingItemId: bookingItem.insertId,
    });

    for (const productId of item.productIds || []) {
      await conn.execute(
        `INSERT INTO booking_products (organization_id, booking_item_id, product_id)
         VALUES (:organizationId, :bookingItemId, :productId)`,
        { organizationId, bookingItemId: bookingItem.insertId, productId },
      );
    }
  }

  if (notify) {
    const notificationId = await createMobileNotification(conn, {
      organizationId,
      mobileUserId,
      title: 'มีรายการจองรอชำระเงิน',
      body: `ใบจอง ${publicBookingId} พร้อมให้ชำระเงินผ่านแอปฯ แล้ว`,
      data: {
        type: 'management_booking_created',
        bookingId: booking.insertId,
        publicId: publicBookingId,
        marketId,
        totalAmount: totals.totalAmount,
        expiresAt,
      },
    });
    return {
      id: booking.insertId,
      publicId: publicBookingId,
      expiresAt,
      ...totals,
      paymentRequiredInMobile: true,
      notificationQueued: true,
      notificationId,
    };
  }

  return {
    id: booking.insertId,
    publicId: publicBookingId,
    expiresAt,
    ...totals,
    paymentRequiredInMobile: true,
    notificationQueued: false,
  };
}

function normalizeJsonValue(value) {
  if (!value) return null;
  if (typeof value !== 'string') return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function accountingDocumentTypeLabel(type) {
  if (type === 'tax_invoice') return 'ใบกำกับภาษี / ใบเสร็จรับเงิน';
  if (type === 'credit_note') return 'ใบลดหนี้';
  return 'ใบเสร็จรับเงิน';
}

async function nextAccountingDocumentNo(conn, organizationId, documentType, issueDate) {
  const periodYm = String(issueDate).replace(/-/g, '').slice(0, 6);
  await conn.execute(
    `INSERT INTO accounting_document_sequences (organization_id, document_type, period_ym, sequence_no)
     VALUES (:organizationId, :documentType, :periodYm, 1)
     ON DUPLICATE KEY UPDATE sequence_no = sequence_no + 1`,
    { organizationId, documentType, periodYm },
  );
  const [rows] = await conn.execute(
    `SELECT sequence_no
     FROM accounting_document_sequences
     WHERE organization_id = :organizationId
       AND document_type = :documentType
       AND period_ym = :periodYm
     LIMIT 1
     FOR UPDATE`,
    { organizationId, documentType, periodYm },
  );
  return `${ACCOUNTING_DOCUMENT_PREFIX[documentType]}${periodYm}${String(rows[0].sequence_no).padStart(5, '0')}`;
}

async function fetchPaymentAccountingDetail(conn, organizationId, paymentId, adminUserId, hasGlobalMarketAccess) {
  const [rows] = await conn.execute(
    `SELECT p.id, p.public_id, p.provider, p.status, p.amount, p.paid_at, p.created_at,
            p.audit_check_id,
            COALESCE(b.id, ac_b.id) AS booking_id,
            COALESCE(b.public_id, ac_b.public_id) AS booking_public_id,
            CASE WHEN p.audit_check_id IS NOT NULL THEN 'audit_fine' ELSE 'booking' END AS payment_kind,
            CASE WHEN p.audit_check_id IS NOT NULL
              THEN COALESCE(ac.fine_amount, 0) + COALESCE(ac.accessories_fine_amount, 0) + COALESCE(ac.damage_fine_amount, 0)
              ELSE b.subtotal_amount
            END AS subtotal_amount,
            CASE WHEN p.audit_check_id IS NOT NULL THEN 0 ELSE b.discount_amount END AS discount_amount,
            CASE WHEN p.audit_check_id IS NOT NULL THEN ac.vat_amount ELSE b.vat_amount END AS vat_amount,
            CASE WHEN p.audit_check_id IS NOT NULL THEN ac.total_fine_amount ELSE b.total_amount END AS total_amount,
            m.id AS market_id, m.name AS market_name,
            mu.username_enc, mu.first_name_enc, mu.last_name_enc,
            o.name AS organization_name, o.address AS organization_address, o.email AS organization_email, o.phone AS organization_phone,
            o.vat_enabled, o.vat_rate, o.registered_name, o.registered_tax_id, o.registered_subdistrict,
            o.registered_district, o.registered_province, o.registered_postcode,
            GROUP_CONCAT(DISTINCT DATE_FORMAT(bi.booking_date, '%Y-%m-%d') ORDER BY bi.booking_date SEPARATOR ', ') AS booking_dates,
            GROUP_CONCAT(DISTINCT CONCAT(COALESCE(bo.code, ''), CASE WHEN bo.name IS NULL OR bo.name = '' THEN '' ELSE CONCAT(' ', bo.name) END) ORDER BY bo.sort_order, bo.code SEPARATOR ', ') AS booths
     FROM payments p
     LEFT JOIN bookings b ON b.id = p.booking_id AND b.organization_id = p.organization_id
     LEFT JOIN audit_checks ac ON ac.id = p.audit_check_id AND ac.organization_id = p.organization_id
     LEFT JOIN booking_items ac_bi ON ac_bi.id = ac.booking_item_id AND ac_bi.organization_id = ac.organization_id
     LEFT JOIN bookings ac_b ON ac_b.id = ac_bi.booking_id AND ac_b.organization_id = ac_bi.organization_id
     JOIN organizations o ON o.id = p.organization_id
     JOIN markets m ON m.id = COALESCE(b.market_id, ac.market_id) AND m.organization_id = p.organization_id
     LEFT JOIN mobile_users mu ON mu.id = COALESCE(b.mobile_user_id, ac_b.mobile_user_id) AND mu.organization_id = p.organization_id
     LEFT JOIN booking_items bi
       ON bi.organization_id = p.organization_id
      AND (
        (p.booking_id IS NOT NULL AND bi.booking_id = b.id)
        OR (p.audit_check_id IS NOT NULL AND bi.id = ac.booking_item_id)
      )
     LEFT JOIN booths bo ON bo.id = bi.booth_id
     LEFT JOIN admin_market_assignments ama
       ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
     WHERE p.id = :paymentId
       AND p.organization_id = :organizationId
       AND p.status = 'paid'
       AND (p.booking_id IS NULL OR b.status = 'paid')
       AND (p.audit_check_id IS NULL OR ac.fine_payment_status = 'paid')
       AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
     GROUP BY p.id, p.public_id, p.provider, p.status, p.amount, p.paid_at, p.created_at,
              p.audit_check_id, b.id, b.public_id, b.subtotal_amount, b.discount_amount, b.vat_amount, b.total_amount,
              ac.id, ac.fine_amount, ac.accessories_fine_amount, ac.damage_fine_amount, ac.vat_amount, ac.total_fine_amount,
              ac_b.id, ac_b.public_id,
              m.id, m.name, mu.username_enc, mu.first_name_enc, mu.last_name_enc,
              o.name, o.address, o.email, o.phone, o.vat_enabled, o.vat_rate, o.registered_name,
              o.registered_tax_id, o.registered_subdistrict, o.registered_district, o.registered_province, o.registered_postcode
     LIMIT 1
     FOR UPDATE`,
    { organizationId, paymentId, adminUserId, hasGlobalMarketAccess },
  );
  return rows[0] || null;
}

async function issueAccountingDocument(conn, { organizationId, paymentId, adminUserId, hasGlobalMarketAccess, documentType }) {
  const payment = await fetchPaymentAccountingDetail(conn, organizationId, paymentId, adminUserId, hasGlobalMarketAccess);
  if (!payment) throw notFound('Paid payment not found');

  const resolvedType = documentType || (Number(payment.vat_enabled || 0) === 1 ? 'tax_invoice' : 'receipt');
  const [existing] = await conn.execute(
    `SELECT *
     FROM accounting_documents
     WHERE organization_id = :organizationId
       AND payment_id = :paymentId
       AND document_type = :documentType
       AND document_status = 'issued'
     ORDER BY id DESC
     LIMIT 1`,
    { organizationId, paymentId, documentType: resolvedType },
  );
  if (existing[0]) return { ...payment, document: existing[0] };

  const issueDate = currentDateBangkok();
  const documentNo = await nextAccountingDocumentNo(conn, organizationId, resolvedType, issueDate);
  const customerName = [decryptField(payment.first_name_enc), decryptField(payment.last_name_enc)].filter(Boolean).join(' ').trim() || decryptField(payment.username_enc) || '-';
  const lineItems = [
    {
      description: payment.payment_kind === 'audit_fine' ? 'ค่าปรับ/ค่าบริการตรวจสอบตลาด' : 'ค่าจอง Booth',
      detail: payment.booths || '-',
      amount: Number(payment.subtotal_amount || 0),
    },
  ];
  const organizationSnapshot = {
    name: payment.organization_name,
    address: payment.organization_address,
    email: payment.organization_email,
    phone: payment.organization_phone,
    vatEnabled: Number(payment.vat_enabled || 0) === 1,
    vatRate: payment.vat_rate,
    registeredName: payment.registered_name,
    registeredTaxId: payment.registered_tax_id,
    registeredSubdistrict: payment.registered_subdistrict,
    registeredDistrict: payment.registered_district,
    registeredProvince: payment.registered_province,
    registeredPostcode: payment.registered_postcode,
  };
  const customerSnapshot = {
    name: customerName,
    marketName: payment.market_name,
    bookingPublicId: payment.booking_public_id,
    bookingDates: payment.booking_dates,
  };

  const [createdDocument] = await conn.execute(
    `INSERT INTO accounting_documents (
      organization_id, document_type, document_no, document_status, payment_id, booking_id, audit_check_id,
      issue_date, subtotal_amount, discount_amount, vat_amount, withholding_tax_amount, total_amount,
      customer_name, organization_snapshot_json, customer_snapshot_json, line_items_json, issued_by_admin_id
    ) VALUES (
      :organizationId, :documentType, :documentNo, 'issued', :paymentId, :bookingId, :auditCheckId,
      :issueDate, :subtotalAmount, :discountAmount, :vatAmount, 0, :totalAmount,
      :customerName, :organizationSnapshotJson, :customerSnapshotJson, :lineItemsJson, :adminUserId
    )`,
    {
      organizationId,
      documentType: resolvedType,
      documentNo,
      paymentId: payment.id,
      bookingId: payment.booking_id,
      auditCheckId: payment.audit_check_id || null,
      issueDate,
      subtotalAmount: payment.subtotal_amount || 0,
      discountAmount: payment.discount_amount || 0,
      vatAmount: payment.vat_amount || 0,
      totalAmount: payment.amount || payment.total_amount || 0,
      customerName,
      organizationSnapshotJson: toJson(organizationSnapshot),
      customerSnapshotJson: toJson(customerSnapshot),
      lineItemsJson: toJson(lineItems),
      adminUserId,
    },
  );
  const [documents] = await conn.execute(`SELECT * FROM accounting_documents WHERE id = :id LIMIT 1`, { id: createdDocument.insertId });
  return { ...payment, customer_name: customerName, document: documents[0] };
}

router.post(
  '/auth/login',
  validate(
    z.object({
      body: z.object({
        organizationCode: z.string().min(1),
        username: z.string().min(1),
        password: z.string().min(1),
        rememberMe: z.boolean().optional().default(false),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await authService.loginManagement(req.validated.body);
    return ok(res, result);
  }),
);

router.use(authenticate, requireManagement);

router.get('/me', (req, res) => {
  ok(res, {
    id: req.auth.sub,
    organizationId: req.auth.organizationId,
    role: req.auth.role,
    menus: MENU_ACCESS[req.auth.role] || [],
    marketIds: req.auth.marketIds || [],
  });
});

router.get(
  '/subscription/current',
  asyncHandler(async (req, res) => {
    const subscription = await getCurrentSubscription(req.auth.organizationId);
    return ok(res, subscription);
  }),
);

router.get(
  '/support/categories',
  asyncHandler(async (req, res) => ok(res, supportCategories())),
);

router.get(
  '/support/event-logs/recent',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit || 30), 100);
    const rows = await query(
      `SELECT id, actor_type, actor_id, actor_role, channel, action, entity_type, entity_id,
              method, path, status_code, success, created_at
       FROM event_logs
       WHERE organization_id = :organizationId
       ORDER BY created_at DESC, id DESC
       LIMIT :limit`,
      { organizationId: req.auth.organizationId, limit },
    );
    return ok(res, rows);
  }),
);

router.get(
  '/support/tickets',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit || 100), 300);
    const categoryFilter = String(req.query.category || '').trim();
    const rows = await query(
      `SELECT st.id, st.category, st.topic, st.priority, st.subject, st.message, st.status,
              st.related_event_log_id, st.tagged_organization_id, st.created_by_admin_id,
              st.created_at, st.updated_at,
              COUNT(DISTINCT sta.id) AS attachment_count,
              COUNT(DISTINCT stm.id) AS message_count,
              MAX(stm.created_at) AS last_message_at
       FROM support_tickets st
       LEFT JOIN support_ticket_attachments sta
         ON sta.support_ticket_id = st.id
        AND sta.organization_id = st.organization_id
       LEFT JOIN support_ticket_messages stm
         ON stm.support_ticket_id = st.id
        AND stm.organization_id = st.organization_id
       WHERE st.organization_id = :organizationId
         AND (
           :categoryFilter = ''
           OR (:categoryFilter = 'ticket' AND st.category <> 'inquiry')
           OR st.category = :categoryFilter
         )
       GROUP BY st.id, st.category, st.topic, st.priority, st.subject, st.message, st.status,
                st.related_event_log_id, st.tagged_organization_id, st.created_by_admin_id,
                st.created_at, st.updated_at
       ORDER BY st.updated_at DESC, st.id DESC
       LIMIT :limit`,
      { organizationId: req.auth.organizationId, categoryFilter, limit },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/support/tickets',
  supportAttachmentUpload.array('attachments', 10),
  asyncHandler(async (req, res) => {
    const body = normalizeSupportBody(req.body);
    const categoryValues = new Set(supportCategories().categories.map((item) => item.value));
    const topicValues = new Set(supportCategories().topics.map((item) => item.value));
    const priorityValues = new Set(supportCategories().priorities.map((item) => item.value));
    if (!categoryValues.has(body.category)) throw badRequest('Invalid support category');
    if (!topicValues.has(body.topic)) throw badRequest('Invalid support topic');
    if (body.category === 'inquiry' && body.topic === 'feature_request') {
      throw badRequest('Feature requests must be submitted as a ticket');
    }
    if (body.category === 'issue' && !priorityValues.has(body.priority)) throw badRequest('Invalid support priority');
    if (!body.subject) throw badRequest('Subject is required');
    if (!body.message) throw badRequest('Message is required');

    const result = await transaction(async (conn) => {
      const linkedEventLogIds = body.eventLogIds;
      const relatedEventLogId = linkedEventLogIds[0] || null;
      if (relatedEventLogId) {
        const [eventLogs] = await conn.execute(
          `SELECT id FROM event_logs WHERE id = :eventLogId AND organization_id = :organizationId LIMIT 1`,
          { eventLogId: relatedEventLogId, organizationId: req.auth.organizationId },
        );
        if (!eventLogs.length) throw badRequest('Related event log not found');
      }

      const taggedOrganizationId = body.tagOrganization
        ? body.taggedOrganizationId || req.auth.organizationId
        : null;
      if (taggedOrganizationId) {
        const [organizations] = await conn.execute(
          `SELECT id FROM organizations WHERE id = :organizationId LIMIT 1`,
          { organizationId: taggedOrganizationId },
        );
        if (!organizations.length) throw badRequest('Tagged organization not found');
      }

      const [ticket] = await conn.execute(
        `INSERT INTO support_tickets (
          organization_id, tagged_organization_id, created_by_admin_id, category, topic, priority,
          subject, message, status, related_event_log_id, metadata_json
        ) VALUES (
          :organizationId, :taggedOrganizationId, :createdByAdminId, :category, :topic, :priority,
          :subject, :message, 'opened', :relatedEventLogId, :metadataJson
        )`,
        {
          organizationId: req.auth.organizationId,
          taggedOrganizationId,
          createdByAdminId: req.auth.sub,
          category: body.category,
          topic: body.topic,
          priority: body.priority,
          subject: body.subject,
          message: body.message,
          relatedEventLogId,
          metadataJson: toJson({
            source: 'management',
            originalEventLogIds: body.eventLogIds,
          }),
        },
      );

      const [message] = await conn.execute(
        `INSERT INTO support_ticket_messages (
          organization_id, support_ticket_id, sender_type, sender_admin_user_id, message
        ) VALUES (
          :organizationId, :ticketId, 'management', :senderAdminUserId, :message
        )`,
        {
          organizationId: req.auth.organizationId,
          ticketId: ticket.insertId,
          senderAdminUserId: req.auth.sub,
          message: body.message,
        },
      );
      await insertSupportAttachments(conn, req, {
        organizationId: req.auth.organizationId,
        ticketId: ticket.insertId,
        messageId: message.insertId,
      });
      const linked = await linkSupportEventLogs(conn, {
        organizationId: req.auth.organizationId,
        ticketId: ticket.insertId,
        eventLogIds: body.eventLogIds,
      });
      return { id: ticket.insertId, messageId: message.insertId, linkedEventLogIds: linked };
    });

    return created(res, result, 'support ticket created');
  }),
);

router.get(
  '/support/tickets/:ticketId',
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({}).passthrough(),
      params: z.object({ ticketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const ticketId = req.validated.params.ticketId;
    const ticket = await transaction(async (conn) => ensureSupportTicketAccess(conn, req.auth.organizationId, ticketId));
    const attachments = await query(
      `SELECT id, support_ticket_message_id, file_url, file_name, file_size, mime_type, created_at
       FROM support_ticket_attachments
       WHERE organization_id = :organizationId AND support_ticket_id = :ticketId
       ORDER BY created_at ASC, id ASC`,
      { organizationId: req.auth.organizationId, ticketId },
    );
    const eventLogs = await query(
      `SELECT el.id, el.channel, el.action, el.entity_type, el.entity_id, el.method,
              el.path, el.status_code, el.success, el.created_at
       FROM support_ticket_event_logs stel
       JOIN event_logs el ON el.id = stel.event_log_id
       WHERE stel.organization_id = :organizationId
         AND stel.support_ticket_id = :ticketId
       ORDER BY el.created_at DESC`,
      { organizationId: req.auth.organizationId, ticketId },
    );
    return ok(res, { ...ticket, attachments, eventLogs });
  }),
);

async function supportTicketMessages(req, res) {
  const ticketId = Number(req.params.ticketId);
  const afterId = Math.max(Number(req.query.afterId || 0), 0);
  await transaction(async (conn) => ensureSupportTicketAccess(conn, req.auth.organizationId, ticketId));
  const rows = await query(
    `SELECT stm.id, stm.sender_type, stm.sender_admin_user_id, stm.message, stm.created_at,
            au.username_hash AS sender_username_hash
     FROM support_ticket_messages stm
     LEFT JOIN admin_users au
       ON au.id = stm.sender_admin_user_id
      AND au.organization_id = stm.organization_id
     WHERE stm.organization_id = :organizationId
       AND stm.support_ticket_id = :ticketId
       AND stm.id > :afterId
     ORDER BY stm.id ASC`,
    { organizationId: req.auth.organizationId, ticketId, afterId },
  );
  return ok(res, rows);
}

router.get('/support/tickets/:ticketId/messages', asyncHandler(supportTicketMessages));

router.get(
  '/support/tickets/:ticketId/messages/stream',
  asyncHandler(async (req, res) => {
    const ticketId = Number(req.params.ticketId);
    await transaction(async (conn) => ensureSupportTicketAccess(conn, req.auth.organizationId, ticketId));
    res.setHeader('Content-Type', 'text/event-stream');
    res.setHeader('Cache-Control', 'no-cache, no-transform');
    res.setHeader('Connection', 'keep-alive');
    res.flushHeaders?.();

    let afterId = Math.max(Number(req.query.afterId || 0), 0);
    let closed = false;
    req.on('close', () => {
      closed = true;
    });

    async function sendMessages() {
      if (closed) return;
      const rows = await query(
        `SELECT id, sender_type, sender_admin_user_id, message, created_at
         FROM support_ticket_messages
         WHERE organization_id = :organizationId
           AND support_ticket_id = :ticketId
           AND id > :afterId
         ORDER BY id ASC`,
        { organizationId: req.auth.organizationId, ticketId, afterId },
      );
      if (rows.length) {
        afterId = rows[rows.length - 1].id;
        res.write(`event: messages\ndata: ${JSON.stringify(rows)}\n\n`);
      } else {
        res.write(`event: ping\ndata: ${JSON.stringify({ at: new Date().toISOString() })}\n\n`);
      }
    }

    await sendMessages();
    const timer = setInterval(() => {
      sendMessages().catch((error) => {
        res.write(`event: error\ndata: ${JSON.stringify({ message: error.message })}\n\n`);
      });
    }, 3000);
    req.on('close', () => clearInterval(timer));
  }),
);

router.post(
  '/support/tickets/:ticketId/messages',
  supportAttachmentUpload.array('attachments', 10),
  validate(
    z.object({
      body: z.object({ message: z.string().min(1) }).passthrough(),
      query: z.object({}).passthrough(),
      params: z.object({ ticketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const ticketId = req.validated.params.ticketId;
    const result = await transaction(async (conn) => {
      await ensureSupportTicketAccess(conn, req.auth.organizationId, ticketId);
      const [message] = await conn.execute(
        `INSERT INTO support_ticket_messages (
          organization_id, support_ticket_id, sender_type, sender_admin_user_id, message
        ) VALUES (
          :organizationId, :ticketId, 'management', :senderAdminUserId, :message
        )`,
        {
          organizationId: req.auth.organizationId,
          ticketId,
          senderAdminUserId: req.auth.sub,
          message: req.validated.body.message,
        },
      );
      await conn.execute(
        `UPDATE support_tickets SET updated_at = CURRENT_TIMESTAMP WHERE id = :ticketId AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, ticketId },
      );
      await insertSupportAttachments(conn, req, {
        organizationId: req.auth.organizationId,
        ticketId,
        messageId: message.insertId,
      });
      return { id: message.insertId };
    });
    return created(res, result, 'support message created');
  }),
);

router.get(
  '/support/chats',
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit || 100), 300);
    const rows = await query(
      `SELECT sc.id, sc.subject, sc.status, sc.created_by_admin_id, sc.created_at, sc.updated_at,
              COUNT(DISTINCT scm.id) AS message_count,
              COUNT(DISTINCT sca.id) AS attachment_count,
              MAX(scm.created_at) AS last_message_at
       FROM support_chats sc
       LEFT JOIN support_chat_messages scm
         ON scm.support_chat_id = sc.id
        AND scm.organization_id = sc.organization_id
       LEFT JOIN support_chat_attachments sca
         ON sca.support_chat_id = sc.id
        AND sca.organization_id = sc.organization_id
       WHERE sc.organization_id = :organizationId
       GROUP BY sc.id, sc.subject, sc.status, sc.created_by_admin_id, sc.created_at, sc.updated_at
       ORDER BY sc.updated_at DESC, sc.id DESC
       LIMIT :limit`,
      { organizationId: req.auth.organizationId, limit },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/support/chats',
  supportAttachmentUpload.array('attachments', 10),
  asyncHandler(async (req, res) => {
    const subject = normalizeCell(req.body?.subject || 'สอบถามทั่วไป');
    const messageText = normalizeCell(req.body?.message);
    if (!messageText) throw badRequest('Message is required');
    const result = await transaction(async (conn) => {
      const [chat] = await conn.execute(
        `INSERT INTO support_chats (organization_id, created_by_admin_id, subject, status)
         VALUES (:organizationId, :createdByAdminId, :subject, 'open')`,
        { organizationId: req.auth.organizationId, createdByAdminId: req.auth.sub, subject },
      );
      const [message] = await conn.execute(
        `INSERT INTO support_chat_messages (
          organization_id, support_chat_id, sender_type, sender_admin_user_id, message
        ) VALUES (
          :organizationId, :chatId, 'management', :senderAdminUserId, :message
        )`,
        {
          organizationId: req.auth.organizationId,
          chatId: chat.insertId,
          senderAdminUserId: req.auth.sub,
          message: messageText,
        },
      );
      await insertSupportChatAttachments(conn, req, {
        organizationId: req.auth.organizationId,
        chatId: chat.insertId,
        messageId: message.insertId,
      });
      return { id: chat.insertId, messageId: message.insertId };
    });
    return created(res, result, 'support chat created');
  }),
);

router.get(
  '/support/chats/:chatId',
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({}).passthrough(),
      params: z.object({ chatId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const chatId = req.validated.params.chatId;
    const chat = await transaction(async (conn) => ensureSupportChatAccess(conn, req.auth.organizationId, chatId));
    const attachments = await query(
      `SELECT id, support_chat_message_id, file_url, file_name, file_size, mime_type, created_at
       FROM support_chat_attachments
       WHERE organization_id = :organizationId AND support_chat_id = :chatId
       ORDER BY created_at ASC, id ASC`,
      { organizationId: req.auth.organizationId, chatId },
    );
    return ok(res, { ...chat, attachments });
  }),
);

router.get(
  '/support/chats/:chatId/messages',
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({ afterId: z.coerce.number().int().min(0).optional().default(0) }).passthrough(),
      params: z.object({ chatId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const chatId = req.validated.params.chatId;
    await transaction(async (conn) => ensureSupportChatAccess(conn, req.auth.organizationId, chatId));
    const rows = await query(
      `SELECT id, sender_type, sender_admin_user_id, message, created_at
       FROM support_chat_messages
       WHERE organization_id = :organizationId
         AND support_chat_id = :chatId
         AND id > :afterId
       ORDER BY id ASC`,
      { organizationId: req.auth.organizationId, chatId, afterId: req.validated.query.afterId },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/support/chats/:chatId/messages',
  supportAttachmentUpload.array('attachments', 10),
  validate(
    z.object({
      body: z.object({ message: z.string().min(1) }).passthrough(),
      query: z.object({}).passthrough(),
      params: z.object({ chatId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const chatId = req.validated.params.chatId;
    const result = await transaction(async (conn) => {
      await ensureSupportChatAccess(conn, req.auth.organizationId, chatId);
      const [message] = await conn.execute(
        `INSERT INTO support_chat_messages (
          organization_id, support_chat_id, sender_type, sender_admin_user_id, message
        ) VALUES (
          :organizationId, :chatId, 'management', :senderAdminUserId, :message
        )`,
        {
          organizationId: req.auth.organizationId,
          chatId,
          senderAdminUserId: req.auth.sub,
          message: req.validated.body.message,
        },
      );
      await conn.execute(
        `UPDATE support_chats SET updated_at = CURRENT_TIMESTAMP WHERE id = :chatId AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, chatId },
      );
      await insertSupportChatAttachments(conn, req, {
        organizationId: req.auth.organizationId,
        chatId,
        messageId: message.insertId,
      });
      return { id: message.insertId };
    });
    return created(res, result, 'support chat message created');
  }),
);

router.use(requireSubscriptionForMutations());

router.get(
  '/event-logs',
  requireRoles(ROLES.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const limit = Math.min(Number(req.query.limit || 100), 500);
    const offset = Math.max(Number(req.query.offset || 0), 0);
    const rows = await query(
      `SELECT id, organization_id, actor_type, actor_id, actor_role, channel, action,
              entity_type, entity_id, method, path, route_path, status_code, success,
              ip_address, user_agent, request_json, response_json, created_at
       FROM event_logs
       WHERE organization_id = :organizationId
       ORDER BY created_at DESC, id DESC
       LIMIT :limit OFFSET :offset`,
      { organizationId: req.auth.organizationId, limit, offset },
    );
    return ok(res, rows);
  }),
);

router.get(
  '/organization-settings',
  requireRoles(ROLES.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, code, name, address, email, phone, line_id,
              vat_enabled, vat_rate, registered_name, registered_tax_id, registered_address,
              registered_subdistrict, registered_district, registered_province, registered_postcode,
              payment_promptpay_id, payment_bank_name, payment_bank_account_name,
              payment_bank_account_no, payment_qrcode_image_url, payment_instructions,
              status, created_at, updated_at
       FROM organizations
       WHERE id = :organizationId
       LIMIT 1`,
      { organizationId: req.auth.organizationId },
    );
    const organization = rows[0];
    if (!organization) throw notFound('Organization not found');
    return ok(res, organization);
  }),
);

router.put(
  '/organization-settings',
  requireRoles(ROLES.SUPERVISOR),
  paymentAssetUpload.single('paymentQrCodeImage'),
  validate(
    z.object({
      body: z.object({
        name: z.string().min(1).max(255),
        address: z.string().optional().default(''),
        email: z.string().email().optional().or(z.literal('')).default(''),
        phone: z.string().optional().default(''),
        lineId: z.string().optional().default(''),
        vatEnabled: z.preprocess((value) => value === true || value === 'true' || value === '1' || value === 1, z.boolean()).optional().default(false),
        vatRate: z.coerce.number().min(0).max(100).optional().default(7),
        registeredName: z.string().optional().default(''),
        registeredTaxId: z.string().optional().default(''),
        registeredAddress: z.string().optional().default(''),
        registeredSubdistrict: z.string().optional().default(''),
        registeredDistrict: z.string().optional().default(''),
        registeredProvince: z.string().optional().default(''),
        registeredPostcode: z.string().optional().default(''),
        paymentPromptpayId: z.string().optional().default(''),
        paymentBankName: z.string().optional().default(''),
        paymentBankAccountName: z.string().optional().default(''),
        paymentBankAccountNo: z.string().optional().default(''),
        paymentInstructions: z.string().optional().default(''),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const existingRows = await query(
      `SELECT payment_qrcode_image_url
       FROM organizations
       WHERE id = :organizationId
       LIMIT 1`,
      { organizationId: req.auth.organizationId },
    );
    const paymentQrCodeImageUrl = req.file
      ? publicUploadUrl(req, req.file.path)
      : existingRows[0]?.payment_qrcode_image_url || null;
    if (body.vatEnabled) {
      const requiredFields = [
        ['vatRate', body.vatRate],
        ['registeredName', body.registeredName],
        ['registeredTaxId', body.registeredTaxId],
        ['registeredSubdistrict', body.registeredSubdistrict],
        ['registeredDistrict', body.registeredDistrict],
        ['registeredProvince', body.registeredProvince],
        ['registeredPostcode', body.registeredPostcode],
      ];
      const missingField = requiredFields.find(([, value]) => String(value || '').trim() === '' || Number(value) === 0);
      if (missingField) throw badRequest('VAT registration information is required');
    }

    await query(
      `UPDATE organizations
       SET name = :name,
           address = :address,
           email = :email,
           phone = :phone,
           line_id = :lineId,
           vat_enabled = :vatEnabled,
           vat_rate = :vatRate,
           registered_name = :registeredName,
           registered_tax_id = :registeredTaxId,
           registered_address = :registeredAddress,
           registered_subdistrict = :registeredSubdistrict,
           registered_district = :registeredDistrict,
           registered_province = :registeredProvince,
           registered_postcode = :registeredPostcode,
           payment_promptpay_id = :paymentPromptpayId,
           payment_bank_name = :paymentBankName,
           payment_bank_account_name = :paymentBankAccountName,
           payment_bank_account_no = :paymentBankAccountNo,
           payment_qrcode_image_url = :paymentQrCodeImageUrl,
           payment_instructions = :paymentInstructions
       WHERE id = :organizationId`,
      {
        organizationId: req.auth.organizationId,
        name: body.name,
        address: body.address,
        email: body.email,
        phone: body.phone,
        lineId: body.lineId,
        vatEnabled: body.vatEnabled ? 1 : 0,
        vatRate: body.vatRate,
        registeredName: body.registeredName,
        registeredTaxId: body.registeredTaxId,
        registeredAddress: body.registeredAddress,
        registeredSubdistrict: body.registeredSubdistrict,
        registeredDistrict: body.registeredDistrict,
        registeredProvince: body.registeredProvince,
        registeredPostcode: body.registeredPostcode,
        paymentPromptpayId: body.paymentPromptpayId,
        paymentBankName: body.paymentBankName,
        paymentBankAccountName: body.paymentBankAccountName,
        paymentBankAccountNo: body.paymentBankAccountNo,
        paymentQrCodeImageUrl,
        paymentInstructions: body.paymentInstructions,
      },
    );
    if (req.file && existingRows[0]?.payment_qrcode_image_url) removeUploadedFile(existingRows[0].payment_qrcode_image_url);
    clearPublicReadCache();
    return ok(
      res,
      {
        id: req.auth.organizationId,
        name: body.name,
        address: body.address,
        email: body.email,
        phone: body.phone,
        line_id: body.lineId,
        vat_enabled: body.vatEnabled ? 1 : 0,
        vat_rate: body.vatRate,
        registered_name: body.registeredName,
        registered_tax_id: body.registeredTaxId,
        registered_address: body.registeredAddress,
        registered_subdistrict: body.registeredSubdistrict,
        registered_district: body.registeredDistrict,
        registered_province: body.registeredProvince,
        registered_postcode: body.registeredPostcode,
        payment_promptpay_id: body.paymentPromptpayId,
        payment_bank_name: body.paymentBankName,
        payment_bank_account_name: body.paymentBankAccountName,
        payment_bank_account_no: body.paymentBankAccountNo,
        payment_qrcode_image_url: paymentQrCodeImageUrl,
        payment_instructions: body.paymentInstructions,
      },
      'organization settings updated',
    );
  }),
);

router.get(
  '/announcements',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const type = ['news', 'banner'].includes(req.query.type) ? req.query.type : null;
    const rows = await query(
      `SELECT ai.id, ai.market_id, ai.market_code, ai.type, ai.title, ai.description, ai.image_url, ai.start_date, ai.end_date, ai.status, ai.created_at,
              m.name AS market_name,
              (
                SELECT COUNT(*)
                FROM announcement_item_images aii
                WHERE aii.announcement_item_id = ai.id
                  AND aii.organization_id = ai.organization_id
                  AND aii.status = 'active'
              ) AS image_count
       FROM announcement_items
       ai
       LEFT JOIN markets m
         ON m.id = ai.market_id
        AND m.organization_id = ai.organization_id
       WHERE ai.organization_id = :organizationId
         AND (:type IS NULL OR type = :type)
       ORDER BY ai.start_date DESC, ai.id DESC`,
      { organizationId: req.auth.organizationId, type },
    );
    return ok(res, rows);
  }),
);

router.get(
  '/announcements/:announcementId',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const announcementId = Number(req.params.announcementId);
    const rows = await query(
      `SELECT ai.id, ai.market_id, ai.market_code, ai.type, ai.title, ai.description, ai.image_url, ai.start_date, ai.end_date, ai.status, ai.created_at, ai.updated_at,
              m.name AS market_name
       FROM announcement_items
       ai
       LEFT JOIN markets m
         ON m.id = ai.market_id
        AND m.organization_id = ai.organization_id
       WHERE ai.id = :announcementId AND ai.organization_id = :organizationId
       LIMIT 1`,
      { organizationId: req.auth.organizationId, announcementId },
    );
    const current = rows[0];
    if (!current) throw notFound('Announcement not found');

    const images = await query(
      `SELECT id, image_url, sort_order, is_cover, status, created_at
       FROM announcement_item_images
       WHERE organization_id = :organizationId
         AND announcement_item_id = :announcementId
         AND status = 'active'
       ORDER BY is_cover DESC, sort_order, id`,
      { organizationId: req.auth.organizationId, announcementId },
    );

    return ok(res, { ...current, images });
  }),
);

router.post(
  '/announcements',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  announcementAssetUpload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'images', maxCount: 20 },
  ]),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        body: z.object({
          type: z.enum(['news', 'banner']),
          marketId: z.coerce.number().int().positive().optional().nullable(),
          title: z.string().min(1),
          description: z.string().optional().default(''),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
          status: z.enum(['active', 'inactive']).default('active'),
        }),
      })
      .parse({ body: req.body });
    const body = parsed.body;
    if (body.type === 'news' && !body.marketId) throw badRequest('Market is required for news announcements');
    const market = await getAnnouncementMarketSnapshot(req.auth.organizationId, body.marketId || null);
    const bannerImage = req.files?.image?.[0] || null;
    const galleryImages = req.files?.images || [];
    const createdImageUrls = galleryImages.map((file) => publicUploadUrl(req, file.path));
    const imageUrl = bannerImage
      ? publicUploadUrl(req, bannerImage.path)
      : createdImageUrls[0] || null;
    const result = await query(
      `INSERT INTO announcement_items (
        organization_id, market_id, market_code, type, title, description, image_url, start_date, end_date, status, created_by_admin_id
      ) VALUES (
        :organizationId, :marketId, :marketCode, :type, :title, :description, :imageUrl, :startDate, :endDate, :status, :createdByAdminId
      )`,
      {
        organizationId: req.auth.organizationId,
        marketId: market.marketId,
        marketCode: market.marketCode,
        type: body.type,
        title: body.title,
        description: body.description,
        imageUrl,
        startDate: body.startDate || null,
        endDate: body.endDate || null,
        status: body.status,
        createdByAdminId: req.auth.sub,
      },
    );
    if (body.type === 'news' && createdImageUrls.length) {
      for (const [index, createdUrl] of createdImageUrls.entries()) {
        await query(
          `INSERT INTO announcement_item_images (
            organization_id, announcement_item_id, image_url, sort_order, is_cover, status, created_by_admin_id
          ) VALUES (
            :organizationId, :announcementId, :imageUrl, :sortOrder, :isCover, 'active', :createdByAdminId
          )`,
          {
            organizationId: req.auth.organizationId,
            announcementId: result.insertId,
            imageUrl: createdUrl,
            sortOrder: index,
            isCover: index === 0 ? 1 : 0,
            createdByAdminId: req.auth.sub,
          },
        );
      }
    }
    clearPublicReadCache();
    return created(res, { id: result.insertId, imageUrl }, 'announcement created');
  }),
);

router.patch(
  '/announcements/:announcementId',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  announcementAssetUpload.fields([
    { name: 'image', maxCount: 1 },
    { name: 'images', maxCount: 20 },
  ]),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        params: z.object({ announcementId: z.coerce.number().int().positive() }),
        body: z.object({
          marketId: z.coerce.number().int().positive().optional().nullable(),
          title: z.string().min(1),
          description: z.string().optional().default(''),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional().nullable(),
          coverImageId: z.coerce.number().int().positive().optional().nullable(),
          status: z.enum(['active', 'inactive']).default('active'),
        }),
      })
      .parse({ params: req.params, body: req.body });
    const rows = await query(
      `SELECT image_url, type, market_id
       FROM announcement_items
       WHERE id = :announcementId AND organization_id = :organizationId
       LIMIT 1`,
      { organizationId: req.auth.organizationId, announcementId: parsed.params.announcementId },
    );
    const current = rows[0];
    if (!current) throw notFound('Announcement not found');
    const nextMarketId = parsed.body.marketId === undefined ? current.market_id : (parsed.body.marketId || null);
    if (current.type === 'news' && !nextMarketId) throw badRequest('Market is required for news announcements');
    const market = await getAnnouncementMarketSnapshot(
      req.auth.organizationId,
      nextMarketId,
    );
    const bannerImage = req.files?.image?.[0] || null;
    const galleryImages = req.files?.images || [];
    const imageUrl = bannerImage ? publicUploadUrl(req, bannerImage.path) : current.image_url;
    await query(
      `UPDATE announcement_items
       SET market_id = :marketId,
           market_code = :marketCode,
           title = :title,
           description = :description,
           image_url = :imageUrl,
           start_date = :startDate,
           end_date = :endDate,
           status = :status
       WHERE id = :announcementId AND organization_id = :organizationId`,
      {
        organizationId: req.auth.organizationId,
        announcementId: parsed.params.announcementId,
        marketId: market.marketId,
        marketCode: market.marketCode,
        title: parsed.body.title,
        description: parsed.body.description,
        imageUrl,
        startDate: parsed.body.startDate || null,
        endDate: parsed.body.endDate || null,
        status: parsed.body.status,
      },
    );

    if (current.type === 'news' && galleryImages.length) {
      const lastImageRow = await query(
        `SELECT COALESCE(MAX(sort_order), -1) AS max_sort
         FROM announcement_item_images
         WHERE organization_id = :organizationId AND announcement_item_id = :announcementId`,
        { organizationId: req.auth.organizationId, announcementId: parsed.params.announcementId },
      );
      let nextSort = Number(lastImageRow[0]?.max_sort || -1) + 1;
      for (const file of galleryImages) {
        await query(
          `INSERT INTO announcement_item_images (
            organization_id, announcement_item_id, image_url, sort_order, is_cover, status, created_by_admin_id
          ) VALUES (
            :organizationId, :announcementId, :imageUrl, :sortOrder, 0, 'active', :createdByAdminId
          )`,
          {
            organizationId: req.auth.organizationId,
            announcementId: parsed.params.announcementId,
            imageUrl: publicUploadUrl(req, file.path),
            sortOrder: nextSort,
            createdByAdminId: req.auth.sub,
          },
        );
        nextSort += 1;
      }
    }

    if (parsed.body.coverImageId) {
      await query(
        `UPDATE announcement_item_images
         SET is_cover = CASE WHEN id = :coverImageId THEN 1 ELSE 0 END
         WHERE organization_id = :organizationId
           AND announcement_item_id = :announcementId
           AND status = 'active'`,
        {
          organizationId: req.auth.organizationId,
          announcementId: parsed.params.announcementId,
          coverImageId: parsed.body.coverImageId,
        },
      );
      await syncAnnouncementCoverImage(req.auth.organizationId, parsed.params.announcementId);
    } else if (current.type === 'news' && galleryImages.length) {
      await syncAnnouncementCoverImage(req.auth.organizationId, parsed.params.announcementId);
    }

    if (bannerImage && current.image_url !== imageUrl) removeUploadedFile(current.image_url);
    clearPublicReadCache();
    return ok(res, { id: parsed.params.announcementId, imageUrl }, 'announcement updated');
  }),
);

router.patch(
  '/announcements/:announcementId/images/:imageId/cover',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const announcementId = Number(req.params.announcementId);
    const imageId = Number(req.params.imageId);
    const rows = await query(
      `SELECT id
       FROM announcement_item_images
       WHERE id = :imageId
         AND announcement_item_id = :announcementId
         AND organization_id = :organizationId
         AND status = 'active'
       LIMIT 1`,
      { organizationId: req.auth.organizationId, announcementId, imageId },
    );
    if (!rows[0]) throw notFound('Announcement image not found');

    await query(
      `UPDATE announcement_item_images
       SET is_cover = CASE WHEN id = :imageId THEN 1 ELSE 0 END
       WHERE organization_id = :organizationId
         AND announcement_item_id = :announcementId
         AND status = 'active'`,
      { organizationId: req.auth.organizationId, announcementId, imageId },
    );
    const imageUrl = await syncAnnouncementCoverImage(req.auth.organizationId, announcementId);
    clearPublicReadCache();
    return ok(res, { announcementId, imageId, imageUrl }, 'announcement cover updated');
  }),
);

router.delete(
  '/announcements/:announcementId/images/:imageId',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const announcementId = Number(req.params.announcementId);
    const imageId = Number(req.params.imageId);
    const rows = await query(
      `SELECT image_url
       FROM announcement_item_images
       WHERE id = :imageId
         AND announcement_item_id = :announcementId
         AND organization_id = :organizationId
         AND status = 'active'
       LIMIT 1`,
      { organizationId: req.auth.organizationId, announcementId, imageId },
    );
    const current = rows[0];
    if (!current) throw notFound('Announcement image not found');

    await query(
      `UPDATE announcement_item_images
       SET status = 'inactive', is_cover = 0
       WHERE id = :imageId
         AND announcement_item_id = :announcementId
         AND organization_id = :organizationId`,
      { organizationId: req.auth.organizationId, announcementId, imageId },
    );
    removeUploadedFile(current.image_url);
    const imageUrl = await syncAnnouncementCoverImage(req.auth.organizationId, announcementId);
    clearPublicReadCache();
    return ok(res, { announcementId, imageId, imageUrl }, 'announcement image deleted');
  }),
);

router.get(
  '/contact-us',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, market_id, title, phone, email, line_id, address, status, updated_at
       FROM contact_us_settings
       WHERE organization_id = :organizationId
       ORDER BY id DESC`,
      { organizationId: req.auth.organizationId },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/contact-us',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  validate(
    z.object({
      body: z.object({
        marketId: z.coerce.number().int().positive().optional().nullable(),
        title: z.string().min(1),
        phone: z.string().optional().default(''),
        email: z.string().optional().default(''),
        lineId: z.string().optional().default(''),
        address: z.string().optional().default(''),
        status: z.enum(['active', 'inactive']).default('active'),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const result = await query(
      `INSERT INTO contact_us_settings (organization_id, market_id, title, phone, email, line_id, address, status)
       VALUES (:organizationId, :marketId, :title, :phone, :email, :lineId, :address, :status)`,
      {
        organizationId: req.auth.organizationId,
        marketId: body.marketId || null,
        title: body.title,
        phone: body.phone,
        email: body.email,
        lineId: body.lineId,
        address: body.address,
        status: body.status,
      },
    );
    return created(res, { id: result.insertId }, 'contact created');
  }),
);

router.get(
  '/tenant-types',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, name, status, created_at
       FROM tenant_types
       WHERE organization_id = :organizationId
         AND name IN ('บุคคลธรรมดา', 'นิติบุคคล')
       ORDER BY FIELD(name, 'บุคคลธรรมดา', 'นิติบุคคล')`,
      { organizationId: req.auth.organizationId },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/tenant-types',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  validate(
    z.object({
      body: z.object({ name: z.enum(['บุคคลธรรมดา', 'นิติบุคคล']), status: z.enum(['active', 'inactive']).default('active') }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const existing = await query(
      `SELECT id
       FROM tenant_types
       WHERE organization_id = :organizationId AND name = :name
       LIMIT 1`,
      { organizationId: req.auth.organizationId, name: req.validated.body.name },
    );

    if (existing[0]) {
      await query(
        `UPDATE tenant_types
         SET status = :status
         WHERE id = :id AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, id: existing[0].id, status: req.validated.body.status },
      );
      return ok(res, { id: existing[0].id }, 'tenant type updated');
    }

    const result = await query(
      `INSERT INTO tenant_types (organization_id, name, status)
       VALUES (:organizationId, :name, :status)`,
      { organizationId: req.auth.organizationId, ...req.validated.body },
    );
    return created(res, { id: result.insertId }, 'tenant type created');
  }),
);

router.get(
  '/tenants',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT mu.id, mu.public_id, mu.username_enc, mu.tenant_type_id, tt.name AS tenant_type_name,
              mu.first_name_enc, mu.last_name_enc, mu.phone_enc, mu.email_enc, mu.id_card_enc, mu.address_enc,
              mu.status, mu.accepted_consent_at, mu.created_at
       FROM mobile_users mu
       LEFT JOIN tenant_types tt ON tt.id = mu.tenant_type_id AND tt.organization_id = mu.organization_id
       WHERE mu.organization_id = :organizationId
       ORDER BY mu.created_at DESC
       LIMIT 500`,
      { organizationId: req.auth.organizationId },
    );
    return ok(
      res,
      rows.map((row) => ({
        id: row.id,
        public_id: row.public_id,
        username: decryptField(row.username_enc),
        tenant_type_id: row.tenant_type_id,
        tenant_type_name: row.tenant_type_name,
        name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim(),
        phone: decryptField(row.phone_enc),
        email: decryptField(row.email_enc),
        id_card: decryptField(row.id_card_enc),
        address: decryptField(row.address_enc),
        status: row.status,
        accepted_consent_at: row.accepted_consent_at,
        created_at: row.created_at,
      })),
    );
  }),
);

router.post(
  '/tenants',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  validate(
    z.object({
      body: z.object({
        username: z.string().min(4).max(60),
        password: z.string().min(10).refine(assertPasswordPolicy, PASSWORD_POLICY_MESSAGE),
        tenantTypeId: z.coerce.number().int().positive(),
        name: z.string().min(1).max(255),
        phone: z.string().min(8).max(20),
        email: z.email(),
        idCard: z.string().min(13).max(20),
        address: z.string().min(5).max(1000),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const result = await query(
      `INSERT INTO mobile_users (
        organization_id, tenant_type_id, public_id, username_enc, username_hash, password_hash,
        first_name_enc, last_name_enc, phone_enc, phone_hash, email_enc, email_hash,
        id_card_enc, id_card_hash, address_enc, status
      ) VALUES (
        :organizationId, :tenantTypeId, :publicId, :usernameEnc, :usernameHash, :passwordHash,
        :firstNameEnc, :lastNameEnc, :phoneEnc, :phoneHash, :emailEnc, :emailHash,
        :idCardEnc, :idCardHash, :addressEnc, 'active'
      )`,
      {
        organizationId: req.auth.organizationId,
        tenantTypeId: body.tenantTypeId,
        publicId: publicId('MB'),
        usernameEnc: encryptField(body.username),
        usernameHash: blindIndex(body.username),
        passwordHash: await bcrypt.hash(body.password, 10),
        firstNameEnc: encryptField(body.name),
        lastNameEnc: encryptField(''),
        phoneEnc: encryptField(body.phone),
        phoneHash: body.phone ? blindIndex(body.phone) : null,
        emailEnc: encryptField(body.email),
        emailHash: body.email ? blindIndex(body.email) : null,
        idCardEnc: encryptField(body.idCard),
        idCardHash: body.idCard ? blindIndex(body.idCard) : null,
        addressEnc: encryptField(body.address),
      },
    );
    return created(res, { id: result.insertId }, 'tenant created');
  }),
);

router.patch(
  '/tenants/:tenantId',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  validate(
    z.object({
      body: z.object({
        username: z.string().min(4).max(60),
        password: z.string().min(10).refine(assertPasswordPolicy, PASSWORD_POLICY_MESSAGE).optional().or(z.literal('')),
        tenantTypeId: z.coerce.number().int().positive(),
        name: z.string().min(1).max(255),
        phone: z.string().min(8).max(20),
        email: z.email(),
        idCard: z.string().min(13).max(20),
        address: z.string().min(5).max(1000),
        status: z.enum(['active', 'pending', 'suspended', 'deleted']).default('active'),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ tenantId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const tenantId = req.validated.params.tenantId;
    const passwordSql = body.password ? ', password_hash = :passwordHash' : '';
    const params = {
      organizationId: req.auth.organizationId,
      tenantId,
      tenantTypeId: body.tenantTypeId,
      usernameEnc: encryptField(body.username),
      usernameHash: blindIndex(body.username),
      firstNameEnc: encryptField(body.name),
      lastNameEnc: encryptField(''),
      phoneEnc: encryptField(body.phone),
      phoneHash: blindIndex(body.phone),
      emailEnc: encryptField(body.email),
      emailHash: blindIndex(body.email),
      idCardEnc: encryptField(body.idCard),
      idCardHash: blindIndex(body.idCard),
      addressEnc: encryptField(body.address),
      status: body.status,
    };
    if (body.password) params.passwordHash = await bcrypt.hash(body.password, 10);

    await query(
      `UPDATE mobile_users
       SET tenant_type_id = :tenantTypeId,
           username_enc = :usernameEnc,
           username_hash = :usernameHash,
           first_name_enc = :firstNameEnc,
           last_name_enc = :lastNameEnc,
           phone_enc = :phoneEnc,
           phone_hash = :phoneHash,
           email_enc = :emailEnc,
           email_hash = :emailHash,
           id_card_enc = :idCardEnc,
           id_card_hash = :idCardHash,
           address_enc = :addressEnc,
           status = :status
           ${passwordSql}
       WHERE id = :tenantId AND organization_id = :organizationId`,
      params,
    );
    return ok(res, { id: tenantId }, 'tenant updated');
  }),
);

router.patch(
  '/tenants/:tenantId/status',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  validate(
    z.object({
      body: z.object({ status: z.enum(['active', 'pending', 'suspended', 'deleted']) }),
      query: z.object({}).passthrough(),
      params: z.object({ tenantId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    await query(
      `UPDATE mobile_users
       SET status = :status
       WHERE id = :tenantId AND organization_id = :organizationId`,
      { organizationId: req.auth.organizationId, tenantId: req.validated.params.tenantId, status: req.validated.body.status },
    );
    return ok(res, { id: req.validated.params.tenantId, status: req.validated.body.status }, 'tenant status updated');
  }),
);

router.get(
  '/pdpa',
  requireRoles(ROLES.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, title, content, status, updated_at
       FROM pdpa_policies
       WHERE organization_id = :organizationId
       LIMIT 1`,
      { organizationId: req.auth.organizationId },
    );
    return ok(res, rows[0] || { title: 'PDPA Consent', content: '', status: 'active' });
  }),
);

router.put(
  '/pdpa',
  requireRoles(ROLES.SUPERVISOR),
  validate(
    z.object({
      body: z.object({
        title: z.string().min(1).default('PDPA Consent'),
        content: z.string().optional().default(''),
        status: z.enum(['active', 'inactive']).default('active'),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    await query(
      `INSERT INTO pdpa_policies (organization_id, title, content, status, updated_by_admin_id)
       VALUES (:organizationId, :title, :content, :status, :adminId)
       ON DUPLICATE KEY UPDATE
         title = VALUES(title),
         content = VALUES(content),
         status = VALUES(status),
         updated_by_admin_id = VALUES(updated_by_admin_id)`,
      { organizationId: req.auth.organizationId, title: body.title, content: body.content, status: body.status, adminId: req.auth.sub },
    );
    return ok(res, body, 'pdpa updated');
  }),
);

router.post(
  '/pdpa/assets',
  requireRoles(ROLES.SUPERVISOR),
  pdpaAssetUpload.single('image'),
  asyncHandler(async (req, res) => {
    if (!req.file) throw badRequest('Please upload an image');
    return created(
      res,
      {
        imageUrl: publicUploadUrl(req, req.file.path),
        fileName: req.file.filename,
      },
      'pdpa asset uploaded',
    );
  }),
);

router.get(
  '/markets',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT m.id, m.code, m.name, m.description, m.main_image_url, m.address, m.opening_hours, m.phone, m.line_id, m.email, m.terms,
              m.status, m.open_date, m.close_date, m.open_days_json
       FROM markets m
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE m.organization_id = :organizationId
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
       ORDER BY m.name`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
      },
    );
    return ok(res, rows.map((row) => ({
      ...row,
      open_days_json: normalizeOpenDays(row.open_days_json),
    })));
  }),
);

router.get(
  '/markets/next-code',
  requireRoles(ROLES.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const code = await buildNextMarketCode(req.auth.organizationId);
    return ok(res, { code });
  }),
);

router.patch(
  '/markets/:marketId',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  imageUpload.single('mainImage'),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        params: z.object({ marketId: z.coerce.number().int().positive() }),
        body: z.object({
          name: z.string().min(1).optional(),
          description: z.string().optional().default(''),
          address: z.string().optional().default(''),
          openingHours: z.string().optional().default(''),
          openDays: z.any().optional(),
          phone: z.string().optional().default(''),
          lineId: z.string().optional().default(''),
          email: z.string().optional().default(''),
          terms: z.string().optional().default(''),
        }),
      })
      .parse({ params: req.params, body: req.body });
    const body = parsed.body;
    const currentRows = await query(
      `SELECT main_image_url
       FROM markets
       WHERE id = :marketId AND organization_id = :organizationId
       LIMIT 1`,
      { organizationId: req.auth.organizationId, marketId: parsed.params.marketId },
    );
    const current = currentRows[0];
    if (!current) throw notFound('Market not found');
    const mainImageUrl = req.file ? publicUploadUrl(req, req.file.path) : current.main_image_url;
    const openDays = normalizeOpenDays(body.openDays);
    await query(
      `UPDATE markets
       SET name = COALESCE(:name, name),
           description = :description,
           main_image_url = :mainImageUrl,
           address = :address,
           opening_hours = :openingHours,
           open_days_json = :openDaysJson,
           phone = :phone,
           line_id = :lineId,
           email = :email,
           terms = :terms
       WHERE id = :marketId AND organization_id = :organizationId`,
      {
        organizationId: req.auth.organizationId,
        marketId: parsed.params.marketId,
        name: body.name || null,
        description: body.description,
        mainImageUrl,
        address: body.address,
        openingHours: body.openingHours,
        openDaysJson: JSON.stringify(openDays.length ? openDays : ALL_MARKET_OPEN_DAYS),
        phone: body.phone,
        lineId: body.lineId,
        email: body.email,
        terms: body.terms,
      },
    );
    if (req.file && current.main_image_url !== mainImageUrl) removeUploadedFile(current.main_image_url);
    clearPublicReadCache();
    return ok(res, { id: parsed.params.marketId, mainImageUrl }, 'market updated');
  }),
);

router.get(
  '/markets/:marketId/categories',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const marketId = Number(req.params.marketId);
    await ensureFixedProductCategories(req.auth.organizationId, marketId);
    const rows = await query(
      `SELECT id, name, status
       FROM product_categories
       WHERE organization_id = :organizationId
         AND market_id = :marketId
         AND name IN ('อาหาร', 'ไม่ใช่อาหาร')
       ORDER BY FIELD(name, 'อาหาร', 'ไม่ใช่อาหาร')`,
      { organizationId: req.auth.organizationId, marketId },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/markets/:marketId/categories',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({ name: z.enum(['อาหาร', 'ไม่ใช่อาหาร']), status: z.enum(['active', 'inactive']).default('active') }),
      query: z.object({}).passthrough(),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const existing = await query(
      `SELECT id
       FROM product_categories
       WHERE organization_id = :organizationId AND market_id = :marketId AND name = :name
       LIMIT 1`,
      { organizationId: req.auth.organizationId, marketId: req.validated.params.marketId, name: req.validated.body.name },
    );
    if (existing[0]) {
      await query(
        `UPDATE product_categories
         SET status = :status
         WHERE id = :id AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, id: existing[0].id, status: req.validated.body.status },
      );
      return ok(res, { id: existing[0].id }, 'category updated');
    }
    const result = await query(
      `INSERT INTO product_categories (organization_id, market_id, name, status)
       VALUES (:organizationId, :marketId, :name, :status)`,
      { organizationId: req.auth.organizationId, marketId: req.validated.params.marketId, ...req.validated.body },
    );
    return created(res, { id: result.insertId }, 'category created');
  }),
);

router.get(
  '/markets/:marketId/groups',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT g.id, g.name, g.category_id, c.name AS category_name, g.status
       FROM product_groups g
       LEFT JOIN product_categories c ON c.id = g.category_id
       WHERE g.organization_id = :organizationId AND (g.market_id = :marketId OR g.market_id IS NULL)
       ORDER BY g.name`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId) },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/markets/:marketId/groups',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({
        categoryId: z.coerce.number().int().positive(),
        name: z.string().min(1),
        status: z.enum(['active', 'inactive']).default('active'),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await query(
      `INSERT INTO product_groups (organization_id, market_id, category_id, name, status)
       VALUES (:organizationId, :marketId, :categoryId, :name, :status)`,
      {
        organizationId: req.auth.organizationId,
        marketId: req.validated.params.marketId,
        categoryId: req.validated.body.categoryId,
        name: req.validated.body.name,
        status: req.validated.body.status,
      },
    );
    return created(res, { id: result.insertId }, 'group created');
  }),
);

router.get(
  '/markets/:marketId/booth-types',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT fp.id, fp.name, fp.plan_image_url, fp.start_date, fp.end_date, fp.status,
              COUNT(b.id) AS booth_count
       FROM floor_plans fp
       LEFT JOIN booths b
         ON b.floor_plan_id = fp.id
        AND b.organization_id = fp.organization_id
        AND b.market_id = fp.market_id
       WHERE fp.organization_id = :organizationId AND fp.market_id = :marketId
       GROUP BY fp.id, fp.name, fp.plan_image_url, fp.start_date, fp.end_date, fp.status
       ORDER BY fp.start_date DESC, fp.id DESC`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId) },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/markets/:marketId/booth-types',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  imageUpload.single('planImage'),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        params: z.object({ marketId: z.coerce.number().int().positive() }),
        body: z.object({
          name: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          boothCount: z.coerce.number().int().min(1).default(1),
          categoryId: z.coerce.number().int().positive().optional().nullable(),
          status: z.enum(['active', 'inactive']).default('active'),
        }),
      })
      .parse({ params: req.params, body: req.body });
    const body = parsed.body;
    const planImageUrl = req.file ? publicUploadUrl(req, req.file.path) : null;
    await ensureFixedProductCategories(req.auth.organizationId, parsed.params.marketId);
    let categoryId = body.categoryId || null;
    if (categoryId) {
      const categoryRows = await query(
        `SELECT id
         FROM product_categories
         WHERE id = :categoryId
           AND organization_id = :organizationId
           AND market_id = :marketId
         LIMIT 1`,
        {
          categoryId,
          organizationId: req.auth.organizationId,
          marketId: parsed.params.marketId,
        },
      );
      if (!categoryRows[0]) throw badRequest('Category not found for this market');
    }
    const generatedBoothStatus = body.status === 'active' ? 'active' : 'inactive';
    if (generatedBoothStatus === 'active') {
      await assertPlanQuota(req.auth.organizationId, 'booth_management', body.boothCount);
    }
    const result = await transaction(async (connection) => {
      const [insertResult] = await connection.execute(
        `INSERT INTO floor_plans (organization_id, market_id, name, plan_image_url, start_date, end_date, status)
         VALUES (:organizationId, :marketId, :name, :planImageUrl, :startDate, :endDate, :status)`,
        { organizationId: req.auth.organizationId, marketId: parsed.params.marketId, planImageUrl, ...body },
      );
      const floorPlanId = insertResult.insertId;
      const [existingBoothRows] = await connection.execute(
        `SELECT code
         FROM booths
         WHERE organization_id = :organizationId AND market_id = :marketId`,
        { organizationId: req.auth.organizationId, marketId: parsed.params.marketId },
      );
      const boothCodes = nextSequenceCodes(existingBoothRows, 'code', 'B', body.boothCount);
      for (const [index, code] of boothCodes.entries()) {
        await connection.execute(
          `INSERT INTO booths (
            organization_id, market_id, floor_plan_id, category_id, code, name, price, sort_order, status
          ) VALUES (
            :organizationId, :marketId, :floorPlanId, :categoryId, :code, :name, :price, :sortOrder, :status
          )`,
          {
            organizationId: req.auth.organizationId,
            marketId: parsed.params.marketId,
            floorPlanId,
            categoryId,
            code,
            name: code,
            price: 0,
            sortOrder: index + 1,
            status: generatedBoothStatus,
          },
        );
      }
      return { id: floorPlanId, planImageUrl, boothCount: boothCodes.length };
    });
    clearPublicReadCache();
    return created(res, result, 'booth type created');
  }),
);

router.patch(
  '/markets/:marketId/booth-types/:boothTypeId',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  imageUpload.single('planImage'),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        params: z.object({
          marketId: z.coerce.number().int().positive(),
          boothTypeId: z.coerce.number().int().positive(),
        }),
        body: z.object({
          name: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          status: z.enum(['active', 'inactive']).default('active'),
        }),
      })
      .parse({ params: req.params, body: req.body });

    const rows = await query(
      `SELECT plan_image_url
       FROM floor_plans
       WHERE id = :boothTypeId AND organization_id = :organizationId AND market_id = :marketId
       LIMIT 1`,
      {
        organizationId: req.auth.organizationId,
        marketId: parsed.params.marketId,
        boothTypeId: parsed.params.boothTypeId,
      },
    );
    const current = rows[0];
    if (!current) throw notFound('Booth type not found');

    const planImageUrl = req.file ? publicUploadUrl(req, req.file.path) : current.plan_image_url;
    await query(
      `UPDATE floor_plans
       SET name = :name,
           plan_image_url = :planImageUrl,
           start_date = :startDate,
           end_date = :endDate,
           status = :status
       WHERE id = :boothTypeId AND organization_id = :organizationId AND market_id = :marketId`,
      {
        organizationId: req.auth.organizationId,
        marketId: parsed.params.marketId,
        boothTypeId: parsed.params.boothTypeId,
        planImageUrl,
        ...parsed.body,
      },
    );
    if (req.file && current.plan_image_url !== planImageUrl) removeUploadedFile(current.plan_image_url);
    clearPublicReadCache();
    return ok(res, { id: parsed.params.boothTypeId, planImageUrl }, 'booth type updated');
  }),
);

router.post(
  '/markets/:marketId/booth-types/copy',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  imageUpload.single('planImage'),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        params: z.object({ marketId: z.coerce.number().int().positive() }),
        body: z.object({
          sourceBoothTypeId: z.coerce.number().int().positive(),
          name: z.string().min(1),
          startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
          status: z.enum(['active', 'inactive']).default('active'),
        }),
      })
      .parse({ params: req.params, body: req.body });

    const sourceRows = await query(
      `SELECT id, plan_image_url
       FROM floor_plans
       WHERE id = :sourceBoothTypeId
         AND organization_id = :organizationId
         AND market_id = :marketId
       LIMIT 1`,
      {
        organizationId: req.auth.organizationId,
        marketId: parsed.params.marketId,
        sourceBoothTypeId: parsed.body.sourceBoothTypeId,
      },
    );
    const source = sourceRows[0];
    if (!source) throw notFound('Source booth type not found');

    const result = await transaction(async (connection) => {
      const planImageUrl = req.file ? publicUploadUrl(req, req.file.path) : source.plan_image_url;
      const [insertResult] = await connection.execute(
        `INSERT INTO floor_plans (organization_id, market_id, name, plan_image_url, start_date, end_date, status)
         VALUES (:organizationId, :marketId, :name, :planImageUrl, :startDate, :endDate, :status)`,
        {
          organizationId: req.auth.organizationId,
          marketId: parsed.params.marketId,
          name: parsed.body.name,
          planImageUrl,
          startDate: parsed.body.startDate,
          endDate: parsed.body.endDate,
          status: parsed.body.status,
        },
      );
      const newFloorPlanId = insertResult.insertId;

      const [sourceBooths] = await connection.execute(
        `SELECT category_id, code, name, price, x, y, width, height, sort_order, status
         FROM booths
         WHERE organization_id = :organizationId
           AND market_id = :marketId
           AND floor_plan_id = :sourceBoothTypeId
         ORDER BY sort_order, id`,
        {
          organizationId: req.auth.organizationId,
          marketId: parsed.params.marketId,
          sourceBoothTypeId: parsed.body.sourceBoothTypeId,
        },
      );
      const copiedActiveBooths = sourceBooths.filter((booth) => booth.status === 'active').length;
      if (copiedActiveBooths > 0) {
        await assertPlanQuota(req.auth.organizationId, 'booth_management', copiedActiveBooths);
      }

      for (const booth of sourceBooths) {
        await connection.execute(
          `INSERT INTO booths (
            organization_id, market_id, floor_plan_id, category_id, code, name, price, x, y, width, height, sort_order, status
          ) VALUES (
            :organizationId, :marketId, :floorPlanId, :categoryId, :code, :name, :price, :x, :y, :width, :height, :sortOrder, :status
          )`,
          {
            organizationId: req.auth.organizationId,
            marketId: parsed.params.marketId,
            floorPlanId: newFloorPlanId,
            categoryId: booth.category_id,
            code: copiedBoothCode(booth.code, newFloorPlanId),
            name: booth.name,
            price: booth.price,
            x: booth.x,
            y: booth.y,
            width: booth.width,
            height: booth.height,
            sortOrder: booth.sort_order,
            status: booth.status,
          },
        );
      }

      return { id: newFloorPlanId, planImageUrl, copiedBoothCount: sourceBooths.length };
    });

    clearPublicReadCache();
    return created(res, result, 'booth type copied');
  }),
);

router.get(
  '/markets/:marketId/booths',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT b.id, b.code, b.name, b.price, b.category_id, c.name AS category_name,
              b.floor_plan_id, fp.name AS floor_plan_name, b.x, b.y, b.width, b.height, b.sort_order, b.status
       FROM booths b
       LEFT JOIN product_categories c ON c.id = b.category_id
       LEFT JOIN floor_plans fp ON fp.id = b.floor_plan_id
       WHERE b.organization_id = :organizationId AND b.market_id = :marketId
       ORDER BY b.sort_order ASC, b.name ASC`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId) },
    );
    return ok(res, rows);
  }),
);

router.get(
  '/markets/:marketId/booths/next-code',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const marketId = Number(req.params.marketId);
    const code = await buildNextBoothCode(req.auth.organizationId, marketId);
    return ok(res, { code });
  }),
);

router.post(
  '/markets/:marketId/booths',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({
        floorPlanId: z.coerce.number().int().positive().optional().nullable(),
        categoryId: z.coerce.number().int().positive().optional().nullable(),
        code: z.string().optional().default(''),
        name: z.string().min(1),
        price: z.coerce.number().min(0),
        sortOrder: z.coerce.number().int().min(0).default(0),
        status: z.enum(['active', 'inactive', 'maintenance']).default('active'),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    if (body.status === 'active') {
      await assertPlanQuota(req.auth.organizationId, 'booth_management', 1);
    }
    const code = String(body.code || '').trim() || await buildNextBoothCode(req.auth.organizationId, req.validated.params.marketId);
    const result = await query(
      `INSERT INTO booths (organization_id, market_id, floor_plan_id, category_id, code, name, price, sort_order, status)
       VALUES (:organizationId, :marketId, :floorPlanId, :categoryId, :code, :name, :price, :sortOrder, :status)`,
      {
        organizationId: req.auth.organizationId,
        marketId: req.validated.params.marketId,
        floorPlanId: body.floorPlanId || null,
        categoryId: body.categoryId || null,
        code,
        name: body.name,
        price: body.price,
        sortOrder: body.sortOrder,
        status: body.status,
      },
    );
    clearPublicReadCache();
    return created(res, { id: result.insertId }, 'booth created');
  }),
);

router.patch(
  '/markets/:marketId/booths/:boothId',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({
        floorPlanId: z.coerce.number().int().positive().optional().nullable(),
        categoryId: z.coerce.number().int().positive().optional().nullable(),
        code: z.string().min(1),
        name: z.string().min(1),
        price: z.coerce.number().min(0),
        sortOrder: z.coerce.number().int().min(0).default(0),
        status: z.enum(['active', 'inactive', 'maintenance']).default('active'),
      }),
      query: z.object({}).passthrough(),
      params: z.object({
        marketId: z.coerce.number().int().positive(),
        boothId: z.coerce.number().int().positive(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { marketId, boothId } = req.validated.params;
    const body = req.validated.body;
    const currentRows = await query(
      `SELECT status
       FROM booths
       WHERE id = :boothId
         AND organization_id = :organizationId
         AND market_id = :marketId
       LIMIT 1`,
      {
        organizationId: req.auth.organizationId,
        marketId,
        boothId,
      },
    );
    if (!currentRows.length) throw notFound('Booth not found');
    if (body.status === 'active' && currentRows[0].status !== 'active') {
      await assertPlanQuota(req.auth.organizationId, 'booth_management', 1);
    }
    const result = await query(
      `UPDATE booths
       SET floor_plan_id = :floorPlanId,
           category_id = :categoryId,
           code = :code,
           name = :name,
           price = :price,
           sort_order = :sortOrder,
           status = :status
       WHERE id = :boothId AND organization_id = :organizationId AND market_id = :marketId`,
      {
        organizationId: req.auth.organizationId,
        marketId,
        boothId,
        floorPlanId: body.floorPlanId || null,
        categoryId: body.categoryId || null,
        code: String(body.code || '').trim(),
        name: body.name,
        price: body.price,
        sortOrder: body.sortOrder,
        status: body.status,
      },
    );
    if (!result.affectedRows) throw notFound('Booth not found');
    clearPublicReadCache();
    return ok(res, { id: boothId }, 'booth updated');
  }),
);

router.get(
  '/markets/:marketId/holidays',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, title, start_date, end_date, status
       FROM market_holidays
       WHERE organization_id = :organizationId AND market_id = :marketId
       ORDER BY start_date DESC, id DESC`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId) },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/markets/:marketId/holidays',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({
        title: z.string().min(1),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        status: z.enum(['active', 'inactive']).default('active'),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await query(
      `INSERT INTO market_holidays (organization_id, market_id, title, start_date, end_date, status)
       VALUES (:organizationId, :marketId, :title, :startDate, :endDate, :status)`,
      { organizationId: req.auth.organizationId, marketId: req.validated.params.marketId, ...req.validated.body },
    );
    return created(res, { id: result.insertId }, 'holiday created');
  }),
);

router.get(
  '/markets/:marketId/images',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, title, image_url, sort_order, status
       FROM market_images
       WHERE organization_id = :organizationId AND market_id = :marketId
       ORDER BY sort_order ASC, id DESC`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId) },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/markets/:marketId/images',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  imageUpload.array('images', 20),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        params: z.object({ marketId: z.coerce.number().int().positive() }),
        body: z.object({
          title: z.string().optional().default(''),
          imageUrl: z.string().url().optional(),
          sortOrder: z.coerce.number().int().min(0).default(0),
          status: z.enum(['active', 'inactive']).default('active'),
        }),
      })
      .parse({ params: req.params, body: req.body });
    const files = req.files || [];
    if (!files.length && !parsed.body.imageUrl) throw badRequest('Please upload at least one image');

    const records = files.length
      ? files.map((file, index) => ({
        title: files.length === 1 ? parsed.body.title : parsed.body.title || file.originalname,
        imageUrl: publicUploadUrl(req, file.path),
        sortOrder: parsed.body.sortOrder + index,
        status: parsed.body.status,
      }))
      : [{ title: parsed.body.title, imageUrl: parsed.body.imageUrl, sortOrder: parsed.body.sortOrder, status: parsed.body.status }];

    const inserted = await transaction(async (connection) => {
      const results = [];
      for (const record of records) {
        const [result] = await connection.execute(
          `INSERT INTO market_images (organization_id, market_id, title, image_url, sort_order, status)
           VALUES (:organizationId, :marketId, :title, :imageUrl, :sortOrder, :status)`,
          {
            organizationId: req.auth.organizationId,
            marketId: parsed.params.marketId,
            title: record.title,
            imageUrl: record.imageUrl,
            sortOrder: record.sortOrder,
            status: record.status,
          },
        );
        results.push({ id: result.insertId, ...record });
      }
      return results;
    });

    clearPublicReadCache();
    return created(res, inserted, 'images created');
  }),
);

router.patch(
  '/markets/:marketId/images/:imageId',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  imageUpload.single('image'),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        params: z.object({
          marketId: z.coerce.number().int().positive(),
          imageId: z.coerce.number().int().positive(),
        }),
        body: z.object({
          title: z.string().optional().default(''),
          sortOrder: z.coerce.number().int().min(0).default(0),
          status: z.enum(['active', 'inactive']).default('active'),
        }),
      })
      .parse({ params: req.params, body: req.body });

    const rows = await query(
      `SELECT id, image_url
       FROM market_images
       WHERE id = :imageId AND organization_id = :organizationId AND market_id = :marketId
       LIMIT 1`,
      {
        organizationId: req.auth.organizationId,
        marketId: parsed.params.marketId,
        imageId: parsed.params.imageId,
      },
    );
    const current = rows[0];
    if (!current) throw notFound('Market image not found');

    const imageUrl = req.file ? publicUploadUrl(req, req.file.path) : current.image_url;
    await query(
      `UPDATE market_images
       SET title = :title,
           image_url = :imageUrl,
           sort_order = :sortOrder,
           status = :status
       WHERE id = :imageId AND organization_id = :organizationId AND market_id = :marketId`,
      {
        organizationId: req.auth.organizationId,
        marketId: parsed.params.marketId,
        imageId: parsed.params.imageId,
        title: parsed.body.title,
        imageUrl,
        sortOrder: parsed.body.sortOrder,
        status: parsed.body.status,
      },
    );

    if (req.file && current.image_url !== imageUrl) removeUploadedFile(current.image_url);
    clearPublicReadCache();
    return ok(res, { id: parsed.params.imageId, title: parsed.body.title, imageUrl, sortOrder: parsed.body.sortOrder, status: parsed.body.status }, 'image updated');
  }),
);

router.get(
  '/markets/:marketId/accessories',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, name, image_url, price, stock_quantity AS quantity, status
       FROM accessories
       WHERE organization_id = :organizationId AND market_id = :marketId
       ORDER BY name`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId) },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/markets/:marketId/accessories',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  imageUpload.single('image'),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        params: z.object({ marketId: z.coerce.number().int().positive() }),
        body: z.object({
          name: z.string().min(1),
          price: z.coerce.number().min(0),
          quantity: z.coerce.number().int().min(0).default(0),
          status: z.enum(['active', 'inactive']).default('active'),
        }),
      })
      .parse({ params: req.params, body: req.body });
    const body = parsed.body;
    const imageUrl = req.file ? publicUploadUrl(req, req.file.path) : null;
    const result = await query(
      `INSERT INTO accessories (organization_id, market_id, name, image_url, price, stock_quantity, status)
       VALUES (:organizationId, :marketId, :name, :imageUrl, :price, :quantity, :status)`,
      { organizationId: req.auth.organizationId, marketId: parsed.params.marketId, imageUrl, ...body },
    );
    clearPublicReadCache();
    return created(res, { id: result.insertId, imageUrl }, 'accessory created');
  }),
);

router.post(
  '/markets',
  requireRoles(ROLES.SUPERVISOR),
  imageUpload.single('mainImage'),
  asyncHandler(async (req, res) => {
    const parsed = z
      .object({
        body: z.object({
          code: z.string().optional().default(''),
          name: z.string().min(1),
          description: z.string().optional().default(''),
          openDays: z.any().optional(),
        }),
      })
      .parse({ body: req.body });
    const body = parsed.body;
    const code = String(body.code || '').trim() || await buildNextMarketCode(req.auth.organizationId);
    const mainImageUrl = req.file ? publicUploadUrl(req, req.file.path) : null;
    await assertPlanQuota(req.auth.organizationId, 'market_management', 1);
    const openDays = normalizeOpenDays(body.openDays);
    const result = await query(
      `INSERT INTO markets (organization_id, code, name, description, main_image_url, open_date, close_date, open_days_json, status)
       VALUES (:organizationId, :code, :name, :description, :mainImageUrl, :openDate, :closeDate, :openDaysJson, 'active')`,
      {
        organizationId: req.auth.organizationId,
        code,
        name: body.name,
        description: body.description,
        mainImageUrl,
        openDate: null,
        closeDate: null,
        openDaysJson: JSON.stringify(openDays.length ? openDays : ALL_MARKET_OPEN_DAYS),
      },
    );
    clearPublicReadCache();
    return created(res, { id: result.insertId, mainImageUrl, code }, 'market created');
  }),
);

router.get(
  '/markets/:marketId/bookings',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT b.id, b.public_id, b.status, b.subtotal_amount, b.discount_amount, b.vat_amount, b.total_amount, b.source, b.created_at,
              COUNT(bi.id) AS item_count,
              GROUP_CONCAT(DISTINCT DATE_FORMAT(bi.booking_date, '%Y-%m-%d') ORDER BY bi.booking_date SEPARATOR ', ') AS booking_dates,
              GROUP_CONCAT(DISTINCT CONCAT(COALESCE(bo.code, ''), CASE WHEN bo.name IS NULL OR bo.name = '' THEN '' ELSE CONCAT(' ', bo.name) END) ORDER BY bo.sort_order, bo.code SEPARATOR ', ') AS booths
       FROM bookings b
       LEFT JOIN booking_items bi ON bi.booking_id = b.id
       LEFT JOIN booths bo ON bo.id = bi.booth_id
       WHERE b.organization_id = :organizationId AND b.market_id = :marketId
         AND b.source = 'management'
         AND b.created_by_admin_id = :adminUserId
       GROUP BY b.id
       ORDER BY b.created_at DESC
       LIMIT 500`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId), adminUserId: req.auth.sub },
    );
    return ok(res, rows);
  }),
);

router.get(
  '/markets/:marketId/bookings/booth-availability',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        productId: z.coerce.number().int().positive(),
        floorPlanId: z.coerce.number().int().positive().optional(),
        excludeBookingItemId: z.coerce.number().int().positive().optional(),
      }),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const { marketId } = req.validated.params;
    const { bookingDate, productId, floorPlanId, excludeBookingItemId } = req.validated.query;
    const productRows = await query(
      `SELECT id, category_id
       FROM products
       WHERE id = :productId
         AND organization_id = :organizationId
         AND market_id = :marketId
         AND status = 'active'
       LIMIT 1`,
      { organizationId: req.auth.organizationId, marketId, productId },
    );
    const product = productRows[0];
    if (!product) throw notFound('Product not found');

    const rows = await query(
      `SELECT b.id, b.code, b.name, b.price, b.category_id, c.name AS category_name,
              b.floor_plan_id, fp.name AS floor_plan_name, b.sort_order, b.status,
              CASE
                WHEN booking_state.availability_rank = 2 THEN 'booked'
                WHEN booking_state.availability_rank = 1 THEN 'processing'
                ELSE 'available'
              END AS availability_status,
              booking_state.booking_public_id
       FROM booths b
       LEFT JOIN product_categories c ON c.id = b.category_id
       LEFT JOIN floor_plans fp ON fp.id = b.floor_plan_id
       LEFT JOIN (
         SELECT bdl.booth_id,
                MAX(CASE
                  WHEN bdl.status = 'paid' THEN 2
                  WHEN bdl.status IN ('held', 'processing') THEN 1
                  ELSE 0
                END) AS availability_rank,
                MAX(b.public_id) AS booking_public_id
         FROM booth_date_locks bdl
         JOIN bookings b ON b.id = bdl.booking_id AND b.organization_id = bdl.organization_id
         WHERE bdl.organization_id = :organizationId
           AND bdl.market_id = :marketId
           AND bdl.booking_date = :bookingDate
           AND (:excludeBookingItemId IS NULL OR bdl.booking_item_id <> :excludeBookingItemId)
           AND bdl.status IN ('held', 'processing', 'paid')
         GROUP BY bdl.booth_id
       ) booking_state ON booking_state.booth_id = b.id
       WHERE b.organization_id = :organizationId
         AND b.market_id = :marketId
         AND b.status = 'active'
         AND b.category_id = :categoryId
         AND (:floorPlanId IS NULL OR b.floor_plan_id = :floorPlanId)
       ORDER BY b.sort_order ASC, b.code ASC, b.name ASC`,
      {
        organizationId: req.auth.organizationId,
        marketId,
        bookingDate,
        categoryId: product.category_id,
        floorPlanId: floorPlanId || null,
        excludeBookingItemId: excludeBookingItemId || null,
      },
    );
    const vatSettings = await getOrganizationVatSettings({ execute: query }, req.auth.organizationId);
    return ok(res, rows.map((row) => ({ ...row, gross_price: applyVatToAmount(row.price, vatSettings) })));
  }),
);

router.post(
  '/markets/:marketId/bookings',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({
        mobileUserId: z.coerce.number().int().positive(),
        items: z
          .array(
            z.object({
              boothId: z.coerce.number().int().positive(),
              bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
              productIds: z.array(z.coerce.number().int().positive()).default([]),
            }),
          )
          .min(1),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const marketId = req.validated.params.marketId;
    const { mobileUserId, items } = req.validated.body;
    await assertPlanQuota(req.auth.organizationId, 'booking_management', items.length);

    const result = await transaction(async (conn) => {
      return createManagementBooking(conn, {
        organizationId: req.auth.organizationId,
        marketId,
        mobileUserId,
        items,
        adminUserId: req.auth.sub,
        notify: true,
      });
    });
    if (result.notificationId) {
      sendMobilePushNotification(result.notificationId).catch(() => undefined);
    }

    return created(res, result, 'management booking created');
  }),
);

router.post(
  '/markets/:marketId/bookings/import',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  bookingImportUpload.single('file'),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({}).passthrough(),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    if (!req.file?.buffer) throw badRequest('Excel file is required');
    const marketId = req.validated.params.marketId;
    const rows = await bookingImportRowsFromWorkbook(req.file);
    if (!rows.length) throw badRequest('Excel file has no booking rows');
    if (rows.length > 500) throw badRequest('Import supports up to 500 rows per file');
    await assertPlanQuota(req.auth.organizationId, 'booking_management', rows.length);

    const groups = new Map();
    for (const row of rows) {
      if (!row.customerIdentifier) throw badRequest(`Row ${row.rowNumber}: customer_identifier is required`);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(row.bookingDate)) throw badRequest(`Row ${row.rowNumber}: booking_date must be YYYY-MM-DD`);
      if (!row.boothCode) throw badRequest(`Row ${row.rowNumber}: booth_code is required`);
      if (!row.productName) throw badRequest(`Row ${row.rowNumber}: product_name is required`);
      const key = row.customerIdentifier.toLowerCase();
      if (!groups.has(key)) groups.set(key, []);
      groups.get(key).push(row);
    }

    const successes = [];
    const errors = [];
    for (const groupRows of groups.values()) {
      try {
        const result = await transaction(async (conn) => {
          const user = await resolveImportMobileUser(conn, req.auth.organizationId, groupRows[0].customerIdentifier);
          if (!user) throw notFound(`Customer not found: ${groupRows[0].customerIdentifier}`);

          const items = [];
          for (const row of groupRows) {
            const booth = await resolveImportBooth(conn, req.auth.organizationId, marketId, row.boothCode);
            if (!booth) throw notFound(`Row ${row.rowNumber}: Booth ${row.boothCode} not found`);
            if (booth.floor_plan_status && booth.floor_plan_status !== 'active') {
              throw badRequest(`Row ${row.rowNumber}: Booth ${row.boothCode} floor plan is inactive`);
            }
            const startDate = dateOnly(booth.floor_plan_start_date);
            const endDate = dateOnly(booth.floor_plan_end_date);
            if ((startDate && row.bookingDate < startDate) || (endDate && row.bookingDate > endDate)) {
              throw badRequest(`Row ${row.rowNumber}: booking date is outside booth floor plan date range`);
            }

            const product = await resolveImportProduct(conn, req.auth.organizationId, marketId, row.productName);
            if (!product) throw notFound(`Row ${row.rowNumber}: Product ${row.productName} not found`);
            if (Number(product.category_id || 0) !== Number(booth.category_id || 0)) {
              throw badRequest(`Row ${row.rowNumber}: Product category does not match Booth category`);
            }

            items.push({
              boothId: booth.id,
              bookingDate: row.bookingDate,
              productIds: [product.id],
            });
          }

          const booking = await createManagementBooking(conn, {
            organizationId: req.auth.organizationId,
            marketId,
            mobileUserId: user.id,
            items,
            adminUserId: req.auth.sub,
            notify: true,
          });
          return {
            customerIdentifier: groupRows[0].customerIdentifier,
            mobileUserId: user.id,
            rowNumbers: groupRows.map((row) => row.rowNumber),
            itemCount: items.length,
            ...booking,
          };
        });
        if (result.notificationId) {
          sendMobilePushNotification(result.notificationId).catch(() => undefined);
        }
        successes.push(result);
      } catch (error) {
        for (const row of groupRows) {
          errors.push({
            rowNumber: row.rowNumber,
            customerIdentifier: row.customerIdentifier,
            message: error.message || 'Import failed',
          });
        }
      }
    }

    return created(
      res,
      {
        totalRows: rows.length,
        totalGroups: groups.size,
        successCount: successes.length,
        errorCount: errors.length,
        successes,
        errors,
      },
      'booking import completed',
    );
  }),
);

router.get(
  '/markets/:marketId/booking-items',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const marketId = req.validated.params.marketId;
    const bookingDate = req.validated.query.bookingDate || new Date().toISOString().slice(0, 10);
    const rows = await query(
      `SELECT bi.id, bi.booking_id, bi.booth_id, bi.booking_date, bi.unit_price, bi.status AS item_status,
              b.public_id AS booking_public_id, b.status AS booking_status, b.total_amount, b.created_at,
              b.mobile_user_id, b.comment,
              mu.public_id AS mobile_public_id, mu.username_enc, mu.first_name_enc, mu.last_name_enc, mu.phone_enc,
              bo.code AS booth_code, bo.name AS booth_name, bo.category_id,
              bp.product_id, p.name AS product_name
       FROM booking_items bi
       JOIN bookings b ON b.id = bi.booking_id
       JOIN booths bo ON bo.id = bi.booth_id
       JOIN mobile_users mu ON mu.id = b.mobile_user_id
       LEFT JOIN booking_products bp ON bp.booking_item_id = bi.id
       LEFT JOIN products p ON p.id = bp.product_id
       WHERE bi.organization_id = :organizationId
         AND b.organization_id = :organizationId
         AND b.market_id = :marketId
         AND bi.booking_date = :bookingDate
         AND b.status = 'paid'
         AND bi.status = 'paid'
       ORDER BY b.created_at DESC, bi.id DESC
       LIMIT 500`,
      { organizationId: req.auth.organizationId, marketId, bookingDate },
    );
    return ok(
      res,
      rows.map((row) => ({
        ...row,
        username: decryptField(row.username_enc),
        mobile_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim(),
        mobile_phone: decryptField(row.phone_enc),
        username_enc: undefined,
        first_name_enc: undefined,
        last_name_enc: undefined,
        phone_enc: undefined,
      })),
    );
  }),
);

router.patch(
  '/markets/:marketId/booking-items/:bookingItemId',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({
        bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
        boothId: z.coerce.number().int().positive(),
      }),
      query: z.object({}).passthrough(),
      params: z.object({
        marketId: z.coerce.number().int().positive(),
        bookingItemId: z.coerce.number().int().positive(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { marketId, bookingItemId } = req.validated.params;
    const { bookingDate, boothId } = req.validated.body;
    const result = await transaction(async (conn) => {
      await expireStaleBookings(conn, req.auth.organizationId);
      const [items] = await conn.execute(
        `SELECT bi.id, bi.booking_id, bi.booth_id, bi.booking_date, bi.unit_price, bi.status, b.status AS booking_status
         FROM booking_items bi
         JOIN bookings b ON b.id = bi.booking_id
         WHERE bi.id = :bookingItemId
           AND bi.organization_id = :organizationId
           AND b.organization_id = :organizationId
           AND b.market_id = :marketId
           AND b.status = 'paid'
           AND bi.status = 'paid'
         LIMIT 1
         FOR UPDATE`,
        { organizationId: req.auth.organizationId, marketId, bookingItemId },
      );
      const item = items[0];
      if (!item) throw notFound('Booking item not found');

      const [booths] = await conn.execute(
        `SELECT id, floor_plan_id, price
         FROM booths
         WHERE id = :boothId
           AND organization_id = :organizationId
           AND market_id = :marketId
           AND status = 'active'
         LIMIT 1
         FOR UPDATE`,
        { organizationId: req.auth.organizationId, marketId, boothId },
      );
      const booth = booths[0];
      if (!booth) throw notFound('Booth not found');
      const vatSettings = await getOrganizationVatSettings(conn, req.auth.organizationId);
      const unitPrice = Number(booth.price || 0);

      await moveBookingItemLock(conn, {
        organizationId: req.auth.organizationId,
        marketId,
        floorPlanId: booth.floor_plan_id,
        bookingId: item.booking_id,
        bookingItemId,
        oldBoothId: item.booth_id,
        oldBookingDate: item.booking_date,
        newBoothId: boothId,
        newBookingDate: bookingDate,
        status: item.status,
      });

      await conn.execute(
        `UPDATE booking_items
         SET booth_id = :boothId,
             booking_date = :bookingDate,
             unit_price = :unitPrice
         WHERE id = :bookingItemId AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, bookingItemId, boothId, bookingDate, unitPrice },
      );

      await conn.execute(
        `INSERT INTO booking_edit_logs (
          organization_id, market_id, booking_id, booking_item_id,
          old_booth_id, new_booth_id, old_booking_date, new_booking_date,
          old_unit_price, new_unit_price, edited_by_admin_id
        ) VALUES (
          :organizationId, :marketId, :bookingId, :bookingItemId,
          :oldBoothId, :newBoothId, :oldBookingDate, :newBookingDate,
          :oldUnitPrice, :newUnitPrice, :editedByAdminId
        )`,
        {
          organizationId: req.auth.organizationId,
          marketId,
          bookingId: item.booking_id,
          bookingItemId,
          oldBoothId: item.booth_id,
          newBoothId: boothId,
          oldBookingDate: item.booking_date,
          newBookingDate: bookingDate,
          oldUnitPrice: item.unit_price,
          newUnitPrice: unitPrice,
          editedByAdminId: req.auth.sub,
        },
      );

      const [totals] = await conn.execute(
        `SELECT COALESCE(SUM(bi.unit_price), 0) AS subtotal_amount,
                COALESCE(MAX(b.discount_amount), 0) AS discount_amount
         FROM booking_items bi
         JOIN bookings b ON b.id = bi.booking_id
         WHERE bi.booking_id = :bookingId
           AND bi.organization_id = :organizationId
           AND bi.status IN ('pending_payment', 'payment_processing', 'paid')`,
        { organizationId: req.auth.organizationId, bookingId: item.booking_id },
      );
      const recalculated = calculateVatBreakdown(totals[0]?.subtotal_amount || 0, totals[0]?.discount_amount || 0, vatSettings);
      await conn.execute(
        `UPDATE bookings
         SET subtotal_amount = :subtotalAmount,
             discount_amount = :discountAmount,
             vat_amount = :vatAmount,
             total_amount = :totalAmount
         WHERE id = :bookingId AND organization_id = :organizationId`,
        {
          organizationId: req.auth.organizationId,
          bookingId: item.booking_id,
          subtotalAmount: recalculated.subtotalAmount,
          discountAmount: recalculated.discountAmount,
          vatAmount: recalculated.vatAmount,
          totalAmount: recalculated.totalAmount,
        },
      );

      return { id: bookingItemId, bookingId: item.booking_id, ...recalculated };
    });
    return ok(res, result, 'booking item updated');
  }),
);

router.get(
  '/markets/:marketId/booking-edit-logs',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        limit: z.coerce.number().int().positive().max(500).optional().default(100),
        offset: z.coerce.number().int().min(0).optional().default(0),
      }),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { marketId } = req.validated.params;
    const { limit, offset } = req.validated.query;
    const rows = await query(
      `SELECT bel.id, bel.booking_id, bel.booking_item_id,
              bel.old_booth_id, old_booth.code AS old_booth_code, old_booth.name AS old_booth_name,
              bel.new_booth_id, new_booth.code AS new_booth_code, new_booth.name AS new_booth_name,
              bel.old_booking_date, bel.new_booking_date, bel.old_unit_price, bel.new_unit_price,
              bel.created_at, b.public_id AS booking_public_id,
              mu.public_id AS mobile_public_id, mu.username_enc, mu.first_name_enc, mu.last_name_enc, mu.phone_enc,
              au.name_enc AS edited_by_name_enc
       FROM booking_edit_logs bel
       JOIN bookings b ON b.id = bel.booking_id
       JOIN mobile_users mu ON mu.id = b.mobile_user_id
       JOIN booths old_booth ON old_booth.id = bel.old_booth_id
       JOIN booths new_booth ON new_booth.id = bel.new_booth_id
       JOIN admin_users au ON au.id = bel.edited_by_admin_id
       WHERE bel.organization_id = :organizationId
         AND bel.market_id = :marketId
       ORDER BY bel.created_at DESC, bel.id DESC
       LIMIT :limit OFFSET :offset`,
      { organizationId: req.auth.organizationId, marketId, limit, offset },
    );
    return ok(
      res,
      rows.map((row) => ({
        ...row,
        username: decryptField(row.username_enc),
        mobile_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim(),
        mobile_phone: decryptField(row.phone_enc),
        edited_by_name: decryptField(row.edited_by_name_enc),
        username_enc: undefined,
        first_name_enc: undefined,
        last_name_enc: undefined,
        phone_enc: undefined,
        edited_by_name_enc: undefined,
      })),
    );
  }),
);

router.patch(
  '/markets/:marketId/bookings/:bookingId/cancel',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({ comment: z.string().min(1).max(1000) }),
      query: z.object({}).passthrough(),
      params: z.object({
        marketId: z.coerce.number().int().positive(),
        bookingId: z.coerce.number().int().positive(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    throw badRequest('Booking cancellation is not supported. Delete pending_payment bookings or let unpaid bookings expire.');
  }),
);

router.delete(
  '/markets/:marketId/bookings/:bookingId',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({}).passthrough(),
      params: z.object({
        marketId: z.coerce.number().int().positive(),
        bookingId: z.coerce.number().int().positive(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { marketId, bookingId } = req.validated.params;
    const result = await transaction(async (conn) => {
      await expireStaleBookings(conn, req.auth.organizationId);
      const [bookings] = await conn.execute(
        `SELECT id, status
         FROM bookings
         WHERE id = :bookingId
           AND organization_id = :organizationId
           AND market_id = :marketId
           AND source = 'management'
           AND created_by_admin_id = :adminUserId
         LIMIT 1
         FOR UPDATE`,
        { organizationId: req.auth.organizationId, marketId, bookingId, adminUserId: req.auth.sub },
      );
      const booking = bookings[0];
      if (!booking) throw notFound('Booking not found');
      if (booking.status !== 'pending_payment') throw badRequest('Only pending_payment bookings can be deleted');

      const [items] = await conn.execute(
        `SELECT id
         FROM booking_items
         WHERE booking_id = :bookingId AND organization_id = :organizationId
         FOR UPDATE`,
        { organizationId: req.auth.organizationId, bookingId },
      );
      for (const item of items) {
        await conn.execute(
          `DELETE FROM booking_products
           WHERE organization_id = :organizationId AND booking_item_id = :bookingItemId`,
          { organizationId: req.auth.organizationId, bookingItemId: item.id },
        );
        await conn.execute(
          `DELETE FROM booking_accessories
           WHERE organization_id = :organizationId AND booking_item_id = :bookingItemId`,
          { organizationId: req.auth.organizationId, bookingItemId: item.id },
        );
      }
      await releaseBookingLocks(conn, { organizationId: req.auth.organizationId, bookingId });
      await conn.execute(
        `DELETE FROM booking_items
         WHERE booking_id = :bookingId AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, bookingId },
      );
      await conn.execute(
        `DELETE FROM payments
         WHERE booking_id = :bookingId AND organization_id = :organizationId AND status <> 'paid'`,
        { organizationId: req.auth.organizationId, bookingId },
      );
      await conn.execute(
        `DELETE FROM bookings
         WHERE id = :bookingId AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, bookingId },
      );
      return { id: bookingId };
    });
    return ok(res, result, 'booking deleted');
  }),
);

router.get(
  '/mobile-users',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, public_id, username_enc, first_name_enc, last_name_enc, phone_enc, email_enc, status, created_at
       FROM mobile_users
       WHERE organization_id = :organizationId
       ORDER BY created_at DESC
       LIMIT 500`,
      { organizationId: req.auth.organizationId },
    );
    const keyword = String(req.query.keyword || '').trim().toLowerCase();
    const mapped = rows.map((row) => {
      const firstName = decryptField(row.first_name_enc);
      const lastName = decryptField(row.last_name_enc);
      const name = [firstName, lastName].filter(Boolean).join(' ').trim();
      return {
        id: row.id,
        public_id: row.public_id,
        username: decryptField(row.username_enc),
        name,
        phone: decryptField(row.phone_enc),
        email: decryptField(row.email_enc),
        status: row.status,
        created_at: row.created_at,
      };
    });
    const filtered = keyword
      ? mapped.filter((row) => `${row.public_id} ${row.username} ${row.name} ${row.phone} ${row.email}`.toLowerCase().includes(keyword))
      : mapped;
    return ok(res, filtered.slice(0, 50));
  }),
);

router.get(
  '/markets/:marketId/products',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT p.id, p.name, p.category_id, p.group_id, p.status, c.name AS category_name, g.name AS group_name
       FROM products p
       LEFT JOIN product_categories c ON c.id = p.category_id
       LEFT JOIN product_groups g ON g.id = p.group_id
       WHERE p.organization_id = :organizationId AND p.market_id = :marketId
       ORDER BY p.name`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId) },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/markets/:marketId/products',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({
        categoryId: z.coerce.number().int().positive(),
        groupId: z.coerce.number().int().positive().optional().nullable(),
        name: z.string().min(1),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const result = await query(
      `INSERT INTO products (organization_id, market_id, category_id, group_id, name, status)
       VALUES (:organizationId, :marketId, :categoryId, :groupId, :name, 'active')`,
      {
        organizationId: req.auth.organizationId,
        marketId: req.validated.params.marketId,
        categoryId: body.categoryId,
        groupId: body.groupId || null,
        name: body.name,
      },
    );
    return created(res, { id: result.insertId }, 'product created');
  }),
);

router.get(
  '/markets/:marketId/coupons',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT id, code, name, discount_type, discount_value, starts_at, ends_at, status
       FROM coupons
       WHERE organization_id = :organizationId AND market_id = :marketId
       ORDER BY created_at DESC
       LIMIT 500`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId) },
    );
    return ok(res, rows);
  }),
);

router.post(
  '/markets/:marketId/coupons',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({
        name: z.string().min(1),
        code: z.string().min(3).optional(),
        discountType: z.enum(['amount', 'percent']).default('amount'),
        discountValue: z.coerce.number().positive(),
        usageLimit: z.coerce.number().int().positive().optional().nullable(),
        startsAt: z.string().min(1),
        endsAt: z.string().min(1),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const result = await query(
      `INSERT INTO coupons (
        organization_id, market_id, code, name, discount_type, discount_value,
        usage_limit, starts_at, ends_at, created_by_admin_id, status
      ) VALUES (
        :organizationId, :marketId, :code, :name, :discountType, :discountValue,
        :usageLimit, :startsAt, :endsAt, :createdByAdminId, 'active'
      )`,
      {
        organizationId: req.auth.organizationId,
        marketId: req.validated.params.marketId,
        code: body.code || publicId('CP'),
        name: body.name,
        discountType: body.discountType,
        discountValue: body.discountValue,
        usageLimit: body.usageLimit || null,
        startsAt: body.startsAt,
        endsAt: body.endsAt,
        createdByAdminId: req.auth.sub,
      },
    );
    return created(res, { id: result.insertId }, 'coupon created');
  }),
);

router.get(
  '/markets/:marketId/audit-checks',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { marketId } = req.validated.params;
    const startDate = req.validated.query.startDate || null;
    const endDate = req.validated.query.endDate || null;
    const rows = await query(
      `SELECT ac.id, ac.booking_item_id, ac.result, ac.fine_amount, ac.accessories_fine_amount,
              ac.damage_fine_amount, ac.vat_amount, ac.total_fine_amount, ac.fine_payment_status,
              ac.checked_at, b.public_id AS booking_public_id, m.name AS market_name,
              mu.username_enc, mu.first_name_enc, mu.last_name_enc,
              bo.code AS booth_code, bo.name AS booth_name,
              GROUP_CONCAT(DISTINCT p.name ORDER BY p.name SEPARATOR ', ') AS product_names,
              bi.booking_date
       FROM audit_checks ac
       JOIN booking_items bi ON bi.id = ac.booking_item_id
       JOIN bookings b ON b.id = bi.booking_id
       JOIN markets m ON m.id = ac.market_id
       JOIN mobile_users mu ON mu.id = b.mobile_user_id
       JOIN booths bo ON bo.id = bi.booth_id
       LEFT JOIN booking_products bp ON bp.booking_item_id = bi.id
       LEFT JOIN products p ON p.id = bp.product_id
       WHERE ac.organization_id = :organizationId
         AND ac.market_id = :marketId
         AND (:startDate IS NULL OR bi.booking_date >= :startDate)
         AND (:endDate IS NULL OR bi.booking_date <= :endDate)
       GROUP BY ac.id, ac.booking_item_id, ac.result, ac.fine_amount, ac.accessories_fine_amount,
                ac.damage_fine_amount, ac.vat_amount, ac.total_fine_amount, ac.fine_payment_status, ac.checked_at,
                b.public_id, m.name, mu.username_enc, mu.first_name_enc, mu.last_name_enc,
                bo.code, bo.name, bi.booking_date
       ORDER BY bi.booking_date DESC, ac.checked_at DESC
       LIMIT 500`,
      { organizationId: req.auth.organizationId, marketId, startDate, endDate },
    );
    return ok(
      res,
      rows.map((row) => ({
        ...row,
        customer_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim() || decryptField(row.username_enc) || '-',
        username_enc: undefined,
        first_name_enc: undefined,
        last_name_enc: undefined,
      })),
    );
  }),
);

router.get(
  '/markets/:marketId/audit-fines',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        paymentStatus: z.enum(['pending', 'waiting', 'paid']).optional(),
      }),
      params: z.object({ marketId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { marketId } = req.validated.params;
    const startDate = req.validated.query.startDate || null;
    const endDate = req.validated.query.endDate || null;
    const paymentStatus = req.validated.query.paymentStatus || 'pending';
    const rows = await query(
      `SELECT ac.id, ac.booking_item_id, ac.result, ac.fine_amount, ac.accessories_fine_amount,
              ac.damage_fine_amount, ac.vat_amount, ac.total_fine_amount, ac.fine_payment_status,
              ac.checked_at, b.public_id AS booking_public_id, m.name AS market_name,
              mu.username_enc, mu.first_name_enc, mu.last_name_enc,
              bo.code AS booth_code, bo.name AS booth_name,
              GROUP_CONCAT(DISTINCT p.name ORDER BY p.name SEPARATOR ', ') AS product_names,
              bi.booking_date
       FROM audit_checks ac
       JOIN booking_items bi ON bi.id = ac.booking_item_id
       JOIN bookings b ON b.id = bi.booking_id
       JOIN markets m ON m.id = ac.market_id
       JOIN mobile_users mu ON mu.id = b.mobile_user_id
       JOIN booths bo ON bo.id = bi.booth_id
       LEFT JOIN booking_products bp ON bp.booking_item_id = bi.id
       LEFT JOIN products p ON p.id = bp.product_id
       WHERE ac.organization_id = :organizationId
         AND ac.market_id = :marketId
         AND ac.total_fine_amount > 0
         AND (:startDate IS NULL OR bi.booking_date >= :startDate)
         AND (:endDate IS NULL OR bi.booking_date <= :endDate)
         AND (
           (:paymentStatus = 'pending' AND ac.fine_payment_status IN ('pending', 'waiting'))
           OR (:paymentStatus = 'paid' AND ac.fine_payment_status = 'paid')
           OR (:paymentStatus = 'waiting' AND ac.fine_payment_status = 'waiting')
         )
       GROUP BY ac.id, ac.booking_item_id, ac.result, ac.fine_amount, ac.accessories_fine_amount,
                ac.damage_fine_amount, ac.vat_amount, ac.total_fine_amount, ac.fine_payment_status, ac.checked_at,
                b.public_id, m.name, mu.username_enc, mu.first_name_enc, mu.last_name_enc,
                bo.code, bo.name, bi.booking_date
       ORDER BY bi.booking_date DESC, ac.checked_at DESC
       LIMIT 500`,
      { organizationId: req.auth.organizationId, marketId, startDate, endDate, paymentStatus },
    );
    return ok(
      res,
      rows.map((row) => ({
        ...row,
        customer_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim() || decryptField(row.username_enc) || '-',
        username_enc: undefined,
        first_name_enc: undefined,
        last_name_enc: undefined,
      })),
    );
  }),
);

router.patch(
  '/markets/:marketId/audit-checks/:auditCheckId/fine-payment-status',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  imageUpload.single('proofImage'),
  validate(
    z.object({
      body: z.object({
        finePaymentStatus: z.enum(['pending', 'waiting', 'paid', 'cancelled']),
      }),
      query: z.object({}).passthrough(),
      params: z.object({
        marketId: z.coerce.number().int().positive(),
        auditCheckId: z.coerce.number().int().positive(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    if (req.validated.body.finePaymentStatus === 'paid' && !req.file) {
      throw badRequest('Payment proof image is required');
    }
    const result = await transaction(async (conn) => {
      const [checks] = await conn.execute(
        `SELECT id
         FROM audit_checks
         WHERE id = :auditCheckId
           AND market_id = :marketId
           AND organization_id = :organizationId
         LIMIT 1
         FOR UPDATE`,
        {
          organizationId: req.auth.organizationId,
          marketId: req.validated.params.marketId,
          auditCheckId: req.validated.params.auditCheckId,
        },
      );
      if (!checks.length) throw notFound('Audit check not found');

      await conn.execute(
        `UPDATE audit_checks
         SET fine_payment_status = :finePaymentStatus
         WHERE id = :auditCheckId
           AND market_id = :marketId
           AND organization_id = :organizationId`,
        {
          organizationId: req.auth.organizationId,
          marketId: req.validated.params.marketId,
          auditCheckId: req.validated.params.auditCheckId,
          finePaymentStatus: req.validated.body.finePaymentStatus,
        },
      );

      if (req.file) {
        await conn.execute(
          `INSERT INTO audit_check_images (organization_id, audit_check_id, file_url, file_name, file_size)
           VALUES (:organizationId, :auditCheckId, :fileUrl, :fileName, :fileSize)`,
          {
            organizationId: req.auth.organizationId,
            auditCheckId: req.validated.params.auditCheckId,
            fileUrl: publicUploadUrl(req, req.file.path),
            fileName: req.file.originalname,
            fileSize: req.file.size,
          },
        );
      }

      return { id: req.validated.params.auditCheckId };
    });
    return ok(res, { id: req.validated.params.auditCheckId }, 'fine payment status updated');
  }),
);

router.get(
  '/payment-proofs',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      query: z.object({
        status: z.enum(['waiting', 'failed', 'paid', 'all']).optional().default('waiting'),
        marketId: z.coerce.number().int().positive().optional(),
      }).passthrough(),
      params: z.object({}).passthrough(),
      body: z.object({}).passthrough().optional().default({}),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { status, marketId } = req.validated.query;
    const rows = await query(
      `SELECT
          p.id, p.public_id, p.status, p.amount, p.provider_reference,
          p.proof_image_url, p.proof_uploaded_at, p.payer_note, p.paid_at,
          p.audit_check_id,
          COALESCE(b.id, ac_b.id) AS booking_id,
          COALESCE(b.public_id, ac_b.public_id) AS booking_public_id,
          CASE WHEN p.audit_check_id IS NOT NULL THEN 'audit_fine' ELSE 'booking' END AS payment_kind,
          b.status AS booking_status,
          b.expires_at, m.id AS market_id, m.name AS market_name,
          mu.username_enc, mu.first_name_enc, mu.last_name_enc, mu.email_enc
       FROM payments p
       LEFT JOIN bookings b
         ON b.id = p.booking_id
        AND b.organization_id = p.organization_id
       LEFT JOIN audit_checks ac
         ON ac.id = p.audit_check_id
        AND ac.organization_id = p.organization_id
       LEFT JOIN booking_items ac_bi
         ON ac_bi.id = ac.booking_item_id
        AND ac_bi.organization_id = ac.organization_id
       LEFT JOIN bookings ac_b
         ON ac_b.id = ac_bi.booking_id
        AND ac_b.organization_id = ac_bi.organization_id
       JOIN markets m
         ON m.id = COALESCE(b.market_id, ac.market_id)
        AND m.organization_id = p.organization_id
       LEFT JOIN mobile_users mu
         ON mu.id = COALESCE(b.mobile_user_id, ac_b.mobile_user_id)
        AND mu.organization_id = p.organization_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = m.id
        AND ama.admin_user_id = :adminUserId
        AND ama.status = 'active'
       WHERE p.organization_id = :organizationId
         AND p.provider = 'manual'
         AND p.proof_image_url IS NOT NULL
         AND (:status = 'all' OR p.status = :status)
         AND (:marketId IS NULL OR m.id = :marketId)
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
       ORDER BY COALESCE(p.proof_uploaded_at, p.created_at) DESC, p.id DESC
       LIMIT 300`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        status,
        marketId: marketId || null,
      },
    );

    return ok(res, rows.map((row) => ({
      ...row,
      customer_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim()
        || decryptField(row.username_enc)
        || decryptField(row.email_enc)
        || '-',
      username_enc: undefined,
      first_name_enc: undefined,
      last_name_enc: undefined,
      email_enc: undefined,
    })));
  }),
);

router.patch(
  '/payments/:paymentId/proof-status',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({
        status: z.enum(['paid', 'failed']),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ paymentId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await transaction(async (conn) => {
      await expireStaleBookings(conn, req.auth.organizationId);
      const [rows] = await conn.execute(
        `SELECT p.id, p.public_id, p.booking_id, p.audit_check_id, p.amount, p.status,
                b.status AS booking_status, b.expires_at,
                ac.fine_payment_status,
                COALESCE(b.market_id, ac.market_id) AS market_id,
                COALESCE(b.mobile_user_id, ac_b.mobile_user_id) AS mobile_user_id
         FROM payments p
         LEFT JOIN bookings b
           ON b.id = p.booking_id
          AND b.organization_id = p.organization_id
         LEFT JOIN audit_checks ac
           ON ac.id = p.audit_check_id
          AND ac.organization_id = p.organization_id
         LEFT JOIN booking_items ac_bi
           ON ac_bi.id = ac.booking_item_id
          AND ac_bi.organization_id = ac.organization_id
         LEFT JOIN bookings ac_b
           ON ac_b.id = ac_bi.booking_id
          AND ac_b.organization_id = ac_bi.organization_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = COALESCE(b.market_id, ac.market_id)
          AND ama.admin_user_id = :adminUserId
          AND ama.status = 'active'
         WHERE p.id = :paymentId
           AND p.organization_id = :organizationId
           AND p.provider = 'manual'
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         LIMIT 1
         FOR UPDATE`,
        {
          organizationId: req.auth.organizationId,
          paymentId: req.validated.params.paymentId,
          adminUserId: req.auth.sub,
          hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        },
      );
      const payment = rows[0];
      if (!payment) throw notFound('Payment proof not found');
      if (!['waiting', 'failed'].includes(payment.status)) throw badRequest('Payment proof is not reviewable');
      if (payment.audit_check_id && !['waiting', 'pending'].includes(payment.fine_payment_status)) {
        throw badRequest('Fine payment is not waiting for review');
      }
      if (!payment.audit_check_id && !['pending_payment', 'payment_processing'].includes(payment.booking_status)) {
        throw badRequest('Booking is not waiting for payment review');
      }

      if (req.validated.body.status === 'paid') {
        await conn.execute(
          `UPDATE payments
           SET status = 'paid',
               paid_at = NOW(),
               verified_by_admin_id = :adminUserId,
               verified_at = NOW()
          WHERE id = :paymentId
             AND organization_id = :organizationId`,
          { organizationId: req.auth.organizationId, paymentId: payment.id, adminUserId: req.auth.sub },
        );
        if (payment.audit_check_id) {
          await conn.execute(
            `UPDATE audit_checks
             SET fine_payment_status = 'paid'
             WHERE id = :auditCheckId
               AND organization_id = :organizationId`,
            { organizationId: req.auth.organizationId, auditCheckId: payment.audit_check_id },
          );
        } else {
          await conn.execute(
            `UPDATE bookings
             SET status = 'paid',
                 paid_at = NOW()
             WHERE id = :bookingId
               AND organization_id = :organizationId`,
            { organizationId: req.auth.organizationId, bookingId: payment.booking_id },
          );
          await conn.execute(
            `UPDATE booking_items
             SET status = 'paid'
             WHERE booking_id = :bookingId
               AND organization_id = :organizationId`,
            { organizationId: req.auth.organizationId, bookingId: payment.booking_id },
          );
          await updateBookingLocksStatus(conn, {
            organizationId: req.auth.organizationId,
            bookingId: payment.booking_id,
            status: 'paid',
          });
        }
      } else {
        await conn.execute(
          `UPDATE payments
           SET status = 'failed',
               verified_by_admin_id = :adminUserId,
               verified_at = NOW()
           WHERE id = :paymentId
             AND organization_id = :organizationId`,
          { organizationId: req.auth.organizationId, paymentId: payment.id, adminUserId: req.auth.sub },
        );
        if (payment.audit_check_id) {
          await conn.execute(
            `UPDATE audit_checks
             SET fine_payment_status = 'pending'
             WHERE id = :auditCheckId
               AND organization_id = :organizationId`,
            { organizationId: req.auth.organizationId, auditCheckId: payment.audit_check_id },
          );
        } else {
          await conn.execute(
            `UPDATE bookings
             SET status = 'pending_payment',
                 cart_visible = 1,
                 expires_at = DATE_ADD(NOW(), INTERVAL ${PAYMENT_EXPIRES_MINUTES} MINUTE)
             WHERE id = :bookingId
               AND organization_id = :organizationId`,
            { organizationId: req.auth.organizationId, bookingId: payment.booking_id },
          );
          await conn.execute(
            `UPDATE booking_items
             SET status = 'pending_payment'
             WHERE booking_id = :bookingId
               AND organization_id = :organizationId
               AND status = 'payment_processing'`,
            { organizationId: req.auth.organizationId, bookingId: payment.booking_id },
          );
          await updateBookingLocksStatus(conn, {
            organizationId: req.auth.organizationId,
            bookingId: payment.booking_id,
            status: 'pending_payment',
          });
          await conn.execute(
            `UPDATE booth_date_locks
             SET expires_at = DATE_ADD(NOW(), INTERVAL ${PAYMENT_EXPIRES_MINUTES} MINUTE)
             WHERE booking_id = :bookingId
               AND organization_id = :organizationId`,
            { organizationId: req.auth.organizationId, bookingId: payment.booking_id },
          );
        }
      }

      let notificationId = null;
      if (payment.mobile_user_id) {
        const paid = req.validated.body.status === 'paid';
        const [notification] = await conn.execute(
          `INSERT INTO mobile_notifications (
            organization_id, mobile_user_id, title, body, data_json, channel, status
          ) VALUES (
            :organizationId, :mobileUserId, :title, :body, :dataJson, 'in_app', 'unread'
          )`,
          {
            organizationId: req.auth.organizationId,
            mobileUserId: payment.mobile_user_id,
            title: paid ? 'ตรวจสอบการชำระเงินสำเร็จ' : 'หลักฐานการชำระเงินไม่ผ่าน',
            body: paid
              ? `รายการชำระเงิน ${payment.public_id} ได้รับการอนุมัติแล้ว`
              : `รายการชำระเงิน ${payment.public_id} ไม่ผ่านการตรวจสอบ กรุณาดำเนินการใหม่`,
            dataJson: JSON.stringify({
              type: paid ? 'payment_approved' : 'payment_rejected',
              paymentId: payment.id,
              bookingId: payment.booking_id,
              auditCheckId: payment.audit_check_id,
              marketId: payment.market_id,
            }),
          },
        );
        notificationId = notification.insertId;
      }

      return {
        id: payment.id,
        publicId: payment.public_id,
        bookingId: payment.booking_id,
        auditCheckId: payment.audit_check_id,
        status: req.validated.body.status,
        notificationId,
      };
    });
    if (result.notificationId) {
      sendMobilePushNotification(result.notificationId).catch(() => undefined);
    }

    return ok(res, result, 'payment proof reviewed');
  }),
);

router.get(
  '/dashboard/summary',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const today = bangkokDateString();
    const monthStart = `${today.slice(0, 7)}-01`;
    const scope = {
      organizationId: req.auth.organizationId,
      adminUserId: req.auth.sub,
      hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
      today,
      monthStart,
    };

    const [
      boothTotals,
      bookedTotals,
      dailyCustomers,
      bookingPaidTodayRows,
      finePaidTodayRows,
      paidThisMonthRows,
      pendingProofRows,
      bookingOutstandingRows,
      fineOutstandingRows,
    ] = await Promise.all([
      query(
        `SELECT COUNT(*) AS total
         FROM booths bo
         JOIN markets m ON m.id = bo.market_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE bo.organization_id = :organizationId
           AND bo.status = 'active'
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)`,
        scope,
      ),
      query(
        `SELECT COUNT(DISTINCT bi.booth_id) AS total
         FROM booking_items bi
         JOIN bookings b ON b.id = bi.booking_id
         JOIN markets m ON m.id = b.market_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE bi.organization_id = :organizationId
           AND b.organization_id = :organizationId
           AND bi.booking_date = :today
           AND bi.status IN ('pending_payment', 'payment_processing', 'paid')
           AND b.status IN ('pending_payment', 'payment_processing', 'paid')
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)`,
        scope,
      ),
      query(
        `SELECT COUNT(DISTINCT b.mobile_user_id) AS total
         FROM bookings b
         JOIN markets m ON m.id = b.market_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE b.organization_id = :organizationId
           AND DATE(b.created_at) = :today
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)`,
        scope,
      ),
      query(
        `SELECT COALESCE(SUM(p.amount), 0) AS total
         FROM payments p
         JOIN bookings b ON b.id = p.booking_id
         JOIN markets m ON m.id = b.market_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE p.organization_id = :organizationId
           AND p.status = 'paid'
           AND DATE(COALESCE(p.paid_at, p.created_at)) = :today
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)`,
        scope,
      ),
      query(
        `SELECT COALESCE(SUM(ac.total_fine_amount), 0) AS total
         FROM audit_checks ac
         JOIN markets m ON m.id = ac.market_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE ac.organization_id = :organizationId
           AND ac.fine_payment_status = 'paid'
           AND DATE(ac.updated_at) = :today
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)`,
        scope,
      ),
      query(
        `SELECT COALESCE(SUM(p.amount), 0) AS total
         FROM payments p
         LEFT JOIN bookings b ON b.id = p.booking_id AND b.organization_id = p.organization_id
         LEFT JOIN audit_checks ac ON ac.id = p.audit_check_id AND ac.organization_id = p.organization_id
         JOIN markets m ON m.id = COALESCE(b.market_id, ac.market_id) AND m.organization_id = p.organization_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE p.organization_id = :organizationId
           AND p.status = 'paid'
           AND DATE(COALESCE(p.paid_at, p.created_at)) BETWEEN :monthStart AND :today
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)`,
        scope,
      ),
      query(
        `SELECT COUNT(*) AS total
         FROM payments p
         LEFT JOIN bookings b ON b.id = p.booking_id AND b.organization_id = p.organization_id
         LEFT JOIN audit_checks ac ON ac.id = p.audit_check_id AND ac.organization_id = p.organization_id
         JOIN markets m ON m.id = COALESCE(b.market_id, ac.market_id) AND m.organization_id = p.organization_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE p.organization_id = :organizationId
           AND p.provider = 'manual'
           AND p.status = 'waiting'
           AND p.proof_image_url IS NOT NULL
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)`,
        scope,
      ),
      query(
        `SELECT COALESCE(SUM(b.total_amount), 0) AS total
         FROM bookings b
         JOIN markets m ON m.id = b.market_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE b.organization_id = :organizationId
           AND b.status IN ('pending_payment', 'payment_processing')
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)`,
        scope,
      ),
      query(
        `SELECT COALESCE(SUM(ac.total_fine_amount), 0) AS total
         FROM audit_checks ac
         JOIN markets m ON m.id = ac.market_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE ac.organization_id = :organizationId
           AND ac.fine_payment_status IN ('pending', 'waiting')
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)`,
        scope,
      ),
    ]);

    const totalBooths = Number(boothTotals[0]?.total || 0);
    const bookedBooths = Number(bookedTotals[0]?.total || 0);
    return ok(res, {
      today,
      totalBooths,
      bookedBooths,
      availableBooths: Math.max(totalBooths - bookedBooths, 0),
      dailyCustomers: Number(dailyCustomers[0]?.total || 0),
      bookingPaidToday: Number(bookingPaidTodayRows[0]?.total || 0),
      finePaidToday: Number(finePaidTodayRows[0]?.total || 0),
      paidToday: Number(bookingPaidTodayRows[0]?.total || 0) + Number(finePaidTodayRows[0]?.total || 0),
      paidThisMonth: Number(paidThisMonthRows[0]?.total || 0),
      pendingPaymentProofs: Number(pendingProofRows[0]?.total || 0),
      bookingOutstanding: Number(bookingOutstandingRows[0]?.total || 0),
      fineOutstanding: Number(fineOutstandingRows[0]?.total || 0),
      outstandingTotal: Number(bookingOutstandingRows[0]?.total || 0) + Number(fineOutstandingRows[0]?.total || 0),
    });
  }),
);

router.get(
  '/reports/bookings',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        marketId: z.coerce.number().int().positive().optional(),
        status: z.enum(['active', 'expired', 'all']).optional().default('active'),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const { marketId, status } = req.validated.query;
    const statusFilter = status === 'expired'
      ? "AND b.status = 'expired' AND bi.status = 'expired'"
      : status === 'all'
        ? "AND b.status IN ('pending_payment', 'payment_processing', 'expired') AND bi.status IN ('pending_payment', 'payment_processing', 'expired')"
        : "AND b.status IN ('pending_payment', 'payment_processing') AND bi.status IN ('pending_payment', 'payment_processing')";
    const dateFilter = buildAccountingDateFilter({
      dateField: 'created_date',
      startDate: req.validated.query.startDate,
      endDate: req.validated.query.endDate,
      aliases: { booking: 'b', payment: 'p', item: 'bi' },
    });
    const rows = await query(
      `SELECT m.id AS market_id, m.name AS market_name, b.public_id AS booking_public_id, b.status,
              MIN(bi.booking_date) AS booking_date,
              GROUP_CONCAT(DISTINCT DATE_FORMAT(bi.booking_date, '%Y-%m-%d') ORDER BY bi.booking_date SEPARATOR ', ') AS booking_dates,
              GROUP_CONCAT(DISTINCT CONCAT(COALESCE(bo.code, ''), CASE WHEN bo.name IS NULL OR bo.name = '' THEN '' ELSE CONCAT(' ', bo.name) END) ORDER BY bo.sort_order, bo.code SEPARATOR ', ') AS booths,
              b.source, b.created_at, COUNT(DISTINCT bi.id) AS booking_count, COALESCE(SUM(bi.unit_price), 0) AS booth_amount,
              b.subtotal_amount, b.discount_amount, b.vat_amount, b.total_amount,
              mu.username_enc, mu.first_name_enc, mu.last_name_enc, mu.phone_enc, mu.email_enc
       FROM bookings b
       JOIN markets m ON m.id = b.market_id
       JOIN mobile_users mu ON mu.id = b.mobile_user_id AND mu.organization_id = b.organization_id
       JOIN booking_items bi ON bi.booking_id = b.id
       JOIN booths bo ON bo.id = bi.booth_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE b.organization_id = :organizationId
         AND (:marketId IS NULL OR b.market_id = :marketId)
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         ${statusFilter}
         ${dateFilter.sql}
       GROUP BY m.id, m.name, b.id, b.public_id, b.status, b.source, b.created_at,
                b.subtotal_amount, b.discount_amount, b.vat_amount, b.total_amount,
                mu.username_enc, mu.first_name_enc, mu.last_name_enc, mu.phone_enc, mu.email_enc
       ORDER BY b.created_at DESC, m.name, b.public_id`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        marketId: marketId || null,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        ...dateFilter.params,
      },
    );
    return ok(
      res,
      rows.map((row) => ({
        ...row,
        customer_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim()
          || decryptField(row.username_enc)
          || decryptField(row.email_enc)
          || '-',
        customer_phone: decryptField(row.phone_enc) || '-',
        username_enc: undefined,
        first_name_enc: undefined,
        last_name_enc: undefined,
        phone_enc: undefined,
        email_enc: undefined,
      })),
    );
  }),
);

router.get(
  '/reports/available-booths',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        marketId: z.coerce.number().int().positive().optional(),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const startDate = req.validated.query.startDate || req.validated.query.bookingDate || new Date().toISOString().slice(0, 10);
    const endDate = req.validated.query.endDate || startDate;
    const marketId = req.validated.query.marketId || null;
    const rows = await query(
      `SELECT m.id AS market_id, m.name AS market_name, b.id AS booth_id, b.code AS booth_code, b.name AS booth_name,
              b.price, c.name AS category_name, c.name AS production_category_name, fp.name AS floor_plan_name,
              :startDate AS booking_date, :endDate AS booking_end_date
       FROM booths b
       JOIN markets m ON m.id = b.market_id
       LEFT JOIN product_categories c ON c.id = b.category_id
       LEFT JOIN floor_plans fp ON fp.id = b.floor_plan_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       LEFT JOIN booking_items bi
         ON bi.booth_id = b.id
        AND bi.organization_id = b.organization_id
        AND bi.booking_date >= :startDate
        AND bi.booking_date <= :endDate
        AND bi.status IN ('pending_payment', 'payment_processing', 'paid')
       LEFT JOIN bookings bk
         ON bk.id = bi.booking_id
        AND bk.organization_id = b.organization_id
        AND bk.status IN ('pending_payment', 'payment_processing', 'paid')
       WHERE b.organization_id = :organizationId
         AND b.status = 'active'
         AND (:marketId IS NULL OR b.market_id = :marketId)
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND bk.id IS NULL
       ORDER BY m.name, fp.name, b.sort_order, b.code`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        startDate,
        endDate,
        marketId,
      },
    );
    const vatSettings = await getOrganizationVatSettings({ execute: query }, req.auth.organizationId);
    return ok(res, rows.map((row) => {
      const priceBreakdown = calculateVatBreakdown(row.price, 0, vatSettings);
      return {
        ...row,
        vat_amount: priceBreakdown.vatAmount,
        gross_price: priceBreakdown.totalAmount,
      };
    }));
  }),
);

router.get(
  '/reports/daily-sales',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        bookingDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        marketId: z.coerce.number().int().positive().optional(),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const startDate = req.validated.query.startDate || req.validated.query.bookingDate || new Date().toISOString().slice(0, 10);
    const endDate = req.validated.query.endDate || startDate;
    const marketId = req.validated.query.marketId || null;
    const rows = await query(
      `SELECT bi.id,
              b.public_id AS booking_public_id,
              b.status AS booking_status,
              bi.status AS item_status,
              m.name AS market_name,
              mu.username_enc, mu.first_name_enc, mu.last_name_enc, mu.phone_enc,
              bo.code AS booth_code, bo.name AS booth_name,
              GROUP_CONCAT(DISTINCT p.name ORDER BY p.name SEPARATOR ', ') AS product_names,
              bi.booking_date,
              COALESCE(bi.unit_price, 0) AS subtotal_amount,
              COALESCE(ROUND(COALESCE(b.discount_amount, 0) * COALESCE(bi.unit_price, 0) / NULLIF(item_totals.total_unit_price, 0), 2), 0) AS discount_amount,
              COALESCE(ROUND(COALESCE(b.vat_amount, 0) * COALESCE(bi.unit_price, 0) / NULLIF(item_totals.total_unit_price, 0), 2), 0) AS vat_amount,
              COALESCE(ROUND(COALESCE(b.total_amount, 0) * COALESCE(bi.unit_price, 0) / NULLIF(item_totals.total_unit_price, 0), 2), 0) AS total_amount
       FROM booking_items bi
       JOIN bookings b ON b.id = bi.booking_id
       JOIN (
         SELECT booking_id, organization_id, COALESCE(SUM(unit_price), 0) AS total_unit_price
         FROM booking_items
         WHERE organization_id = :organizationId
         GROUP BY booking_id, organization_id
       ) item_totals ON item_totals.booking_id = b.id AND item_totals.organization_id = b.organization_id
       JOIN markets m ON m.id = b.market_id
       JOIN mobile_users mu ON mu.id = b.mobile_user_id
       JOIN booths bo ON bo.id = bi.booth_id
       LEFT JOIN booking_products bp ON bp.booking_item_id = bi.id
       LEFT JOIN products p ON p.id = bp.product_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE bi.organization_id = :organizationId
         AND b.organization_id = :organizationId
         AND mu.organization_id = :organizationId
         AND (:marketId IS NULL OR b.market_id = :marketId)
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND b.status = 'paid'
         AND bi.status = 'paid'
         AND bi.booking_date >= :startDate
         AND bi.booking_date <= :endDate
       GROUP BY bi.id, b.public_id, b.status, bi.status, m.name, mu.username_enc, mu.first_name_enc, mu.last_name_enc, mu.phone_enc, bo.code, bo.name,
                bi.booking_date, bi.unit_price, b.discount_amount, b.vat_amount, b.total_amount, item_totals.total_unit_price
       ORDER BY bi.booking_date ASC, b.created_at DESC, m.name, bo.sort_order, bo.code, b.public_id`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        startDate,
        endDate,
        marketId,
      },
    );
    return ok(
      res,
      rows.map((row) => ({
        ...row,
        customer_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim() || decryptField(row.username_enc) || '-',
        customer_phone: decryptField(row.phone_enc) || '-',
        username_enc: undefined,
        first_name_enc: undefined,
        last_name_enc: undefined,
        phone_enc: undefined,
      })),
    );
  }),
);

router.get(
  '/reports/customer-bookings',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        mobileUserId: z.coerce.number().int().positive(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        marketId: z.coerce.number().int().positive().optional(),
        limit: z.coerce.number().int().min(1).max(1000).optional().default(500),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const { mobileUserId, startDate, endDate, marketId, limit } = req.validated.query;
    const rows = await query(
      `SELECT bi.id,
              b.public_id AS booking_public_id,
              b.status AS booking_status,
              bi.status AS item_status,
              m.name AS market_name,
              mu.username_enc, mu.first_name_enc, mu.last_name_enc, mu.phone_enc,
              bo.code AS booth_code, bo.name AS booth_name,
              GROUP_CONCAT(DISTINCT p.name ORDER BY p.name SEPARATOR ', ') AS product_names,
              bi.booking_date,
              COALESCE(bi.unit_price, 0) AS subtotal_amount,
              COALESCE(ROUND(COALESCE(b.discount_amount, 0) * COALESCE(bi.unit_price, 0) / NULLIF(item_totals.total_unit_price, 0), 2), 0) AS discount_amount,
              COALESCE(ROUND(COALESCE(b.vat_amount, 0) * COALESCE(bi.unit_price, 0) / NULLIF(item_totals.total_unit_price, 0), 2), 0) AS vat_amount,
              COALESCE(ROUND(COALESCE(b.total_amount, 0) * COALESCE(bi.unit_price, 0) / NULLIF(item_totals.total_unit_price, 0), 2), 0) AS total_amount
       FROM booking_items bi
       JOIN bookings b ON b.id = bi.booking_id
       JOIN (
         SELECT booking_id, organization_id, COALESCE(SUM(unit_price), 0) AS total_unit_price
         FROM booking_items
         WHERE organization_id = :organizationId
         GROUP BY booking_id, organization_id
       ) item_totals ON item_totals.booking_id = b.id AND item_totals.organization_id = b.organization_id
       JOIN markets m ON m.id = b.market_id
       JOIN mobile_users mu ON mu.id = b.mobile_user_id
       JOIN booths bo ON bo.id = bi.booth_id
       LEFT JOIN booking_products bp ON bp.booking_item_id = bi.id
       LEFT JOIN products p ON p.id = bp.product_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE bi.organization_id = :organizationId
         AND b.organization_id = :organizationId
         AND mu.organization_id = :organizationId
         AND b.mobile_user_id = :mobileUserId
         AND (:marketId IS NULL OR b.market_id = :marketId)
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND b.status = 'paid'
         AND bi.status = 'paid'
         AND (:startDate IS NULL OR bi.booking_date >= :startDate)
         AND (:endDate IS NULL OR bi.booking_date <= :endDate)
       GROUP BY bi.id, b.public_id, b.status, bi.status, m.name, mu.username_enc, mu.first_name_enc, mu.last_name_enc, mu.phone_enc, bo.code, bo.name,
                bi.booking_date, bi.unit_price, b.discount_amount, b.vat_amount, b.total_amount, item_totals.total_unit_price
       ORDER BY bi.booking_date DESC, b.created_at DESC, m.name, bo.sort_order, bo.code, b.public_id
       LIMIT :limit`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        mobileUserId,
        startDate: startDate || null,
        endDate: endDate || null,
        marketId: marketId || null,
        limit,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
      },
    );
    return ok(
      res,
      rows.map((row) => ({
        ...row,
        customer_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim() || decryptField(row.username_enc) || '-',
        customer_phone: decryptField(row.phone_enc) || '-',
        username_enc: undefined,
        first_name_enc: undefined,
        last_name_enc: undefined,
        phone_enc: undefined,
      })),
    );
  }),
);

router.get(
  '/accounting/product-types',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        marketId: z.coerce.number().int().positive().optional(),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const { startDate, endDate, marketId } = req.validated.query;
    const dateFilter = buildAccountingDateFilter({
      dateField: 'payment_date',
      startDate,
      endDate,
      aliases: { payment: 'p', booking: 'b', item: 'bi' },
    });
    const rows = await query(
      `SELECT bi.id,
              b.public_id AS booking_public_id,
              m.name AS market_name,
              mu.username_enc, mu.first_name_enc, mu.last_name_enc,
              DATE(COALESCE(p.paid_at, p.created_at)) AS paid_date,
              COALESCE(ROUND(
                GREATEST(COALESCE(b.subtotal_amount, 0) - COALESCE(b.discount_amount, 0), 0)
                * COALESCE(bi.unit_price, 0)
                / NULLIF(item_totals.total_unit_price, 0),
                2
              ), 0) AS amount_before_vat,
              GROUP_CONCAT(DISTINCT pr.name ORDER BY pr.name SEPARATOR ', ') AS product_names
       FROM booking_items bi
       JOIN bookings b ON b.id = bi.booking_id
       JOIN (
         SELECT booking_id, organization_id, MAX(COALESCE(paid_at, created_at)) AS paid_at, MAX(created_at) AS created_at
         FROM payments
         WHERE organization_id = :organizationId
           AND booking_id IS NOT NULL
           AND status = 'paid'
         GROUP BY booking_id, organization_id
       ) p ON p.booking_id = b.id AND p.organization_id = b.organization_id
       JOIN (
         SELECT booking_id, organization_id, COALESCE(SUM(unit_price), 0) AS total_unit_price
         FROM booking_items
         WHERE organization_id = :organizationId
         GROUP BY booking_id, organization_id
       ) item_totals ON item_totals.booking_id = b.id AND item_totals.organization_id = b.organization_id
       JOIN markets m ON m.id = b.market_id
       JOIN mobile_users mu ON mu.id = b.mobile_user_id
       LEFT JOIN booking_products bp ON bp.booking_item_id = bi.id
       LEFT JOIN products pr ON pr.id = bp.product_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = b.market_id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE bi.organization_id = :organizationId
         AND b.organization_id = :organizationId
         AND (:marketId IS NULL OR b.market_id = :marketId)
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND b.status = 'paid'
         AND bi.status = 'paid'
         ${dateFilter.sql}
       GROUP BY bi.id, b.public_id, m.name, mu.username_enc, mu.first_name_enc, mu.last_name_enc,
                DATE(COALESCE(p.paid_at, p.created_at)), b.subtotal_amount, b.discount_amount, bi.unit_price, item_totals.total_unit_price
       ORDER BY DATE(COALESCE(p.paid_at, p.created_at)) ASC, b.public_id ASC
       LIMIT 1000`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        marketId: marketId || null,
        ...dateFilter.params,
      },
    );
    return ok(res, rows.map((row) => ({
      ...row,
      customer_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim() || decryptField(row.username_enc) || '-',
      username_enc: undefined,
      first_name_enc: undefined,
      last_name_enc: undefined,
    })));
  }),
);

router.get(
  '/accounting/report-all',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        marketId: z.coerce.number().int().positive().optional(),
        paidOnly: z.enum(['0', '1']).optional(),
        dateField: z.enum(['created_date', 'booking_date', 'payment_date']).optional().default('payment_date'),
        sortBy: z.enum(['booking_public_id', 'booking_date', 'payment_date']).optional().default('payment_date'),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const { startDate, endDate, marketId, dateField, sortBy } = req.validated.query;
    const paidOnly = req.validated.query.paidOnly === '1';
    const orderBy = {
      booking_public_id: 'b.public_id ASC',
      booking_date: 'item_summary.first_booking_date DESC, b.public_id ASC',
      payment_date: 'COALESCE(p.paid_at, p.created_at) DESC, b.public_id ASC',
    }[sortBy];
    const dateFilter = buildAccountingDateFilter({
      dateField,
      startDate,
      endDate,
      aliases: {
        payment: 'p',
        booking: 'b',
        item: 'item_summary',
        itemDateColumn: 'first_booking_date',
      },
    });

    const rows = await query(
      `SELECT b.id,
              b.public_id AS booking_public_id,
              b.status AS booking_status,
              b.subtotal_amount,
              b.discount_amount,
              b.vat_amount,
              b.total_amount,
              b.created_at,
              b.comment AS reason,
              m.id AS market_id,
              m.name AS market_name,
              mu.username_enc,
              mu.first_name_enc,
              mu.last_name_enc,
              p.status AS payment_status,
              p.paid_at,
              p.created_at AS payment_created_at,
              item_summary.first_booking_date AS booking_date,
              item_summary.booking_dates,
              COALESCE(item_summary.booth_service_amount, 0) AS booth_service_amount,
              COALESCE(accessory_summary.other_service_amount, 0) AS other_service_amount,
              COALESCE(fine_summary.fine_amount, 0) AS fine_amount,
              COALESCE(fine_summary.fine_vat_amount, 0) AS fine_vat_amount,
              COALESCE(fine_summary.total_fine_amount, 0) AS total_fine_amount,
              GREATEST(
                COALESCE(b.subtotal_amount, 0)
                - COALESCE(b.discount_amount, 0)
                + COALESCE(fine_summary.fine_amount, 0),
                0
              ) AS amount_before_vat,
              0 AS withholding_tax_amount
       FROM bookings b
       JOIN markets m ON m.id = b.market_id
       JOIN mobile_users mu ON mu.id = b.mobile_user_id
       JOIN (
         SELECT booking_id,
                MIN(booking_date) AS first_booking_date,
                GROUP_CONCAT(DISTINCT DATE_FORMAT(booking_date, '%Y-%m-%d') ORDER BY booking_date SEPARATOR ', ') AS booking_dates,
                COALESCE(SUM(unit_price), 0) AS booth_service_amount
         FROM booking_items
         WHERE organization_id = :organizationId
         GROUP BY booking_id
       ) item_summary ON item_summary.booking_id = b.id
       LEFT JOIN (
         SELECT bi.booking_id,
                COALESCE(SUM(a.price * ba.quantity), 0) AS other_service_amount
         FROM booking_accessories ba
         JOIN booking_items bi ON bi.id = ba.booking_item_id
         JOIN accessories a ON a.id = ba.accessory_id
         WHERE ba.organization_id = :organizationId
         GROUP BY bi.booking_id
       ) accessory_summary ON accessory_summary.booking_id = b.id
       LEFT JOIN (
         SELECT bi.booking_id,
                COALESCE(SUM(ac.fine_amount + ac.accessories_fine_amount + ac.damage_fine_amount), 0) AS fine_amount,
                COALESCE(SUM(ac.vat_amount), 0) AS fine_vat_amount,
                COALESCE(SUM(ac.total_fine_amount), 0) AS total_fine_amount
         FROM audit_checks ac
         JOIN booking_items bi ON bi.id = ac.booking_item_id
         WHERE ac.organization_id = :organizationId
           AND ac.fine_payment_status = 'paid'
         GROUP BY bi.booking_id
       ) fine_summary ON fine_summary.booking_id = b.id
       LEFT JOIN payments p
         ON p.id = (
           SELECT p2.id
           FROM payments p2
           WHERE p2.booking_id = b.id
             AND p2.organization_id = b.organization_id
           ORDER BY p2.created_at DESC, p2.id DESC
           LIMIT 1
         )
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = b.market_id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE b.organization_id = :organizationId
         AND mu.organization_id = :organizationId
         AND (:marketId IS NULL OR b.market_id = :marketId)
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND (:paidOnly = 0 OR (b.status = 'paid' AND p.status = 'paid'))
         ${dateFilter.sql}
       ORDER BY ${orderBy}
       LIMIT 1000`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        marketId: marketId || null,
        paidOnly: paidOnly ? 1 : 0,
        ...dateFilter.params,
      },
    );

    return ok(
      res,
      rows.map((row) => ({
        ...row,
        customer_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim() || decryptField(row.username_enc) || '-',
        status: row.payment_status || row.booking_status,
        username_enc: undefined,
        first_name_enc: undefined,
        last_name_enc: undefined,
      })),
    );
  }),
);

router.get(
  '/accounting/payments',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        paidOnly: z.enum(['0', '1']).optional(),
        status: z.enum(['paid']).optional(),
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        marketId: z.coerce.number().int().positive().optional(),
        dateField: z.enum(['created_date', 'booking_date', 'payment_date']).optional().default('payment_date'),
        sortBy: z.enum(['booking_public_id', 'booking_date', 'payment_date']).optional().default('payment_date'),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const { startDate, endDate, marketId, dateField, sortBy } = req.validated.query;
    const paidOnly = req.validated.query.paidOnly === '1' || req.validated.query.status === 'paid';
    const orderBy = {
      booking_public_id: 'COALESCE(b.public_id, ac_b.public_id) ASC',
      booking_date: 'MIN(bi.booking_date) DESC, COALESCE(b.public_id, ac_b.public_id) ASC',
      payment_date: 'COALESCE(p.paid_at, p.created_at) DESC, COALESCE(b.public_id, ac_b.public_id) ASC',
    }[sortBy];
    const dateFilter = buildAccountingDateFilter({
      dateField,
      startDate,
      endDate,
      aliases: { payment: 'p', booking: 'p', item: 'bi' },
    });
    const rows = await query(
      `SELECT p.id, p.public_id, p.provider, p.status, p.amount, p.paid_at, p.created_at,
              p.audit_check_id,
              COALESCE(b.public_id, ac_b.public_id) AS booking_public_id,
              CASE WHEN p.audit_check_id IS NOT NULL THEN 'audit_fine' ELSE 'booking' END AS payment_kind,
              CASE WHEN p.audit_check_id IS NOT NULL
                THEN COALESCE(ac.fine_amount, 0) + COALESCE(ac.accessories_fine_amount, 0) + COALESCE(ac.damage_fine_amount, 0)
                ELSE b.subtotal_amount
              END AS subtotal_amount,
              CASE WHEN p.audit_check_id IS NOT NULL THEN 0 ELSE b.discount_amount END AS discount_amount,
              CASE WHEN p.audit_check_id IS NOT NULL THEN ac.vat_amount ELSE b.vat_amount END AS vat_amount,
              CASE WHEN p.audit_check_id IS NOT NULL THEN ac.total_fine_amount ELSE b.total_amount END AS total_amount,
              m.id AS market_id, m.name AS market_name,
              mu.username_enc, mu.first_name_enc, mu.last_name_enc,
              ad.id AS document_id, ad.document_type, ad.document_no, ad.document_status, ad.issue_date,
              o.name AS organization_name, o.address AS organization_address, o.email AS organization_email, o.phone AS organization_phone,
              o.vat_enabled, o.vat_rate, o.registered_name, o.registered_tax_id, o.registered_subdistrict,
              o.registered_district, o.registered_province, o.registered_postcode,
              GROUP_CONCAT(DISTINCT DATE_FORMAT(bi.booking_date, '%Y-%m-%d') ORDER BY bi.booking_date SEPARATOR ', ') AS booking_dates,
              GROUP_CONCAT(DISTINCT CONCAT(COALESCE(bo.code, ''), CASE WHEN bo.name IS NULL OR bo.name = '' THEN '' ELSE CONCAT(' ', bo.name) END) ORDER BY bo.sort_order, bo.code SEPARATOR ', ') AS booths
       FROM payments p
       LEFT JOIN bookings b ON b.id = p.booking_id AND b.organization_id = p.organization_id
       LEFT JOIN audit_checks ac ON ac.id = p.audit_check_id AND ac.organization_id = p.organization_id
       LEFT JOIN booking_items ac_bi ON ac_bi.id = ac.booking_item_id AND ac_bi.organization_id = ac.organization_id
       LEFT JOIN bookings ac_b ON ac_b.id = ac_bi.booking_id AND ac_b.organization_id = ac_bi.organization_id
       LEFT JOIN organizations o ON o.id = p.organization_id
       LEFT JOIN markets m ON m.id = COALESCE(b.market_id, ac.market_id) AND m.organization_id = p.organization_id
       LEFT JOIN mobile_users mu ON mu.id = COALESCE(b.mobile_user_id, ac_b.mobile_user_id) AND mu.organization_id = p.organization_id
       LEFT JOIN accounting_documents ad
         ON ad.id = (
           SELECT ad2.id
           FROM accounting_documents ad2
           WHERE ad2.payment_id = p.id
             AND ad2.organization_id = p.organization_id
             AND ad2.document_status = 'issued'
           ORDER BY ad2.id DESC
           LIMIT 1
         )
       LEFT JOIN booking_items bi
         ON bi.organization_id = p.organization_id
        AND (
          (p.booking_id IS NOT NULL AND bi.booking_id = b.id)
          OR (p.audit_check_id IS NOT NULL AND bi.id = ac.booking_item_id)
        )
       LEFT JOIN booths bo ON bo.id = bi.booth_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE p.organization_id = :organizationId
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND (:marketId IS NULL OR m.id = :marketId)
         AND (:paidOnly = 0 OR p.status = 'paid')
         AND (:paidOnly = 0 OR (
           (p.booking_id IS NOT NULL AND b.status = 'paid')
           OR (p.audit_check_id IS NOT NULL AND ac.fine_payment_status = 'paid')
         ))
         ${dateFilter.sql}
       GROUP BY p.id, p.public_id, p.provider, p.status, p.amount, p.paid_at, p.created_at,
                p.audit_check_id, b.public_id, b.subtotal_amount, b.discount_amount, b.vat_amount, b.total_amount,
                ac.id, ac.fine_amount, ac.accessories_fine_amount, ac.damage_fine_amount, ac.vat_amount, ac.total_fine_amount,
                ac_b.public_id,
                m.id, m.name, mu.username_enc, mu.first_name_enc, mu.last_name_enc,
                ad.id, ad.document_type, ad.document_no, ad.document_status, ad.issue_date,
                o.name, o.address, o.email, o.phone, o.vat_enabled, o.vat_rate, o.registered_name,
                o.registered_tax_id, o.registered_subdistrict, o.registered_district, o.registered_province, o.registered_postcode
       ORDER BY ${orderBy}
       LIMIT 500`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        paidOnly: paidOnly ? 1 : 0,
        marketId: marketId || null,
        ...dateFilter.params,
      },
    );
    return ok(
      res,
      rows.map((row) => ({
        ...row,
        customer_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim() || decryptField(row.username_enc) || '-',
        username_enc: undefined,
        first_name_enc: undefined,
        last_name_enc: undefined,
      })),
    );
  }),
);

router.get(
  '/accounting/documents',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        documentType: z.enum(['all', 'receipt', 'tax_invoice', 'credit_note']).optional().default('all'),
        documentStatus: z.enum(['all', 'issued', 'cancelled', 'void']).optional().default('all'),
        keyword: z.string().optional().default(''),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { startDate, endDate, documentType, documentStatus, keyword } = req.validated.query;
    const rows = await query(
      `SELECT ad.id, ad.document_type, ad.document_no, ad.document_status, ad.issue_date,
              ad.subtotal_amount, ad.discount_amount, ad.vat_amount, ad.withholding_tax_amount, ad.total_amount,
              ad.customer_name, ad.cancel_reason, ad.cancelled_at,
              p.public_id AS payment_public_id, COALESCE(b.public_id, ac_b.public_id) AS booking_public_id,
              source.document_no AS source_document_no,
              issuer.name_enc AS issued_by_name_enc,
              canceller.name_enc AS cancelled_by_name_enc
       FROM accounting_documents ad
       LEFT JOIN payments p ON p.id = ad.payment_id
       LEFT JOIN bookings b ON b.id = ad.booking_id
       LEFT JOIN audit_checks ac ON ac.id = ad.audit_check_id AND ac.organization_id = ad.organization_id
       LEFT JOIN booking_items ac_bi ON ac_bi.id = ac.booking_item_id AND ac_bi.organization_id = ac.organization_id
       LEFT JOIN bookings ac_b ON ac_b.id = ac_bi.booking_id AND ac_b.organization_id = ac_bi.organization_id
       LEFT JOIN accounting_documents source ON source.id = ad.source_document_id
       LEFT JOIN admin_users issuer ON issuer.id = ad.issued_by_admin_id
       LEFT JOIN admin_users canceller ON canceller.id = ad.cancelled_by_admin_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = COALESCE(b.market_id, ac.market_id) AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE ad.organization_id = :organizationId
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND (:startDate IS NULL OR ad.issue_date >= :startDate)
         AND (:endDate IS NULL OR ad.issue_date <= :endDate)
         AND (:documentType = 'all' OR ad.document_type = :documentType)
         AND (:documentStatus = 'all' OR ad.document_status = :documentStatus)
         AND (
           :keyword = ''
           OR ad.document_no LIKE :keywordLike
           OR ad.customer_name LIKE :keywordLike
           OR COALESCE(b.public_id, ac_b.public_id) LIKE :keywordLike
           OR p.public_id LIKE :keywordLike
         )
       ORDER BY ad.issue_date DESC, ad.id DESC
       LIMIT 1000`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        startDate: startDate || null,
        endDate: endDate || null,
        documentType,
        documentStatus,
        keyword,
        keywordLike: `%${keyword}%`,
      },
    );
    return ok(res, rows.map((row) => ({
      ...row,
      document_type_label: accountingDocumentTypeLabel(row.document_type),
      issued_by_name: decryptField(row.issued_by_name_enc) || '-',
      cancelled_by_name: decryptField(row.cancelled_by_name_enc) || '-',
      issued_by_name_enc: undefined,
      cancelled_by_name_enc: undefined,
    })));
  }),
);

router.get(
  '/accounting/tax-sales',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.validated.query;
    const rows = await query(
      `SELECT ad.id, ad.document_type, ad.document_no, ad.document_status, ad.issue_date,
              ad.customer_name, ad.subtotal_amount, ad.discount_amount, ad.vat_amount, ad.total_amount,
              source.document_no AS source_document_no,
              COALESCE(b.public_id, ac_b.public_id) AS booking_public_id, p.public_id AS payment_public_id
       FROM accounting_documents ad
       LEFT JOIN accounting_documents source ON source.id = ad.source_document_id
       LEFT JOIN bookings b ON b.id = ad.booking_id
       LEFT JOIN audit_checks ac ON ac.id = ad.audit_check_id AND ac.organization_id = ad.organization_id
       LEFT JOIN booking_items ac_bi ON ac_bi.id = ac.booking_item_id AND ac_bi.organization_id = ac.organization_id
       LEFT JOIN bookings ac_b ON ac_b.id = ac_bi.booking_id AND ac_b.organization_id = ac_bi.organization_id
       LEFT JOIN payments p ON p.id = ad.payment_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = COALESCE(b.market_id, ac.market_id) AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE ad.organization_id = :organizationId
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND ad.document_type IN ('tax_invoice', 'credit_note')
         AND ad.document_status = 'issued'
         AND (:startDate IS NULL OR ad.issue_date >= :startDate)
         AND (:endDate IS NULL OR ad.issue_date <= :endDate)
       ORDER BY ad.issue_date ASC, ad.document_no ASC
       LIMIT 1000`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        startDate: startDate || null,
        endDate: endDate || null,
      },
    );
    return ok(res, rows.map((row) => {
      const sign = row.document_type === 'credit_note' ? -1 : 1;
      return {
        ...row,
        document_type_label: accountingDocumentTypeLabel(row.document_type),
        taxable_amount: sign * Math.max(Number(row.subtotal_amount || 0) - Number(row.discount_amount || 0), 0),
        vat_report_amount: sign * Number(row.vat_amount || 0),
        total_report_amount: sign * Number(row.total_amount || 0),
      };
    }));
  }),
);

router.get(
  '/accounting/receivables-aging',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        asOfDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        marketId: z.coerce.number().int().positive().optional(),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    await expireStaleBookings({ execute: query }, req.auth.organizationId);
    const asOfDate = req.validated.query.asOfDate || currentDateBangkok();
    const marketId = req.validated.query.marketId || null;
    const rows = await query(
      `SELECT *
       FROM (
         SELECT 'booking' AS receivable_type,
                b.id AS source_id,
                b.public_id AS source_public_id,
                m.name AS market_name,
                mu.username_enc, mu.first_name_enc, mu.last_name_enc,
                b.total_amount AS outstanding_amount,
                b.status AS status,
                DATE(COALESCE(b.expires_at, b.created_at)) AS due_date,
                DATEDIFF(:asOfDate, DATE(COALESCE(b.expires_at, b.created_at))) AS aging_days,
                GROUP_CONCAT(DISTINCT DATE_FORMAT(bi.booking_date, '%Y-%m-%d') ORDER BY bi.booking_date SEPARATOR ', ') AS booking_dates
         FROM bookings b
         JOIN markets m ON m.id = b.market_id
         JOIN mobile_users mu ON mu.id = b.mobile_user_id
         JOIN booking_items bi ON bi.booking_id = b.id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = b.market_id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE b.organization_id = :organizationId
           AND b.status IN ('pending_payment', 'payment_processing')
           AND (:marketId IS NULL OR b.market_id = :marketId)
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         GROUP BY b.id, b.public_id, m.name, mu.username_enc, mu.first_name_enc, mu.last_name_enc, b.total_amount, b.status, b.expires_at, b.created_at
         UNION ALL
         SELECT 'fine' AS receivable_type,
                ac.id AS source_id,
                b.public_id AS source_public_id,
                m.name AS market_name,
                mu.username_enc, mu.first_name_enc, mu.last_name_enc,
                ac.total_fine_amount AS outstanding_amount,
                ac.fine_payment_status AS status,
                DATE(ac.checked_at) AS due_date,
                DATEDIFF(:asOfDate, DATE(ac.checked_at)) AS aging_days,
                DATE_FORMAT(bi.booking_date, '%Y-%m-%d') AS booking_dates
         FROM audit_checks ac
         JOIN booking_items bi ON bi.id = ac.booking_item_id
         JOIN bookings b ON b.id = bi.booking_id
         JOIN markets m ON m.id = ac.market_id
         JOIN mobile_users mu ON mu.id = b.mobile_user_id
         LEFT JOIN admin_market_assignments ama
           ON ama.market_id = ac.market_id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
         WHERE ac.organization_id = :organizationId
           AND ac.total_fine_amount > 0
           AND ac.fine_payment_status IN ('pending', 'waiting')
           AND (:marketId IS NULL OR ac.market_id = :marketId)
           AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
       ) receivables
       ORDER BY aging_days DESC, due_date ASC
       LIMIT 1000`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        marketId,
        asOfDate,
      },
    );
    return ok(res, rows.map((row) => ({
      ...row,
      customer_name: [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim() || decryptField(row.username_enc) || '-',
      aging_bucket: Number(row.aging_days || 0) <= 7 ? '0-7 วัน' : Number(row.aging_days || 0) <= 15 ? '8-15 วัน' : Number(row.aging_days || 0) <= 30 ? '16-30 วัน' : 'มากกว่า 30 วัน',
      username_enc: undefined,
      first_name_enc: undefined,
      last_name_enc: undefined,
    })));
  }),
);

router.get(
  '/accounting/reconciliation',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        marketId: z.coerce.number().int().positive().optional(),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { startDate, endDate, marketId } = req.validated.query;
    const dateFilter = buildAccountingDateFilter({
      dateField: 'payment_date',
      startDate,
      endDate,
      aliases: { payment: 'p', booking: 'b', item: 'bi' },
    });
    const rows = await query(
      `SELECT p.id, p.public_id AS payment_public_id, p.provider, p.provider_reference,
              CASE WHEN p.audit_check_id IS NOT NULL THEN 'audit_fine' ELSE 'booking' END AS payment_kind,
              p.status AS payment_status, p.amount AS payment_amount, p.paid_at, p.created_at,
              COALESCE(b.public_id, ac_b.public_id) AS booking_public_id,
              CASE WHEN p.audit_check_id IS NOT NULL THEN ac.fine_payment_status ELSE b.status END AS booking_status,
              CASE WHEN p.audit_check_id IS NOT NULL THEN ac.total_fine_amount ELSE b.total_amount END AS booking_amount,
              m.name AS market_name,
              ad.document_no, ad.document_type,
              (
                SELECT COUNT(*)
                FROM payment_callbacks pc
                WHERE pc.provider = p.provider
                  AND DATE(pc.received_at) = DATE(COALESCE(p.paid_at, p.created_at))
              ) AS callback_count
       FROM payments p
       LEFT JOIN bookings b ON b.id = p.booking_id AND b.organization_id = p.organization_id
       LEFT JOIN audit_checks ac ON ac.id = p.audit_check_id AND ac.organization_id = p.organization_id
       LEFT JOIN booking_items ac_bi ON ac_bi.id = ac.booking_item_id AND ac_bi.organization_id = ac.organization_id
       LEFT JOIN bookings ac_b ON ac_b.id = ac_bi.booking_id AND ac_b.organization_id = ac_bi.organization_id
       LEFT JOIN markets m ON m.id = COALESCE(b.market_id, ac.market_id) AND m.organization_id = p.organization_id
       LEFT JOIN accounting_documents ad
         ON ad.id = (
           SELECT ad2.id
           FROM accounting_documents ad2
           WHERE ad2.payment_id = p.id
             AND ad2.organization_id = p.organization_id
             AND ad2.document_status = 'issued'
           ORDER BY ad2.id DESC
           LIMIT 1
         )
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE p.organization_id = :organizationId
         AND (:marketId IS NULL OR m.id = :marketId)
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         ${dateFilter.sql}
       ORDER BY COALESCE(p.paid_at, p.created_at) DESC, p.id DESC
       LIMIT 1000`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        marketId: marketId || null,
        ...dateFilter.params,
      },
    );
    return ok(res, rows.map((row) => {
      const amountMatched = Math.abs(Number(row.payment_amount || 0) - Number(row.booking_amount || 0)) < 0.01;
      const statusMatched = row.payment_status === 'paid' ? row.booking_status === 'paid' : true;
      return {
        ...row,
        amount_matched: amountMatched ? 1 : 0,
        status_matched: statusMatched ? 1 : 0,
        reconciliation_status: amountMatched && statusMatched && (row.provider === 'manual' || Number(row.callback_count || 0) > 0) ? 'matched' : 'review',
      };
    }));
  }),
);

router.get(
  '/accounting/refunds',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({}).passthrough().optional().default({}),
      query: z.object({
        startDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
        endDate: z.string().regex(/^\d{4}-\d{2}-\d{2}$/).optional(),
      }),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const { startDate, endDate } = req.validated.query;
    const rows = await query(
      `SELECT ad.id, 'credit_note' AS refund_type, ad.document_no, ad.document_status, ad.issue_date,
              ad.customer_name, NULL AS username_enc, NULL AS first_name_enc, NULL AS last_name_enc,
              ad.total_amount, ad.cancel_reason AS reason,
              source.document_no AS source_document_no,
              COALESCE(b.public_id, ac_b.public_id) AS booking_public_id, p.public_id AS payment_public_id,
              issuer.name_enc AS issued_by_name_enc
       FROM accounting_documents ad
       LEFT JOIN accounting_documents source ON source.id = ad.source_document_id
       LEFT JOIN bookings b ON b.id = ad.booking_id
       LEFT JOIN audit_checks ac ON ac.id = ad.audit_check_id AND ac.organization_id = ad.organization_id
       LEFT JOIN booking_items ac_bi ON ac_bi.id = ac.booking_item_id AND ac_bi.organization_id = ac.organization_id
       LEFT JOIN bookings ac_b ON ac_b.id = ac_bi.booking_id AND ac_b.organization_id = ac_bi.organization_id
       LEFT JOIN payments p ON p.id = ad.payment_id
       LEFT JOIN admin_users issuer ON issuer.id = ad.issued_by_admin_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = COALESCE(b.market_id, ac.market_id) AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE ad.organization_id = :organizationId
         AND ad.document_type = 'credit_note'
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND (:startDate IS NULL OR ad.issue_date >= :startDate)
         AND (:endDate IS NULL OR ad.issue_date <= :endDate)
       UNION ALL
       SELECT p.id, 'payment_refund' AS refund_type, p.public_id AS document_no, p.status AS document_status,
              DATE(COALESCE(p.paid_at, p.created_at)) AS issue_date,
              NULL AS customer_name,
              mu.username_enc, mu.first_name_enc, mu.last_name_enc,
              p.amount AS total_amount, COALESCE(b.comment, ac.note) AS reason,
              NULL AS source_document_no, COALESCE(b.public_id, ac_b.public_id) AS booking_public_id, p.public_id AS payment_public_id,
              NULL AS issued_by_name_enc
       FROM payments p
       LEFT JOIN bookings b ON b.id = p.booking_id AND b.organization_id = p.organization_id
       LEFT JOIN audit_checks ac ON ac.id = p.audit_check_id AND ac.organization_id = p.organization_id
       LEFT JOIN booking_items ac_bi ON ac_bi.id = ac.booking_item_id AND ac_bi.organization_id = ac.organization_id
       LEFT JOIN bookings ac_b ON ac_b.id = ac_bi.booking_id AND ac_b.organization_id = ac_bi.organization_id
       LEFT JOIN mobile_users mu ON mu.id = COALESCE(b.mobile_user_id, ac_b.mobile_user_id) AND mu.organization_id = p.organization_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = COALESCE(b.market_id, ac.market_id) AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE p.organization_id = :organizationId
         AND p.status IN ('refunded', 'cancelled')
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND (:startDate IS NULL OR DATE(COALESCE(p.paid_at, p.created_at)) >= :startDate)
         AND (:endDate IS NULL OR DATE(COALESCE(p.paid_at, p.created_at)) <= :endDate)
       ORDER BY issue_date DESC, id DESC
       LIMIT 1000`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        startDate: startDate || null,
        endDate: endDate || null,
      },
    );
    return ok(res, rows.map((row) => ({
      ...row,
      customer_name: row.refund_type === 'payment_refund'
        ? [decryptField(row.first_name_enc), decryptField(row.last_name_enc)].filter(Boolean).join(' ').trim() || decryptField(row.username_enc) || '-'
        : row.customer_name || '-',
      issued_by_name: decryptField(row.issued_by_name_enc) || '-',
      username_enc: undefined,
      first_name_enc: undefined,
      last_name_enc: undefined,
      issued_by_name_enc: undefined,
    })));
  }),
);

router.post(
  '/accounting/payments/:paymentId/document',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({
        documentType: z.enum(['receipt', 'tax_invoice']).optional(),
      }).optional().default({}),
      query: z.object({}).passthrough(),
      params: z.object({ paymentId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await transaction(async (conn) => issueAccountingDocument(conn, {
      organizationId: req.auth.organizationId,
      paymentId: req.validated.params.paymentId,
      adminUserId: req.auth.sub,
      hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
      documentType: req.validated.body.documentType,
    }));
    return created(res, result, `${accountingDocumentTypeLabel(result.document.document_type)} issued`);
  }),
);

router.patch(
  '/accounting/documents/:documentId/cancel',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({
        reason: z.string().optional().default(''),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ documentId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await transaction(async (conn) => {
      const [documents] = await conn.execute(
        `SELECT id, document_type, document_no, payment_id
         FROM accounting_documents
         WHERE id = :documentId
           AND organization_id = :organizationId
           AND document_status = 'issued'
         LIMIT 1
         FOR UPDATE`,
        { organizationId: req.auth.organizationId, documentId: req.validated.params.documentId },
      );
      const document = documents[0];
      if (!document) throw notFound('Issued document not found');

      await conn.execute(
        `UPDATE accounting_documents
         SET document_status = 'cancelled',
             cancelled_by_admin_id = :adminUserId,
             cancelled_at = NOW(),
             cancel_reason = :reason
         WHERE id = :documentId AND organization_id = :organizationId`,
        {
          organizationId: req.auth.organizationId,
          documentId: document.id,
          adminUserId: req.auth.sub,
          reason: req.validated.body.reason,
        },
      );
      return { id: document.id, documentNo: document.document_no, documentStatus: 'cancelled' };
    });
    return ok(res, result, 'accounting document cancelled');
  }),
);

router.post(
  '/accounting/documents/:documentId/credit-note',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  validate(
    z.object({
      body: z.object({
        reason: z.string().optional().default(''),
      }),
      query: z.object({}).passthrough(),
      params: z.object({ documentId: z.coerce.number().int().positive() }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const result = await transaction(async (conn) => {
      const [documents] = await conn.execute(
        `SELECT *
         FROM accounting_documents
         WHERE id = :documentId
           AND organization_id = :organizationId
           AND document_status = 'issued'
         LIMIT 1
         FOR UPDATE`,
        { organizationId: req.auth.organizationId, documentId: req.validated.params.documentId },
      );
      const source = documents[0];
      if (!source) throw notFound('Source document not found');

      const [existing] = await conn.execute(
        `SELECT *
         FROM accounting_documents
         WHERE organization_id = :organizationId
           AND source_document_id = :sourceDocumentId
           AND document_type = 'credit_note'
           AND document_status = 'issued'
         LIMIT 1`,
        { organizationId: req.auth.organizationId, sourceDocumentId: source.id },
      );
      if (existing[0]) return existing[0];

      const issueDate = currentDateBangkok();
      const documentNo = await nextAccountingDocumentNo(conn, req.auth.organizationId, 'credit_note', issueDate);
      const [createdDocument] = await conn.execute(
        `INSERT INTO accounting_documents (
          organization_id, document_type, document_no, document_status, payment_id, booking_id, audit_check_id, source_document_id,
          issue_date, subtotal_amount, discount_amount, vat_amount, withholding_tax_amount, total_amount,
          customer_name, organization_snapshot_json, customer_snapshot_json, line_items_json, issued_by_admin_id, cancel_reason
        ) VALUES (
          :organizationId, 'credit_note', :documentNo, 'issued', :paymentId, :bookingId, :auditCheckId, :sourceDocumentId,
          :issueDate, :subtotalAmount, :discountAmount, :vatAmount, :withholdingTaxAmount, :totalAmount,
          :customerName, :organizationSnapshotJson, :customerSnapshotJson, :lineItemsJson, :adminUserId, :reason
        )`,
        {
          organizationId: req.auth.organizationId,
          documentNo,
          paymentId: source.payment_id,
          bookingId: source.booking_id,
          auditCheckId: source.audit_check_id,
          sourceDocumentId: source.id,
          issueDate,
          subtotalAmount: source.subtotal_amount,
          discountAmount: source.discount_amount,
          vatAmount: source.vat_amount,
          withholdingTaxAmount: source.withholding_tax_amount,
          totalAmount: source.total_amount,
          customerName: source.customer_name,
          organizationSnapshotJson: toJson(normalizeJsonValue(source.organization_snapshot_json)),
          customerSnapshotJson: toJson(normalizeJsonValue(source.customer_snapshot_json)),
          lineItemsJson: toJson(normalizeJsonValue(source.line_items_json)),
          adminUserId: req.auth.sub,
          reason: req.validated.body.reason,
        },
      );
      const [creditNotes] = await conn.execute(`SELECT * FROM accounting_documents WHERE id = :id LIMIT 1`, { id: createdDocument.insertId });
      return creditNotes[0];
    });
    return created(res, result, 'credit note issued');
  }),
);

router.get(
  '/admins',
  requireRoles(ROLES.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT au.id, au.role, au.name_enc, au.email_enc, au.phone_enc, au.status, au.created_at,
              GROUP_CONCAT(DISTINCT m.name ORDER BY m.name SEPARATOR ', ') AS assigned_markets,
              GROUP_CONCAT(DISTINCT ama.market_id ORDER BY ama.market_id SEPARATOR ',') AS assigned_market_ids
       FROM admin_users au
       LEFT JOIN admin_market_assignments ama
         ON ama.admin_user_id = au.id AND ama.organization_id = au.organization_id AND ama.status = 'active'
       LEFT JOIN markets m
         ON m.id = ama.market_id
       WHERE au.organization_id = :organizationId
       GROUP BY au.id, au.role, au.name_enc, au.email_enc, au.phone_enc, au.status, au.created_at
       ORDER BY au.id ASC`,
      { organizationId: req.auth.organizationId },
    );
    return ok(
      res,
      rows.map((row) => ({
        id: row.id,
        role: row.role,
        name: decryptField(row.name_enc),
        email: decryptField(row.email_enc),
        phone: decryptField(row.phone_enc),
        assigned_markets: row.assigned_markets || '',
        assigned_market_ids: row.assigned_market_ids ? row.assigned_market_ids.split(',').map((value) => Number(value)).filter(Boolean) : [],
        status: row.status,
        created_at: row.created_at,
      })),
    );
  }),
);

router.post(
  '/admins',
  requireRoles(ROLES.SUPERVISOR),
  validate(
    z.object({
      body: z.object({
        username: z.string().min(3),
        password: z.string().min(10).refine(assertPasswordPolicy, PASSWORD_POLICY_MESSAGE),
        role: z.enum([ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.AUDIT]),
        name: z.string().min(1),
        email: z.string().email().optional().or(z.literal('')).default(''),
        phone: z.string().optional().default(''),
        marketIds: z.array(z.coerce.number().int().positive()).default([]),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    if (body.role !== ROLES.SUPERVISOR && body.marketIds.length === 0 && body.role !== ROLES.ACCOUNTING) {
      throw badRequest('At least one market assignment is required for this role');
    }
    await assertPlanQuota(req.auth.organizationId, 'admin_management', 1);

    const result = await query(
      `INSERT INTO admin_users (
        organization_id, username_hash, password_hash, role,
        name_enc, email_enc, email_hash, phone_enc, phone_hash, status
      ) VALUES (
        :organizationId, :usernameHash, :passwordHash, :role,
        :nameEnc, :emailEnc, :emailHash, :phoneEnc, :phoneHash, 'active'
      )`,
      {
        organizationId: req.auth.organizationId,
        usernameHash: blindIndex(body.username),
        passwordHash: await bcrypt.hash(body.password, 12),
        role: body.role,
        nameEnc: encryptField(body.name),
        emailEnc: encryptField(body.email),
        emailHash: blindIndex(body.email),
        phoneEnc: encryptField(body.phone),
        phoneHash: blindIndex(body.phone),
      },
    );

    for (const marketId of body.marketIds) {
      await query(
        `INSERT INTO admin_market_assignments (organization_id, admin_user_id, market_id, status)
         VALUES (:organizationId, :adminUserId, :marketId, 'active')`,
        { organizationId: req.auth.organizationId, adminUserId: result.insertId, marketId },
      );
    }

    return created(res, { id: result.insertId }, 'admin created');
  }),
);

router.patch(
  '/admins/:adminUserId',
  requireRoles(ROLES.SUPERVISOR),
  validate(
    z.object({
      body: z.object({
        password: z.string().min(10).refine(assertPasswordPolicy, PASSWORD_POLICY_MESSAGE).optional(),
        role: z.enum([ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING, ROLES.AUDIT]),
        name: z.string().min(1),
        email: z.string().email().optional().or(z.literal('')).default(''),
        phone: z.string().optional().default(''),
        marketIds: z.array(z.coerce.number().int().positive()).default([]),
        status: z.enum(['active', 'inactive']).default('active'),
      }),
      query: z.object({}).passthrough(),
      params: z.object({
        adminUserId: z.coerce.number().int().positive(),
      }),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    const { adminUserId } = req.validated.params;
    if (body.role !== ROLES.SUPERVISOR && body.marketIds.length === 0 && body.role !== ROLES.ACCOUNTING) {
      throw badRequest('At least one market assignment is required for this role');
    }

    const result = await transaction(async (conn) => {
      const [admins] = await conn.execute(
        `SELECT id
         FROM admin_users
         WHERE id = :adminUserId
           AND organization_id = :organizationId
         LIMIT 1
         FOR UPDATE`,
        { adminUserId, organizationId: req.auth.organizationId },
      );
      if (!admins.length) throw notFound('Admin not found');

      const updates = [
        'role = :role',
        'name_enc = :nameEnc',
        'email_enc = :emailEnc',
        'email_hash = :emailHash',
        'phone_enc = :phoneEnc',
        'phone_hash = :phoneHash',
        'status = :status',
      ];
      const params = {
        adminUserId,
        organizationId: req.auth.organizationId,
        role: body.role,
        nameEnc: encryptField(body.name),
        emailEnc: encryptField(body.email),
        emailHash: blindIndex(body.email),
        phoneEnc: encryptField(body.phone),
        phoneHash: blindIndex(body.phone),
        status: body.status,
      };
      if (body.password) {
        updates.push('password_hash = :passwordHash');
        params.passwordHash = await bcrypt.hash(body.password, 12);
      }

      await conn.execute(
        `UPDATE admin_users
         SET ${updates.join(', ')}
         WHERE id = :adminUserId
           AND organization_id = :organizationId`,
        params,
      );

      await conn.execute(
        `UPDATE admin_market_assignments
         SET status = 'inactive'
         WHERE organization_id = :organizationId
           AND admin_user_id = :adminUserId`,
        { organizationId: req.auth.organizationId, adminUserId },
      );

      for (const marketId of body.marketIds) {
        await conn.execute(
          `INSERT INTO admin_market_assignments (organization_id, admin_user_id, market_id, status)
           VALUES (:organizationId, :adminUserId, :marketId, 'active')
           ON DUPLICATE KEY UPDATE status = 'active'`,
          { organizationId: req.auth.organizationId, adminUserId, marketId },
        );
      }

      return { id: adminUserId };
    });

    return ok(res, result, 'admin updated');
  }),
);

module.exports = router;
