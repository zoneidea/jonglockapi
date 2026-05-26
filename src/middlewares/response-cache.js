const { logger } = require('../config/logger');

const DEFAULT_MAX_ENTRIES = 500;
const store = new Map();

function normalizeTtl(ttlSeconds) {
  const ttl = Number(ttlSeconds);
  return Number.isFinite(ttl) && ttl > 0 ? ttl * 1000 : 60 * 1000;
}

function pruneExpired(now = Date.now()) {
  for (const [key, entry] of store.entries()) {
    if (entry.expiresAt <= now) store.delete(key);
  }
}

function enforceMaxEntries(maxEntries) {
  if (store.size <= maxEntries) return;
  const deleteCount = store.size - maxEntries;
  const keys = store.keys();
  for (let index = 0; index < deleteCount; index += 1) {
    const next = keys.next();
    if (next.done) break;
    store.delete(next.value);
  }
}

function buildDefaultKey(req, namespace) {
  return `${namespace}:${req.method}:${req.originalUrl}`;
}

function cacheResponse(options = {}) {
  const ttlMs = normalizeTtl(options.ttlSeconds);
  const namespace = options.namespace || 'default';
  const maxEntries = Number(options.maxEntries || DEFAULT_MAX_ENTRIES);
  const keyBuilder = typeof options.key === 'function' ? options.key : (req) => buildDefaultKey(req, namespace);

  return function responseCacheMiddleware(req, res, next) {
    if (req.method !== 'GET') return next();

    const now = Date.now();
    pruneExpired(now);

    const key = keyBuilder(req);
    const cached = store.get(key);
    if (cached && cached.expiresAt > now) {
      res.setHeader('X-Cache', 'HIT');
      res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttlMs / 1000)}`);
      return res.status(cached.statusCode).json(cached.body);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const statusCode = res.statusCode || 200;
      if (statusCode >= 200 && statusCode < 300 && !res.getHeader('Set-Cookie')) {
        store.set(key, {
          statusCode,
          body,
          expiresAt: Date.now() + ttlMs,
          namespace,
        });
        enforceMaxEntries(maxEntries);
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttlMs / 1000)}`);
      }
      return originalJson(body);
    };

    return next();
  };
}

function clearResponseCache(namespacePrefix = '') {
  let cleared = 0;
  for (const [key, entry] of store.entries()) {
    if (!namespacePrefix || entry.namespace.startsWith(namespacePrefix) || key.startsWith(namespacePrefix)) {
      store.delete(key);
      cleared += 1;
    }
  }
  if (cleared) logger.debug({ cleared, namespacePrefix }, 'Response cache cleared');
  return cleared;
}

function getResponseCacheStats() {
  pruneExpired();
  return { size: store.size };
}

module.exports = {
  cacheResponse,
  clearResponseCache,
  getResponseCacheStats,
};
