const express = require('express');
const { query } = require('../../config/db');
const { cacheResponse } = require('../../middlewares/response-cache');
const { asyncHandler } = require('../../utils/async-handler');
const { ok } = require('../../utils/api-response');

const router = express.Router();
router.use(cacheResponse({ namespace: 'locations', ttlSeconds: 24 * 60 * 60, maxEntries: 1000 }));

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

function parseId(value) {
  const id = Number(value);
  return Number.isInteger(id) && id > 0 ? id : null;
}

function parseLimit(value) {
  const limit = Number(value);
  if (!Number.isInteger(limit) || limit <= 0) return DEFAULT_LIMIT;
  return Math.min(limit, MAX_LIMIT);
}

function normalizeSearch(value) {
  const search = String(value || '').trim();
  return search ? `%${search}%` : '';
}

function mapGeography(row) {
  return {
    id: row.id,
    name: row.name,
  };
}

function mapProvince(row) {
  return {
    id: row.id,
    code: row.code,
    nameTh: row.name_th,
    nameEn: row.name_en,
    geographyId: row.geography_id,
    geographyName: row.geography_name,
  };
}

function mapAmphure(row) {
  return {
    id: row.id,
    code: row.code,
    nameTh: row.name_th,
    nameEn: row.name_en,
    provinceId: row.province_id,
    provinceNameTh: row.province_name_th,
    provinceNameEn: row.province_name_en,
  };
}

function mapDistrict(row) {
  return {
    id: row.id,
    zipCode: row.zip_code,
    nameTh: row.name_th,
    nameEn: row.name_en,
    amphureId: row.amphure_id,
    amphureNameTh: row.amphure_name_th,
    amphureNameEn: row.amphure_name_en,
    provinceId: row.province_id,
    provinceNameTh: row.province_name_th,
    provinceNameEn: row.province_name_en,
  };
}

router.get(
  '/geographies',
  asyncHandler(async (_req, res) => {
    const rows = await query(
      `SELECT id, name
       FROM master_geographies
       WHERE status = 'active'
       ORDER BY id ASC`,
    );

    return ok(res, rows.map(mapGeography));
  }),
);

router.get(
  '/provinces',
  asyncHandler(async (req, res) => {
    const geographyId = parseId(req.query.geographyId);
    const search = normalizeSearch(req.query.q);
    const limit = parseLimit(req.query.limit);
    const where = [`p.status = 'active'`];
    const params = {};

    if (geographyId) {
      where.push(`p.geography_id = :geographyId`);
      params.geographyId = geographyId;
    }
    if (search) {
      where.push(`(p.name_th LIKE :search OR p.name_en LIKE :search OR p.code LIKE :search)`);
      params.search = search;
    }

    const rows = await query(
      `SELECT p.id, p.code, p.name_th, p.name_en, p.geography_id, g.name AS geography_name
       FROM master_provinces p
       LEFT JOIN master_geographies g ON g.id = p.geography_id
       WHERE ${where.join(' AND ')}
       ORDER BY p.code ASC
       LIMIT ${limit}`,
      params,
    );

    return ok(res, rows.map(mapProvince));
  }),
);

router.get(
  '/amphures',
  asyncHandler(async (req, res) => {
    const provinceId = parseId(req.query.provinceId);
    const search = normalizeSearch(req.query.q);
    const limit = parseLimit(req.query.limit);
    const where = [`a.status = 'active'`];
    const params = {};

    if (provinceId) {
      where.push(`a.province_id = :provinceId`);
      params.provinceId = provinceId;
    }
    if (search) {
      where.push(`(a.name_th LIKE :search OR a.name_en LIKE :search OR a.code LIKE :search)`);
      params.search = search;
    }

    const rows = await query(
      `SELECT a.id, a.code, a.name_th, a.name_en, a.province_id,
              p.name_th AS province_name_th, p.name_en AS province_name_en
       FROM master_amphures a
       LEFT JOIN master_provinces p ON p.id = a.province_id
       WHERE ${where.join(' AND ')}
       ORDER BY a.code ASC
       LIMIT ${limit}`,
      params,
    );

    return ok(res, rows.map(mapAmphure));
  }),
);

async function listDistricts(req, res) {
  const amphureId = parseId(req.query.amphureId);
  const provinceId = parseId(req.query.provinceId);
  const search = normalizeSearch(req.query.q);
  const zipCode = String(req.query.zipCode || '').trim();
  const limit = parseLimit(req.query.limit);
  const where = [`d.status = 'active'`];
  const params = {};

  if (amphureId) {
    where.push(`d.amphure_id = :amphureId`);
    params.amphureId = amphureId;
  }
  if (provinceId) {
    where.push(`a.province_id = :provinceId`);
    params.provinceId = provinceId;
  }
  if (zipCode) {
    where.push(`d.zip_code = :zipCode`);
    params.zipCode = zipCode;
  }
  if (search) {
    where.push(`(d.name_th LIKE :search OR d.name_en LIKE :search OR d.zip_code LIKE :search)`);
    params.search = search;
  }

  const rows = await query(
    `SELECT d.id, d.zip_code, d.name_th, d.name_en, d.amphure_id,
            a.name_th AS amphure_name_th, a.name_en AS amphure_name_en,
            p.id AS province_id, p.name_th AS province_name_th, p.name_en AS province_name_en
     FROM master_districts d
     LEFT JOIN master_amphures a ON a.id = d.amphure_id
     LEFT JOIN master_provinces p ON p.id = a.province_id
     WHERE ${where.join(' AND ')}
     ORDER BY p.code ASC, a.code ASC, d.name_th ASC
     LIMIT ${limit}`,
    params,
  );

  return ok(res, rows.map(mapDistrict));
}

router.get('/districts', asyncHandler(listDistricts));
router.get('/subdistricts', asyncHandler(listDistricts));

router.get(
  '/address/:districtId',
  asyncHandler(async (req, res) => {
    const districtId = parseId(req.params.districtId);
    if (!districtId) return ok(res, null);

    const rows = await query(
      `SELECT d.id, d.zip_code, d.name_th, d.name_en, d.amphure_id,
              a.name_th AS amphure_name_th, a.name_en AS amphure_name_en,
              p.id AS province_id, p.name_th AS province_name_th, p.name_en AS province_name_en
       FROM master_districts d
       LEFT JOIN master_amphures a ON a.id = d.amphure_id
       LEFT JOIN master_provinces p ON p.id = a.province_id
       WHERE d.id = :districtId
         AND d.status = 'active'
       LIMIT 1`,
      { districtId },
    );

    return ok(res, rows[0] ? mapDistrict(rows[0]) : null);
  }),
);

module.exports = router;
