const { query } = require('../config/db');
const { logger } = require('../config/logger');

const MUTATING_METHODS = new Set(['POST', 'PUT', 'PATCH', 'DELETE']);
const REDACTED = '[REDACTED]';
const SENSITIVE_KEYS = new Set([
  'authorization',
  'cookie',
  'password',
  'passwordhash',
  'password_hash',
  'token',
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

function inferChannel(pathname) {
  if (pathname.includes('/management')) return 'management';
  if (pathname.includes('/mobile/audit')) return 'audit';
  if (pathname.includes('/mobile/payments')) return 'payment';
  if (pathname.includes('/mobile')) return 'mobile';
  return 'unknown';
}

function inferActorType(req, channel, responseBody) {
  if (req.auth?.userType === 'admin') return 'management';
  if (req.auth?.userType === 'management') return 'management';
  if (req.auth?.userType === 'customer') return 'mobile';
  if (req.auth?.role === 'audit') return 'audit';
  if (responseBody?.data?.user && channel === 'management') return 'management';
  if (responseBody?.data?.user && channel === 'mobile') return 'mobile';
  if (responseBody?.data?.user && channel === 'audit') return 'audit';
  if (channel === 'payment') return 'payment';
  return 'anonymous';
}

function inferAction(req) {
  const path = req.originalUrl || req.path || '';
  if (/\/auth\/login\b/.test(path)) return 'login';
  if (/\/auth\/register\b/.test(path)) return 'register';
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
  const ignored = new Set(['api', 'management', 'mobile', 'audit', 'payments', 'auth']);
  const candidates = segments.filter((segment) => !ignored.has(segment) && !/^\d+$/.test(segment));
  if (!candidates.length) return null;

  if (candidates.includes('booking-items')) return 'booking_items';
  if (candidates.includes('booth-availability')) return 'booth_availability';
  return segmentToEntity(candidates[candidates.length - 1]) || null;
}

function inferEntityId(req, responseBody) {
  const data = responseBody?.data;
  return (
    data?.id ||
    data?.publicId ||
    data?.public_id ||
    req.params?.id ||
    req.params?.bookingId ||
    req.params?.bookingItemId ||
    req.params?.boothId ||
    req.params?.marketId ||
    null
  );
}

function inferOrganizationId(req, responseBody) {
  return (
    req.auth?.organizationId ||
    req.body?.organizationId ||
    req.query?.organizationId ||
    responseBody?.data?.organizationId ||
    responseBody?.data?.user?.organizationId ||
    null
  );
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

      query(
        `INSERT INTO event_logs (
          organization_id, actor_type, actor_id, actor_role, channel, action, entity_type, entity_id,
          method, path, route_path, status_code, success, ip_address, user_agent, request_json, response_json
        ) VALUES (
          :organizationId, :actorType, :actorId, :actorRole, :channel, :action, :entityType, :entityId,
          :method, :path, :routePath, :statusCode, :success, :ipAddress, :userAgent, :requestJson, :responseJson
        )`,
        event,
      ).catch((error) => {
        logger.error({ error, path: req.originalUrl }, 'Event log write failed');
      });
    });

    return next();
  };
}

module.exports = { eventLogger, sanitize };
