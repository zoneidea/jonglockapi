const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const multer = require('multer');
const { z } = require('zod');
const { query, transaction } = require('../../config/db');
const { authenticate } = require('../../middlewares/auth');
const { requireManagement, requireRoles, requireMarketAccess } = require('../../middlewares/rbac');
const { validate } = require('../../middlewares/validate');
const { ROLES, MENU_ACCESS } = require('../../constants/roles');
const { asyncHandler } = require('../../utils/async-handler');
const { ok, created } = require('../../utils/api-response');
const { badRequest, conflict, notFound } = require('../../utils/errors');
const { encryptField, blindIndex, decryptField } = require('../../utils/crypto');
const { publicId } = require('../../utils/id');
const { assertPasswordPolicy, PASSWORD_POLICY_MESSAGE } = require('../../utils/password-policy');
const authService = require('../auth/auth.service');

const router = express.Router();
const uploadRoot = path.join(__dirname, '..', '..', '..', 'uploads');
const allowedImageTypes = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
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

router.post(
  '/auth/login',
  validate(
    z.object({
      body: z.object({
        username: z.string().min(1),
        password: z.string().min(1),
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
      `SELECT id, code, name, address, email, phone, line_id, status, created_at, updated_at
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
  validate(
    z.object({
      body: z.object({
        name: z.string().min(1).max(255),
        address: z.string().optional().default(''),
        email: z.string().email().optional().or(z.literal('')).default(''),
        phone: z.string().optional().default(''),
        lineId: z.string().optional().default(''),
      }),
      query: z.object({}).passthrough(),
      params: z.object({}).passthrough(),
    }),
  ),
  asyncHandler(async (req, res) => {
    const body = req.validated.body;
    await query(
      `UPDATE organizations
       SET name = :name,
           address = :address,
           email = :email,
           phone = :phone,
           line_id = :lineId
       WHERE id = :organizationId`,
      {
        organizationId: req.auth.organizationId,
        name: body.name,
        address: body.address,
        email: body.email,
        phone: body.phone,
        lineId: body.lineId,
      },
    );
    return ok(
      res,
      {
        id: req.auth.organizationId,
        name: body.name,
        address: body.address,
        email: body.email,
        phone: body.phone,
        line_id: body.lineId,
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
      `SELECT ai.id, ai.market_id, ai.type, ai.title, ai.description, ai.image_url, ai.start_date, ai.end_date, ai.status, ai.created_at,
              (
                SELECT COUNT(*)
                FROM announcement_item_images aii
                WHERE aii.announcement_item_id = ai.id
                  AND aii.organization_id = ai.organization_id
                  AND aii.status = 'active'
              ) AS image_count
       FROM announcement_items
       ai
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
      `SELECT id, market_id, type, title, description, image_url, start_date, end_date, status, created_at, updated_at
       FROM announcement_items
       WHERE id = :announcementId AND organization_id = :organizationId
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
    const bannerImage = req.files?.image?.[0] || null;
    const galleryImages = req.files?.images || [];
    const createdImageUrls = galleryImages.map((file) => publicUploadUrl(req, file.path));
    const imageUrl = bannerImage
      ? publicUploadUrl(req, bannerImage.path)
      : createdImageUrls[0] || null;
    const result = await query(
      `INSERT INTO announcement_items (
        organization_id, market_id, type, title, description, image_url, start_date, end_date, status, created_by_admin_id
      ) VALUES (
        :organizationId, :marketId, :type, :title, :description, :imageUrl, :startDate, :endDate, :status, :createdByAdminId
      )`,
      {
        organizationId: req.auth.organizationId,
        marketId: body.marketId || null,
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
      `SELECT image_url, type
       FROM announcement_items
       WHERE id = :announcementId AND organization_id = :organizationId
       LIMIT 1`,
      { organizationId: req.auth.organizationId, announcementId: parsed.params.announcementId },
    );
    const current = rows[0];
    if (!current) throw notFound('Announcement not found');
    const bannerImage = req.files?.image?.[0] || null;
    const galleryImages = req.files?.images || [];
    const imageUrl = bannerImage ? publicUploadUrl(req, bannerImage.path) : current.image_url;
    await query(
      `UPDATE announcement_items
       SET title = :title,
           description = :description,
           image_url = :imageUrl,
           start_date = :startDate,
           end_date = :endDate,
           status = :status
       WHERE id = :announcementId AND organization_id = :organizationId`,
      {
        organizationId: req.auth.organizationId,
        announcementId: parsed.params.announcementId,
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
        password: z.string().min(10).refine(assertPasswordPolicy, PASSWORD_POLICY_MESSAGE).default('Vendor@123456'),
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
              m.status, m.open_date, m.close_date
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
    return ok(res, rows);
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
    await query(
      `UPDATE markets
       SET name = COALESCE(:name, name),
           description = :description,
           main_image_url = :mainImageUrl,
           address = :address,
           opening_hours = :openingHours,
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
        phone: body.phone,
        lineId: body.lineId,
        email: body.email,
        terms: body.terms,
      },
    );
    if (req.file && current.main_image_url !== mainImageUrl) removeUploadedFile(current.main_image_url);
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
      `SELECT id, name, plan_image_url, start_date, end_date, status
       FROM floor_plans
       WHERE organization_id = :organizationId AND market_id = :marketId
       ORDER BY start_date DESC, id DESC`,
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
          status: z.enum(['active', 'inactive']).default('active'),
        }),
      })
      .parse({ params: req.params, body: req.body });
    const body = parsed.body;
    const planImageUrl = req.file ? publicUploadUrl(req, req.file.path) : null;
    const result = await query(
      `INSERT INTO floor_plans (organization_id, market_id, name, plan_image_url, start_date, end_date, status)
       VALUES (:organizationId, :marketId, :name, :planImageUrl, :startDate, :endDate, :status)`,
      { organizationId: req.auth.organizationId, marketId: parsed.params.marketId, planImageUrl, ...body },
    );
    return created(res, { id: result.insertId, planImageUrl }, 'booth type created');
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
          openDate: z.string().optional().nullable(),
          closeDate: z.string().optional().nullable(),
        }),
      })
      .parse({ body: req.body });
    const body = parsed.body;
    const code = String(body.code || '').trim() || await buildNextMarketCode(req.auth.organizationId);
    const mainImageUrl = req.file ? publicUploadUrl(req, req.file.path) : null;
    const result = await query(
      `INSERT INTO markets (organization_id, code, name, description, main_image_url, open_date, close_date, status)
       VALUES (:organizationId, :code, :name, :description, :mainImageUrl, :openDate, :closeDate, 'active')`,
      {
        organizationId: req.auth.organizationId,
        code,
        name: body.name,
        description: body.description,
        mainImageUrl,
        openDate: body.openDate || null,
        closeDate: body.closeDate || null,
      },
    );
    return created(res, { id: result.insertId, mainImageUrl }, 'market created');
  }),
);

router.get(
  '/markets/:marketId/bookings',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
  requireMarketAccess(),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT b.id, b.public_id, b.status, b.total_amount, b.source, b.created_at,
              COUNT(bi.id) AS item_count
       FROM bookings b
       LEFT JOIN booking_items bi ON bi.booking_id = b.id
       WHERE b.organization_id = :organizationId AND b.market_id = :marketId
       GROUP BY b.id
       ORDER BY b.created_at DESC
       LIMIT 500`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId) },
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
         SELECT bi.booth_id,
                MAX(CASE
                  WHEN bi.status = 'paid' OR bk.status = 'paid' THEN 2
                  WHEN bi.status IN ('pending_payment', 'payment_processing')
                    OR bk.status IN ('pending_payment', 'payment_processing') THEN 1
                  ELSE 0
                END) AS availability_rank,
                MAX(bk.public_id) AS booking_public_id
         FROM booking_items bi
         JOIN bookings bk ON bk.id = bi.booking_id
         WHERE bi.organization_id = :organizationId
           AND bk.organization_id = :organizationId
           AND bk.market_id = :marketId
           AND bi.booking_date = :bookingDate
           AND (:excludeBookingItemId IS NULL OR bi.id <> :excludeBookingItemId)
           AND bi.status IN ('pending_payment', 'payment_processing', 'paid')
           AND bk.status IN ('pending_payment', 'payment_processing', 'paid')
         GROUP BY bi.booth_id
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
    return ok(res, rows);
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

    const result = await transaction(async (conn) => {
      const [users] = await conn.execute(
        `SELECT id FROM mobile_users
         WHERE id = :mobileUserId AND organization_id = :organizationId AND status = 'active'
         LIMIT 1`,
        { mobileUserId, organizationId: req.auth.organizationId },
      );
      if (!users.length) throw notFound('Mobile user not found');

      let total = 0;
      for (const item of items) {
        const [booths] = await conn.execute(
          `SELECT id, price FROM booths
           WHERE id = :boothId AND market_id = :marketId AND organization_id = :organizationId AND status = 'active'
           LIMIT 1
           FOR UPDATE`,
          { boothId: item.boothId, marketId, organizationId: req.auth.organizationId },
        );
        if (!booths.length) throw badRequest(`Booth ${item.boothId} is not available`);

        const [locked] = await conn.execute(
          `SELECT bi.id
           FROM booking_items bi
           JOIN bookings b ON b.id = bi.booking_id
           WHERE bi.booth_id = :boothId
             AND bi.booking_date = :bookingDate
             AND bi.status IN ('pending_payment', 'paid', 'payment_processing')
             AND b.status IN ('pending_payment', 'paid', 'payment_processing')
           LIMIT 1
           FOR UPDATE`,
          { boothId: item.boothId, bookingDate: item.bookingDate },
        );
        if (locked.length) throw conflict(`Booth ${item.boothId} has already been booked on ${item.bookingDate}`);
        total += Number(booths[0].price);
      }

      const publicBookingId = publicId('BK');
      const [booking] = await conn.execute(
        `INSERT INTO bookings (
          organization_id, public_id, market_id, mobile_user_id, created_by_admin_id, source, status,
          subtotal_amount, total_amount, expires_at
        ) VALUES (
          :organizationId, :publicId, :marketId, :mobileUserId, :createdByAdminId, 'management', 'pending_payment',
          :subtotalAmount, :totalAmount, DATE_ADD(NOW(), INTERVAL 30 MINUTE)
        )`,
        {
          organizationId: req.auth.organizationId,
          publicId: publicBookingId,
          marketId,
          mobileUserId,
          createdByAdminId: req.auth.sub,
          subtotalAmount: total,
          totalAmount: total,
        },
      );

      for (const item of items) {
        const [booths] = await conn.execute(`SELECT price FROM booths WHERE id = :boothId`, { boothId: item.boothId });
        const [bookingItem] = await conn.execute(
          `INSERT INTO booking_items (organization_id, booking_id, booth_id, booking_date, unit_price, status)
           VALUES (:organizationId, :bookingId, :boothId, :bookingDate, :unitPrice, 'pending_payment')`,
          {
            organizationId: req.auth.organizationId,
            bookingId: booking.insertId,
            boothId: item.boothId,
            bookingDate: item.bookingDate,
            unitPrice: booths[0].price,
          },
        );

        for (const productId of item.productIds) {
          await conn.execute(
            `INSERT INTO booking_products (organization_id, booking_item_id, product_id)
             VALUES (:organizationId, :bookingItemId, :productId)`,
            { organizationId: req.auth.organizationId, bookingItemId: bookingItem.insertId, productId },
          );
        }
      }

      return { id: booking.insertId, publicId: publicBookingId, totalAmount: total, paymentRequiredInMobile: true };
    });

    return created(res, result, 'management booking created');
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
         AND b.status IN ('pending_payment', 'payment_processing', 'paid')
         AND bi.status IN ('pending_payment', 'payment_processing', 'paid')
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
      const [items] = await conn.execute(
        `SELECT bi.id, bi.booking_id, bi.booth_id, bi.booking_date, bi.unit_price, bi.status, b.status AS booking_status
         FROM booking_items bi
         JOIN bookings b ON b.id = bi.booking_id
         WHERE bi.id = :bookingItemId
           AND bi.organization_id = :organizationId
           AND b.organization_id = :organizationId
           AND b.market_id = :marketId
           AND b.status IN ('pending_payment', 'payment_processing', 'paid')
           AND bi.status IN ('pending_payment', 'payment_processing', 'paid')
         LIMIT 1
         FOR UPDATE`,
        { organizationId: req.auth.organizationId, marketId, bookingItemId },
      );
      const item = items[0];
      if (!item) throw notFound('Booking item not found');

      const [booths] = await conn.execute(
        `SELECT id, price
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

      const [locked] = await conn.execute(
        `SELECT bi.id
         FROM booking_items bi
         JOIN bookings b ON b.id = bi.booking_id
         WHERE bi.booth_id = :boothId
           AND bi.booking_date = :bookingDate
           AND bi.id <> :bookingItemId
           AND bi.status IN ('pending_payment', 'paid', 'payment_processing')
           AND b.status IN ('pending_payment', 'paid', 'payment_processing')
         LIMIT 1
         FOR UPDATE`,
        { boothId, bookingDate, bookingItemId },
      );
      if (locked.length) throw conflict(`Booth ${boothId} has already been booked on ${bookingDate}`);

      await conn.execute(
        `UPDATE booking_items
         SET booth_id = :boothId,
             booking_date = :bookingDate,
             unit_price = :unitPrice
         WHERE id = :bookingItemId AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, bookingItemId, boothId, bookingDate, unitPrice: booth.price },
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
          newUnitPrice: booth.price,
          editedByAdminId: req.auth.sub,
        },
      );

      const [totals] = await conn.execute(
        `SELECT COALESCE(SUM(unit_price), 0) AS total_amount
         FROM booking_items
         WHERE booking_id = :bookingId
           AND organization_id = :organizationId
           AND status IN ('pending_payment', 'payment_processing', 'paid')`,
        { organizationId: req.auth.organizationId, bookingId: item.booking_id },
      );
      const totalAmount = Number(totals[0]?.total_amount || 0);
      await conn.execute(
        `UPDATE bookings
         SET subtotal_amount = :totalAmount,
             total_amount = GREATEST(:totalAmount - discount_amount, 0)
         WHERE id = :bookingId AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, bookingId: item.booking_id, totalAmount },
      );

      return { id: bookingItemId, bookingId: item.booking_id, totalAmount };
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
    const { marketId, bookingId } = req.validated.params;
    const result = await transaction(async (conn) => {
      const [bookings] = await conn.execute(
        `SELECT id
         FROM bookings
         WHERE id = :bookingId
           AND organization_id = :organizationId
           AND market_id = :marketId
         LIMIT 1
         FOR UPDATE`,
        { organizationId: req.auth.organizationId, marketId, bookingId },
      );
      if (!bookings[0]) throw notFound('Booking not found');
      await conn.execute(
        `UPDATE bookings
         SET status = 'cancelled',
             comment = :comment
         WHERE id = :bookingId AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, bookingId, comment: req.validated.body.comment },
      );
      await conn.execute(
        `UPDATE booking_items
         SET status = 'cancelled'
         WHERE booking_id = :bookingId AND organization_id = :organizationId`,
        { organizationId: req.auth.organizationId, bookingId },
      );
      return { id: bookingId };
    });
    return ok(res, result, 'booking cancelled');
  }),
);

router.get(
  '/mobile-users',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN),
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
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT ac.id, ac.booking_item_id, ac.result, ac.total_fine_amount, ac.fine_payment_status,
              ac.checked_at, b.public_id AS booking_public_id, bo.name AS booth_name, bi.booking_date
       FROM audit_checks ac
       JOIN booking_items bi ON bi.id = ac.booking_item_id
       JOIN bookings b ON b.id = bi.booking_id
       JOIN booths bo ON bo.id = bi.booth_id
       WHERE ac.organization_id = :organizationId AND ac.market_id = :marketId
       ORDER BY ac.checked_at DESC
       LIMIT 500`,
      { organizationId: req.auth.organizationId, marketId: Number(req.params.marketId) },
    );
    return ok(res, rows);
  }),
);

router.get(
  '/reports/bookings',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT m.id AS market_id, m.name AS market_name, b.status,
              COUNT(*) AS booking_count, COALESCE(SUM(b.total_amount), 0) AS total_amount
       FROM bookings b
       JOIN markets m ON m.id = b.market_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = m.id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE b.organization_id = :organizationId
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
         AND (:startDate IS NULL OR DATE(b.created_at) >= :startDate)
         AND (:endDate IS NULL OR DATE(b.created_at) <= :endDate)
       GROUP BY m.id, m.name, b.status
       ORDER BY m.name, b.status`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
        startDate: req.query.startDate || null,
        endDate: req.query.endDate || null,
      },
    );
    return ok(res, rows);
  }),
);

router.get(
  '/accounting/payments',
  requireRoles(ROLES.SUPERVISOR, ROLES.ADMIN, ROLES.ACCOUNTING),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT p.id, p.public_id, p.provider, p.status, p.amount, p.paid_at, p.created_at, b.public_id AS booking_public_id
       FROM payments p
       LEFT JOIN bookings b ON b.id = p.booking_id
       LEFT JOIN admin_market_assignments ama
         ON ama.market_id = b.market_id AND ama.admin_user_id = :adminUserId AND ama.status = 'active'
       WHERE p.organization_id = :organizationId
         AND (:hasGlobalMarketAccess = 1 OR ama.id IS NOT NULL)
       ORDER BY p.created_at DESC
       LIMIT 500`,
      {
        organizationId: req.auth.organizationId,
        adminUserId: req.auth.sub,
        hasGlobalMarketAccess: [ROLES.SUPERVISOR, ROLES.ACCOUNTING].includes(req.auth.role) ? 1 : 0,
      },
    );
    return ok(res, rows);
  }),
);

router.get(
  '/admins',
  requireRoles(ROLES.SUPERVISOR),
  asyncHandler(async (req, res) => {
    const rows = await query(
      `SELECT au.id, au.role, au.name_enc, au.email_enc, au.phone_enc, au.status, au.created_at,
              GROUP_CONCAT(DISTINCT m.name ORDER BY m.name SEPARATOR ', ') AS assigned_markets
       FROM admin_users au
       LEFT JOIN admin_market_assignments ama
         ON ama.admin_user_id = au.id AND ama.organization_id = au.organization_id AND ama.status = 'active'
       LEFT JOIN markets m
         ON m.id = ama.market_id
       WHERE au.organization_id = :organizationId
       GROUP BY au.id, au.role, au.name_enc, au.email_enc, au.phone_enc, au.status, au.created_at
       ORDER BY au.created_at DESC`,
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

module.exports = router;
