const NodeCache = require('node-cache');
const { logger } = require('../config/logger');

const DEFAULT_MAX_ENTRIES = 500;
const store = new NodeCache({ stdTTL: 60, checkperiod: 60, useClones: true });
let generation = 0;

function normalizeTtl(ttlSeconds) {
  const ttl = Number(ttlSeconds);
  return Number.isFinite(ttl) && ttl > 0 ? ttl : 60;
}

function enforceMaxEntries(maxEntries, namespace) {
  const keys = store.keys().filter((key) => store.get(key)?.namespace === namespace);
  if (keys.length > maxEntries) store.del(keys.slice(0, keys.length - maxEntries));
}

function buildDefaultKey(req, namespace) {
  return `${namespace}:${req.method}:${req.originalUrl}`;
}

function cacheResponse(options = {}) {
  const ttlSeconds = normalizeTtl(options.ttlSeconds);
  const namespace = options.namespace || 'default';
  const configuredMax = Number(options.maxEntries);
  const maxEntries = Number.isInteger(configuredMax) && configuredMax > 0 ? configuredMax : DEFAULT_MAX_ENTRIES;
  const keyBuilder = typeof options.key === 'function' ? options.key : (req) => buildDefaultKey(req, namespace);

  return function responseCacheMiddleware(req, res, next) {
    if (req.method !== 'GET') return next();
    // Only explicitly public master data may use a shared HTTP response cache.
    if (req.auth || req.headers?.authorization || req.headers?.cookie) return next();
    const requestGeneration = generation;

    const key = keyBuilder(req);
    const cached = store.get(key);
    if (cached) {
      res.setHeader('X-Cache', 'HIT');
      const remainingTtl = Math.max(0, Math.floor((store.getTtl(key) - Date.now()) / 1000));
      res.setHeader('Cache-Control', `public, max-age=${remainingTtl}`);
      return res.status(cached.statusCode).json(cached.body);
    }

    const originalJson = res.json.bind(res);
    res.json = (body) => {
      const statusCode = res.statusCode || 200;
      if (statusCode === 200 && requestGeneration === generation && !res.getHeader('Set-Cookie')
        && !/private|no-store/i.test(String(res.getHeader('Cache-Control') || ''))) {
        store.set(key, {
          statusCode,
          body,
          namespace,
        }, ttlSeconds);
        enforceMaxEntries(maxEntries, namespace);
        res.setHeader('X-Cache', 'MISS');
        res.setHeader('Cache-Control', `public, max-age=${Math.floor(ttlSeconds)}`);
      }
      return originalJson(body);
    };

    return next();
  };
}

function clearResponseCache(namespacePrefix = '') {
  generation += 1;
  let cleared = 0;
  for (const key of store.keys()) {
    const entry = store.get(key);
    if (entry && (!namespacePrefix || entry.namespace.startsWith(namespacePrefix) || key.startsWith(namespacePrefix))) {
      store.del(key);
      cleared += 1;
    }
  }
  if (cleared) logger.debug({ cleared, namespacePrefix }, 'Response cache cleared');
  return cleared;
}

function getResponseCacheStats() {
  const size = store.keys().filter((key) => store.has(key)).length;
  return { size };
}

module.exports = {
  cacheResponse,
  clearResponseCache,
  getResponseCacheStats,
};
