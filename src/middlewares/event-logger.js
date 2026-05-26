const { query } = require('../config/db');
const { logger } = require('../config/logger');
const { blindIndex } = require('../utils/crypto');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'passwordhash',
  'password_hash',
  'token',
  'firebaseidtoken',
  'accesstoken',
  'access_token',
  'refreshtoken',
  'refresh_token',
  'secret',
  'jwt',
  'phone',
  'phoneenc',
  'phone_enc',
  'email',
  'emailenc',
  'email_enc',
  'idcard',
  'id_card',
  'idcardenc',
  'id_card_enc',
  'address',
  'addressenc',
  'address_enc',
  'firstname',
  'first_name',
  'firstName',
  'lastname',
  'last_name',
  'lastName',
  'name',
]);

function normalizeKey(key) {
  return String(key || '').replace(/[^a-zA-Z0-9_]/g, '').toLowerCase();
}

function sanitize(value, depth = 0) {
  if (depth > 6) return '[MAX_DEPTH]';
  if (value == null) return value;
  if (Array.isArray(value)) return value.slice(0, 50).map((item) => sanitize(item, depth + 1));
  if (typeof value !== 'object') return value;

  const output = {};
  for (const [key, childValue] of Object.entries(value)) {
    const normalizedKey = normalizeKey(key);
    if (SENSITIVE_KEYS.has(normalizedKey)) {
      output[key] = REDACTED;
      continue;
    }
    output[key] = sanitize(childValue, depth + 1);
  }
  return output;
}

function safeJson(value) {
  if (value == null) return null;
  try {
    return JSON.stringify(sanitize(value));
  } catch (error) {
    return JSON.stringify({ error: 'unserializable' });
  }
}

function compactForLog(value, depth = 0) {
  if (depth > 5) return '[MAX_DEPTH]';
  if (value == null) return value;
  if (Array.isArray(value)) {
    return {
      type: 'array',
      length: value.length,
      sample: value.slice(0, 3).map((item) => compactForLog(item, depth + 1)),
    };
  }
  if (typeof value !== 'object') return value;

  const output = {};
  for (const [key, childValue] of Object.entries(value)) {
    output[key] = compactForLog(childValue, depth + 1);
  }
  return output;
}

function safeCompactJson(value) {
  return safeJson(compactForLog(value));
}

function inferChannel(pathname) {
  if (pathname.includes('/platform')) return 'platform';
  if (pathname.includes('/management')) return 'management';
  if (pathname.includes('/mobile/audit')) return 'audit';
  if (pathname.includes('/mobile/payments')) return 'payment';
  if (pathname.includes('/mobile')) return 'mobile';
  if (pathname.includes('/public')) return 'mobile';
  return 'unknown';
}

function inferActorType(req, channel, responseBody) {
  if (req.auth?.userType === 'platform') return 'platform';
  if (req.auth?.userType === 'admin') return 'management';
  if (req.auth?.userType === 'management') return 'management';
  if (req.auth?.userType === 'customer') return 'mobile';
  if (req.auth?.role === 'audit') return 'audit';
  if (responseBody?.data?.user && channel === 'management') return 'management';
  if (responseBody?.data?.user && channel === 'platform') return 'platform';
  if (responseBody?.data?.user && channel === 'mobile') return 'mobile';
  if (responseBody?.data?.user && channel === 'audit') return 'audit';
  if (channel === 'mobile' && (req.body?.user?.email || req.body?.email || responseBody?.data?.publicId)) return 'mobile';
  if (channel === 'payment') return 'payment';
  return 'anonymous';
}

function inferAction(req) {
  const path = req.originalUrl || req.path || '';
  if (/\/auth\/login\b/.test(path)) return 'login';
  if (/\/auth\/register\b/.test(path)) return 'register';
  if (/\/booths\/availability\b/.test(path)) return 'availability.check';
  if (/\/bookings\/cart\b/.test(path)) return 'cart.list';
  if (/\/bookings\/\d+\/summary\b/.test(path)) return 'booking.summary';
  if (/\/bookings\/\d+\/confirm\b/.test(path)) return 'booking.confirm';
  if (/\/bookings\/\d+\/payment-proof\b/.test(path)) return 'payment.proof.upload';
  if (/\/profile\/me\b/.test(path)) return 'profile.sync';
  if (/\/cancel\b/.test(path)) return 'cancel';
  if (/\/callbacks\//.test(path)) return 'callback';
  if (/\/transactions\b/.test(path)) return 'payment.create';

  const methodActions = {
    POST: 'create',
    PUT: 'update',
    PATCH: 'update',
    DELETE: 'delete',
  };
  return methodActions[req.method] || 'other';
}

function segmentToEntity(segment) {
  return String(segment || '')
    .replace(/^\d+$/, '')
    .replace(/-/g, '_')
    .replace(/[^a-zA-Z0-9_]/g, '');
}

function inferEntityType(req) {
  const path = (req.originalUrl || '').split('?')[0];
  const segments = path.split('/').filter(Boolean);
  const ignored = new Set(['api', 'platform', 'management', 'mobile', 'public', 'audit', 'payments', 'auth']);
  const candidates = segments.filter((segment) => !ignored.has(segment) && !/^\d+$/.test(segment));
  if (!candidates.length) return null;

  if (candidates.includes('booking-items')) return 'booking_items';
  if (candidates.includes('booth-availability')) return 'booth_availability';
  return segmentToEntity(candidates[candidates.length - 1]) || null;
}

function inferUniqueValueFromData(data, key) {
  if (Array.isArray(data)) {
    const values = Array.from(new Set(data.map((item) => item?.[key]).filter(Boolean)));
    return values.length === 1 ? values[0] : null;
  }
  return data?.[key] || null;
}

function inferEntityId(req, responseBody) {
  const data = responseBody?.data;
  return (
    data?.id ||
    data?.publicId ||
    data?.public_id ||
    data?.bookingId ||
    data?.payment?.id ||
    req.params?.id ||
    req.params?.bookingId ||
    req.params?.bookingItemId ||
    req.params?.boothId ||
    req.params?.marketId ||
    null
  );
}

function inferOrganizationId(req, responseBody) {
  const data = responseBody?.data;
  return (
    req.auth?.organizationId ||
    req.body?.organizationId ||
    req.query?.organizationId ||
    data?.organizationId ||
    data?.organization_id ||
    data?.user?.organizationId ||
    inferUniqueValueFromData(data, 'organizationId') ||
    inferUniqueValueFromData(data, 'organization_id') ||
    null
  );
}

function publicEmailFromRequest(req) {
  return String(req.body?.user?.email || req.body?.email || '').trim().toLowerCase();
}

async function findPublicProfileIdByEmail(email) {
  if (!email) return null;
  const rows = await query(
    `SELECT id
     FROM public_user_profiles
     WHERE email_hash = :emailHash
     LIMIT 1`,
    { emailHash: blindIndex(email) },
  );
  return rows[0]?.id || null;
}

async function findMobileUserIdByEmail(email, organizationId) {
  if (!email || !organizationId) return null;
  const rows = await query(
    `SELECT id
     FROM mobile_users
     WHERE organization_id = :organizationId
       AND email_hash = :emailHash
       AND status <> 'deleted'
     LIMIT 1`,
    { organizationId, emailHash: blindIndex(email) },
  );
  return rows[0]?.id || null;
}

async function resolveOrganizationFromRoute(req) {
  const floorPlanId = Number(req.params?.floorPlanId || 0);
  if (floorPlanId) {
    const rows = await query(
      `SELECT organization_id
       FROM floor_plans
       WHERE id = :floorPlanId
       LIMIT 1`,
      { floorPlanId },
    );
    if (rows[0]?.organization_id) return rows[0].organization_id;
  }

  const marketId = Number(req.params?.marketId || req.body?.marketId || req.query?.marketId || 0);
  if (marketId) {
    const rows = await query(
      `SELECT organization_id
       FROM markets
       WHERE id = :marketId
       LIMIT 1`,
      { marketId },
    );
    if (rows[0]?.organization_id) return rows[0].organization_id;
  }

  const boothId = Number(req.params?.boothId || req.body?.boothId || 0);
  if (boothId) {
    const rows = await query(
      `SELECT organization_id
       FROM booths
       WHERE id = :boothId
       LIMIT 1`,
      { boothId },
    );
    if (rows[0]?.organization_id) return rows[0].organization_id;
  }

  const bookingId = Number(req.params?.bookingId || req.body?.bookingId || 0);
  if (bookingId) {
    const rows = await query(
      `SELECT organization_id
       FROM bookings
       WHERE id = :bookingId
       LIMIT 1`,
      { bookingId },
    );
    if (rows[0]?.organization_id) return rows[0].organization_id;
  }

  return null;
}

async function enrichEvent(req, event, responseBody) {
  const enriched = { ...event };
  if (!enriched.organizationId) {
    enriched.organizationId = await resolveOrganizationFromRoute(req);
  }

  const email = publicEmailFromRequest(req);
  if (enriched.actorType === 'mobile' && !enriched.actorId) {
    enriched.actorId = await findMobileUserIdByEmail(email, enriched.organizationId)
      || await findPublicProfileIdByEmail(email);
  }

  if (!enriched.actorRole && enriched.actorType === 'mobile') {
    enriched.actorRole = 'customer';
  }

  if (!enriched.entityId && responseBody?.data?.bookingId) {
    enriched.entityId = responseBody.data.bookingId;
  }

  return enriched;
}

function routePath(req) {
  if (!req.route?.path) return null;
  const baseUrl = req.baseUrl || '';
  const route = Array.isArray(req.route.path) ? req.route.path.join('|') : req.route.path;
  return `${baseUrl}${route}`;
}

function eventLogger() {
  return (req, res, next) => {
    if (!MUTATING_METHODS.has(req.method)) return next();

    let responseBody = null;
    const originalJson = res.json.bind(res);
    res.json = (body) => {
      responseBody = body;
      return originalJson(body);
    };

    res.on('finish', () => {
      const channel = inferChannel(req.originalUrl || '');
      const actorType = inferActorType(req, channel, responseBody);
      const organizationId = inferOrganizationId(req, responseBody);
      const event = {
        organizationId: organizationId || null,
        actorType,
        actorId: req.auth?.sub || responseBody?.data?.user?.id || responseBody?.data?.id || null,
        actorRole: req.auth?.role || responseBody?.data?.user?.role || req.auth?.userType || null,
        channel,
        action: inferAction(req),
        entityType: inferEntityType(req),
        entityId: inferEntityId(req, responseBody),
        method: req.method,
        path: (req.originalUrl || req.path || '').slice(0, 500),
        routePath: routePath(req),
        statusCode: res.statusCode,
        success: res.statusCode < 400 ? 1 : 0,
        ipAddress: req.ip || null,
        userAgent: String(req.headers['user-agent'] || '').slice(0, 500) || null,
        requestJson: safeJson({
          params: req.params || {},
          query: req.query || {},
          body: req.body || {},
        }),
        responseJson: safeJson(responseBody),
      };

      event.responseJson = safeCompactJson(responseBody);

      enrichEvent(req, event, responseBody)
        .then((enrichedEvent) => query(
          `INSERT INTO event_logs (
            organization_id, actor_type, actor_id, actor_role, channel, action, entity_type, entity_id,
            method, path, route_path, status_code, success, ip_address, user_agent, request_json, response_json
          ) VALUES (
            :organizationId, :actorType, :actorId, :actorRole, :channel, :action, :entityType, :entityId,
            :method, :path, :routePath, :statusCode, :success, :ipAddress, :userAgent, :requestJson, :responseJson
          )`,
          enrichedEvent,
        ))
        .catch((error) => {
          logger.error({ error, path: req.originalUrl }, 'Event log write failed');
        });
    });

    return next();
  };
}

module.exports = { eventLogger, sanitize };
