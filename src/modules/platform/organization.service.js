const { notFound, conflict } = require('../../utils/errors');

// Platform-only service. The route authenticates the platform actor before
// accepting the selected organization; never mount this on management/mobile.
function createOrganizationService({ query, transaction, decryptField, hashPassword, logger }) {
  function pagination(filters = {}) {
    const page = Number(filters.page || 1);
    const pageSize = Number(filters.pageSize || 20);
    return { page, pageSize, limit: pageSize, offset: (page - 1) * pageSize };
  }

  function pageResult(items, totalRow, paging) {
    const total = Number(totalRow?.total || 0);
    return { items, pagination: { page: paging.page, pageSize: paging.pageSize, total, totalPages: Math.max(1, Math.ceil(total / paging.pageSize)) } };
  }

  async function requireOrganization(organizationId) {
    const [org] = await query('SELECT id FROM organizations WHERE id = :organizationId LIMIT 1', { organizationId });
    if (!org) throw notFound('ไม่พบองค์กร');
  }

  async function requireMarket(organizationId, marketId) {
    const [market] = await query(
      `SELECT id, code, name, status FROM markets
       WHERE organization_id = :organizationId AND id = :marketId LIMIT 1`,
      { organizationId, marketId },
    );
    if (!market) throw notFound('ไม่พบตลาดในองค์กรนี้');
    return market;
  }

  async function listMarkets(organizationId, filters) {
    await requireOrganization(organizationId);
    const paging = pagination(filters);
    const params = { organizationId, limit: paging.limit, offset: paging.offset };
    const [[total], rows] = await Promise.all([
      query('SELECT COUNT(*) AS total FROM markets WHERE organization_id = :organizationId AND deleted_at IS NULL', params),
      query(`SELECT m.id, m.code, m.name, m.status,
        (SELECT COUNT(*) FROM floor_plans fp WHERE fp.organization_id = :organizationId AND fp.market_id = m.id) AS zone_count,
        (SELECT COUNT(*) FROM booths b WHERE b.organization_id = :organizationId AND b.market_id = m.id AND b.status <> 'deleted') AS booth_count
        FROM markets m WHERE m.organization_id = :organizationId AND m.deleted_at IS NULL ORDER BY m.id DESC LIMIT :limit OFFSET :offset`, params),
    ]);
    return pageResult(rows.map((r) => ({ id: r.id, code: r.code, name: r.name, status: r.status, zoneCount: Number(r.zone_count), boothCount: Number(r.booth_count) })), total, paging);
  }

  async function listZones(organizationId, marketId, filters) {
    const market = await requireMarket(organizationId, marketId);
    const paging = pagination(filters);
    const params = { organizationId, marketId, limit: paging.limit, offset: paging.offset };
    const [[total], rows] = await Promise.all([
      query('SELECT COUNT(*) AS total FROM floor_plans WHERE organization_id = :organizationId AND market_id = :marketId', params),
      query(`SELECT fp.id, fp.name, fp.status, fp.start_date, fp.end_date,
        (SELECT COUNT(*) FROM booths b WHERE b.organization_id = :organizationId AND b.market_id = :marketId AND b.floor_plan_id = fp.id AND b.status <> 'deleted') AS booth_count
        FROM floor_plans fp WHERE fp.organization_id = :organizationId AND fp.market_id = :marketId
        ORDER BY fp.id DESC LIMIT :limit OFFSET :offset`, params),
    ]);
    return { market, ...pageResult(rows.map((r) => ({ id: r.id, name: r.name, status: r.status, startDate: r.start_date, endDate: r.end_date, boothCount: Number(r.booth_count) })), total, paging) };
  }

  async function listBooths(organizationId, marketId, filters) {
    const market = await requireMarket(organizationId, marketId);
    const paging = pagination(filters);
    const params = { organizationId, marketId, limit: paging.limit, offset: paging.offset };
    let zoneClause = '';
    if (filters.zoneId) {
      const [zone] = await query(`SELECT id FROM floor_plans WHERE organization_id = :organizationId AND market_id = :marketId AND id = :zoneId`, { ...params, zoneId: filters.zoneId });
      if (!zone) throw notFound('ไม่พบโซนในตลาดนี้');
      params.zoneId = filters.zoneId;
      zoneClause = 'AND b.floor_plan_id = :zoneId';
    }
    const where = `b.organization_id = :organizationId AND b.market_id = :marketId AND b.status <> 'deleted' ${zoneClause}`;
    const [[total], rows] = await Promise.all([
      query(`SELECT COUNT(*) AS total FROM booths b WHERE ${where}`, params),
      query(`SELECT b.id, b.code, b.name, b.status, b.price, b.floor_plan_id, fp.name AS zone_name
        FROM booths b LEFT JOIN floor_plans fp ON fp.id = b.floor_plan_id AND fp.organization_id = :organizationId AND fp.market_id = :marketId
        WHERE ${where} ORDER BY b.sort_order, b.id LIMIT :limit OFFSET :offset`, params),
    ]);
    return { market, ...pageResult(rows.map((r) => ({ id: r.id, code: r.code, name: r.name, status: r.status, price: Number(r.price), zoneId: r.floor_plan_id, zoneName: r.zone_name || 'ไม่ระบุโซน' })), total, paging) };
  }

  async function listUsers(organizationId, filters) {
    await requireOrganization(organizationId);
    const paging = pagination(filters);
    const params = { organizationId, limit: paging.limit, offset: paging.offset };
    const [[total], rows] = await Promise.all([
      query('SELECT COUNT(*) AS total FROM admin_users WHERE organization_id = :organizationId', params),
      query(`SELECT id, role, status, name_enc, email_enc, last_login_at FROM admin_users
        WHERE organization_id = :organizationId ORDER BY id DESC LIMIT :limit OFFSET :offset`, params),
    ]);
    return pageResult(rows.map((r) => ({ id: r.id, role: r.role, status: r.status, name: decryptField(r.name_enc) || '', email: decryptField(r.email_enc) || '', lastLoginAt: r.last_login_at })), total, paging);
  }

  async function updateUser(organizationId, userId, body, platformUserId) {
    // Hash outside the transaction; passwords are never returned or logged.
    const passwordHash = body.password ? await hashPassword(body.password) : null;
    const result = await transaction(async (connection) => {
      // Serialize changes within an organization, including simultaneous attempts
      // to disable its final two supervisors.
      const [orgs] = await connection.execute('SELECT id FROM organizations WHERE id = :organizationId FOR UPDATE', { organizationId });
      if (!orgs.length) throw notFound('ไม่พบองค์กร');
      const [users] = await connection.execute(`SELECT id, role, status FROM admin_users
        WHERE organization_id = :organizationId AND id = :userId FOR UPDATE`, { organizationId, userId });
      const user = users[0];
      if (!user) throw notFound('ไม่พบผู้ใช้งานในองค์กรนี้');
      if (body.status === 'inactive' && user.role === 'supervisor' && user.status === 'active') {
        const [supervisors] = await connection.execute(`SELECT id FROM admin_users
          WHERE organization_id = :organizationId AND role = 'supervisor' AND status = 'active' FOR UPDATE`, { organizationId });
        if (supervisors.length <= 1) throw conflict('ไม่สามารถปิดผู้ควบคุมองค์กรที่เปิดใช้งานคนสุดท้ายได้');
      }
      if (passwordHash) {
        await connection.execute(`UPDATE admin_users SET password_hash = :passwordHash
          WHERE organization_id = :organizationId AND id = :userId`, { organizationId, userId, passwordHash });
      } else {
        await connection.execute(`UPDATE admin_users SET status = :status
          WHERE organization_id = :organizationId AND id = :userId`, { organizationId, userId, status: body.status });
      }
      return { id: userId, organizationId, status: body.status || user.status, passwordReset: Boolean(passwordHash), existingSessionsRevoked: false };
    });
    logger.info({ organizationId, userId, platformUserId, action: passwordHash ? 'organization.user.password_reset' : 'organization.user.status', status: result.status }, 'Platform organization user updated');
    return result;
  }

  async function listBookings(organizationId, filters) {
    await requireOrganization(organizationId);
    if (filters.marketId) await requireMarket(organizationId, filters.marketId);
    const paging = pagination(filters);
    const params = { organizationId, limit: paging.limit, offset: paging.offset };
    const clauses = ['b.organization_id = :organizationId'];
    if (filters.marketId) { params.marketId = filters.marketId; clauses.push('b.market_id = :marketId'); }
    const dateClauses = [];
    if (filters.dateFrom) { params.dateFrom = filters.dateFrom; dateClauses.push('bi.booking_date >= :dateFrom'); }
    if (filters.dateTo) { params.dateTo = filters.dateTo; dateClauses.push('bi.booking_date <= :dateTo'); }
    if (dateClauses.length) clauses.push(`EXISTS (SELECT 1 FROM booking_items bi WHERE bi.organization_id = :organizationId AND bi.booking_id = b.id AND ${dateClauses.join(' AND ')})`);
    const where = clauses.join(' AND ');
    const [[total], rows] = await Promise.all([
      query(`SELECT COUNT(*) AS total FROM bookings b WHERE ${where}`, params),
      query(`SELECT b.id, b.public_id, b.status, b.created_at, b.total_amount, b.market_id, m.name AS market_name,
        u.first_name_enc, u.last_name_enc,
        (SELECT MIN(bi.booking_date) FROM booking_items bi WHERE bi.organization_id = :organizationId AND bi.booking_id = b.id) AS date_from,
        (SELECT MAX(bi.booking_date) FROM booking_items bi WHERE bi.organization_id = :organizationId AND bi.booking_id = b.id) AS date_to
        FROM bookings b LEFT JOIN markets m ON m.id = b.market_id AND m.organization_id = :organizationId
        LEFT JOIN mobile_users u ON u.id = b.mobile_user_id AND u.organization_id = :organizationId
        WHERE ${where} ORDER BY b.created_at DESC, b.id DESC LIMIT :limit OFFSET :offset`, params),
    ]);
    return pageResult(rows.map((r) => ({ id: r.id, publicId: r.public_id, status: r.status, createdAt: r.created_at, totalAmount: Number(r.total_amount), marketId: r.market_id, marketName: r.market_name || '-', name: [decryptField(r.first_name_enc), decryptField(r.last_name_enc)].filter(Boolean).join(' '), dateFrom: r.date_from, dateTo: r.date_to })), total, paging);
  }

  return { listMarkets, listZones, listBooths, listUsers, updateUser, listBookings };
}

module.exports = { createOrganizationService };
